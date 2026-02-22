// Screen Time Momentum - Sprint 1 basis
// Tracks visits, groups into sessions, and maintains an "activeSession" for the popup.

const INACTIVITY_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
const IGNORE_URL_PREFIXES = ["chrome://", "chrome-extension://", "edge://", "about:"];

// ---------- helpers ----------
function shouldIgnoreUrl(url) {
  if (!url) return true;
  return IGNORE_URL_PREFIXES.some((p) => url.startsWith(p));
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

  // time per domain (simple approximation: time until next visit)
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
    uniqueDomains,
    timePerDomain
  };
}

function groupIntoSessions(visits) {
  if (!visits.length) return [];

  const sorted = [...visits].sort((a, b) => a.time - b.time);

  const sessions = [];
  let current = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].time - sorted[i - 1].time;
    if (gap > INACTIVITY_THRESHOLD_MS) {
      sessions.push(current);
      current = [];
    }
    current.push(sorted[i]);
  }
  sessions.push(current);

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
  const { visits = [] } = await chrome.storage.local.get(["visits"]);
  const sessions = groupIntoSessions(visits);
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
    source // "tab-activated" | "nav-committed"
  };

  const data = await chrome.storage.local.get(["visits", "activeSession"]);
  const visits = data.visits || [];
  let active = data.activeSession || null;

  // Start a new active session if:
  // - none exists, OR
  // - last activity was more than threshold ago
  if (!active || (active.lastEventTime && now - active.lastEventTime > INACTIVITY_THRESHOLD_MS)) {
    active = {
      id: `${now}`,
      startTime: now,
      lastEventTime: now,
      uniqueDomains: [],
      visitCount: 0
    };
  }

  // Update active session
  active.lastEventTime = now;
  active.visitCount += 1;
  if (!active.uniqueDomains.includes(visit.domain)) {
    active.uniqueDomains.push(visit.domain);
  }

  // Persist
  visits.push(visit);
  await chrome.storage.local.set({ visits, activeSession: active });

  // Keep sessions updated for dashboard
  await rebuildSessions();
}

// ---------- listeners ----------

// Tab switching / activation
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url) await logVisit(tab.url, "tab-activated");
  } catch {
    // ignore
  }
});

// Navigation commits (captures link clicks, URL entry, reloads)
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return; // main frame only
  if (details.url) await logVisit(details.url, "nav-committed");
});

// Initialize storage if empty
chrome.runtime.onInstalled.addListener(async () => {
  const { visits, sessions, activeSession } = await chrome.storage.local.get([
    "visits",
    "sessions",
    "activeSession"
  ]);

  if (!visits) await chrome.storage.local.set({ visits: [] });
  if (!sessions) await chrome.storage.local.set({ sessions: [] });
  if (!activeSession) await chrome.storage.local.set({ activeSession: null });
});