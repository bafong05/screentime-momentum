// Tracks visits, groups into sessions, and maintains an "activeSession" for the popup.

const INACTIVITY_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

function shouldIgnoreUrl(url) {
  if (!url) return true;
  try {
    const u = new URL(url);
    const ignoredProtocols = ["chrome:", "chrome-extension:", "about:", "edge:", "brave:"];
    if (ignoredProtocols.includes(u.protocol)) return true;
    const ignoredHosts = ["newtab", "extensions"];
    if (ignoredHosts.includes(u.hostname)) return true;
    return false;
  } catch {
    return true;
  }
}

function toDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

function computeSessionMetrics(visits) {
  if (!visits.length) return null;
  const start = visits[0].time;
  const end = visits[visits.length - 1].time;
  const durationMs = Math.max(0, end - start);

  const domains = visits.map((v) => v.domain);
  const uniqueDomains = Array.from(new Set(domains));

  const timePerDomain = {};
  for (let i = 0; i < visits.length; i++) {
    const curr = visits[i];
    const next = visits[i + 1];
    const dt = next ? Math.max(0, next.time - curr.time) : 0;
    timePerDomain[curr.domain] = (timePerDomain[curr.domain] || 0) + dt;
  }

  return {
    start,
    end,
    durationMs,
    totalVisits: visits.length,
    totalSites: uniqueDomains.length,
    uniqueDomains,
    timePerDomain
  };
}

function groupIntoSessions(visits, manualStarts = []) {
  if (!visits.length) return [];

  const sorted = [...visits].sort((a, b) => a.time - b.time);

  const hasSessionIds = sorted.some((v) => v.sessionId != null);

  let sessions;

  if (hasSessionIds) {
    // Group primarily by explicit sessionId, falling back to a legacy bucket.
    const byId = new Map();
    for (const v of sorted) {
      const key = v.sessionId != null ? v.sessionId : "__legacy__";
      if (!byId.has(key)) byId.set(key, []);
      byId.get(key).push(v);
    }
    sessions = Array.from(byId.values()).sort((a, b) => a[0].time - b[0].time);
  } else {
    // Legacy behavior: split by inactivity threshold and any manual boundaries.
    const boundaries = Array.isArray(manualStarts)
      ? [...manualStarts].sort((a, b) => a - b)
      : [];
    let boundaryIdx = 0;

    sessions = [];
    let current = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      const gap = curr.time - prev.time;

      let shouldSplit = gap > INACTIVITY_THRESHOLD_MS;

      const boundary = boundaries[boundaryIdx];
      if (boundary != null && prev.time < boundary && curr.time >= boundary) {
        shouldSplit = true;
        boundaryIdx++;
      }

      if (shouldSplit) {
        sessions.push(current);
        current = [];
      }
      current.push(curr);
    }
    sessions.push(current);
  }

  return sessions.map((sessionVisits, idx) => {
    const metrics = computeSessionMetrics(sessionVisits);
    return {
      id: `${sessionVisits[0].time}-${idx}`,
      visits: sessionVisits,
      metrics
    };
  });
}

async function rebuildSessions() {
  const { visits = [], sessionIntents = [], manualSessionStarts = [] } = await chrome.storage.local.get([
    "visits",
    "sessionIntents",
    "manualSessionStarts"
  ]);

  const sessionsWithMetrics = groupIntoSessions(visits, manualSessionStarts).map((session) => {
    const metrics = session.metrics;
    if (!metrics) return session;

    const intent = sessionIntents.find((i) => i.startTime === metrics.start);
    if (!intent || intent.intendedMinutes == null) return session;

    const intendedMs = intent.intendedMinutes * 60 * 1000;
    const durationMs = metrics.durationMs || 0;
    const overrunMs = Math.max(0, durationMs - intendedMs);
    const overrunRatio = intendedMs > 0 ? overrunMs / intendedMs : null;

    return {
      ...session,
      metrics: {
        ...metrics,
        intendedMinutes: intent.intendedMinutes,
        intendedMs,
        overrunMs,
        overrunRatio
      }
    };
  });

  const sessions = sessionsWithMetrics;
  await chrome.storage.local.set({ sessions });
  return sessions;
}

async function logVisit(url, source) {
  if (shouldIgnoreUrl(url)) return;
  
  const now = Date.now();
  const visit = {
    url,
    domain: toDomain(url),
    time: now,
    source
  };

  const data = await chrome.storage.local.get(["visits", "activeSession"]);
  const visits = data.visits || [];
  let active = data.activeSession || null;

  // Start a new active session if: none exists OR last activity was more than threshold ago
  if (!active || (active.lastEventTime && now - active.lastEventTime > INACTIVITY_THRESHOLD_MS)) {
    active = {
      id: `${now}`,
      startTime: now,
      lastEventTime: now,
      uniqueDomains: [],
      visitCount: 0
    };
  }

  active.lastEventTime = now;
  active.visitCount += 1;
  if (!active.uniqueDomains.includes(visit.domain)) {
    active.uniqueDomains.push(visit.domain);
  }

  // Tag visit with the current session id so manual "New session" boundaries
  // create distinct sessions in the dashboard.
  if (active && active.id != null) {
    visit.sessionId = active.id;
  }

  visits.push(visit);
  await chrome.storage.local.set({ visits, activeSession: active });

  await rebuildSessions();
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url) await logVisit(tab.url, "tab-activated");
  } catch {
    // ignore
  }
});

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return; // main frame only
  if (details.url) await logVisit(details.url, "nav-committed");
});

chrome.runtime.onInstalled.addListener(async () => {
  const { visits, sessions, activeSession, sessionIntents, manualSessionStarts } =
    await chrome.storage.local.get([
      "visits",
      "sessions",
      "activeSession",
      "sessionIntents",
      "manualSessionStarts"
    ]);

  if (!visits) await chrome.storage.local.set({ visits: [] });
  if (!sessions) await chrome.storage.local.set({ sessions: [] });
  if (!activeSession) await chrome.storage.local.set({ activeSession: null });
  if (!sessionIntents) await chrome.storage.local.set({ sessionIntents: [] });
  if (!manualSessionStarts) await chrome.storage.local.set({ manualSessionStarts: [] });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "rebuildSessions") {
    rebuildSessions()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // async response
  }
  return undefined;
});