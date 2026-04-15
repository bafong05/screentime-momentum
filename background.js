const DEFAULT_INACTIVITY_THRESHOLD_MINUTES = 10;
let inactivityThresholdMs = DEFAULT_INACTIVITY_THRESHOLD_MINUTES * 60 * 1000;
let browserIdleState = "active";
let chromeAppFocused = true;

function normalizeInactivityThresholdMinutes(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return DEFAULT_INACTIVITY_THRESHOLD_MINUTES;
  return Math.min(120, Math.max(1, Math.round(minutes)));
}

function normalizeSessionName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  return name.slice(0, 80);
}

function getInactivityThresholdMs() {
  return inactivityThresholdMs;
}

function getIdleDetectionSeconds() {
  return Math.max(15, Math.round(getInactivityThresholdMs() / 1000));
}

async function loadInactivityThreshold() {
  const { inactivityThresholdMinutes } = await chrome.storage.local.get(["inactivityThresholdMinutes"]);
  const minutes = normalizeInactivityThresholdMinutes(inactivityThresholdMinutes);
  inactivityThresholdMs = minutes * 60 * 1000;
  return inactivityThresholdMs;
}

async function getNotificationPreferences() {
  const { notificationPreferences } = await chrome.storage.local.get(["notificationPreferences"]);
  return {
    endingSoon: notificationPreferences?.endingSoon !== false,
    overrun: notificationPreferences?.overrun !== false,
    missingGoal: notificationPreferences?.missingGoal !== false,
    noGoalHourly: notificationPreferences?.noGoalHourly !== false,
    sessionEnded: notificationPreferences?.sessionEnded !== false
  };
}

let videoPlaying = false;
let lastPromptedAutoSessionId = null;
let lastOverrunNotificationSessionId = null;
let lastGoalReminderSessionId = null;
let lastEndingSoonNotificationSessionId = null;
let lastSessionEndedNotificationSessionId = null;
let logVisitChain = Promise.resolve();
let autoIntentPromptChain = Promise.resolve();
let autoIntentPopupWindowId = null;
let autoIntentPopupTabId = null;
const SESSION_MONITOR_ALARM = "session-monitor";
const SESSION_OVERRUN_ALARM = "session-overrun-check";
const SESSION_GOAL_REMINDER_ALARM = "session-goal-reminder";
const SESSION_ENDING_SOON_ALARM = "session-ending-soon";
const NO_GOAL_REMINDER_DELAY_MS = 10 * 1000;
const DEFAULT_NO_GOAL_HOURLY_INTERVAL_HOURS = 1;
const NO_GOAL_INTERVAL_OPTIONS_HOURS = [0.25, 0.5, 1, 2];
const DEPLOYED_AI_ASSISTANT_BACKEND_URL = "https://screen-time-momentum-ai.onrender.com/analytics/ai";
const LOCAL_AI_ASSISTANT_BACKEND_URL = "http://127.0.0.1:8000/analytics/ai";
const REPEAT_VISIT_COLLAPSE_WINDOW_MS = 45 * 1000;

function getAiAssistantBackendUrl() {
  return DEPLOYED_AI_ASSISTANT_BACKEND_URL || LOCAL_AI_ASSISTANT_BACKEND_URL;
}

function isIdleStateInactive(state) {
  return state === "idle" || state === "locked";
}

function setIdleDetectionInterval() {
  try {
    chrome.idle.setDetectionInterval(getIdleDetectionSeconds());
  } catch {}
}

function normalizeNoGoalHourlyIntervalHours(value) {
  const hours = Number(value);
  if (!Number.isFinite(hours)) return DEFAULT_NO_GOAL_HOURLY_INTERVAL_HOURS;
  if (NO_GOAL_INTERVAL_OPTIONS_HOURS.includes(hours)) return hours;
  return DEFAULT_NO_GOAL_HOURLY_INTERVAL_HOURS;
}

async function getNoGoalHourlyIntervalHours() {
  const { noGoalHourlyIntervalHours } = await chrome.storage.local.get(["noGoalHourlyIntervalHours"]);
  return normalizeNoGoalHourlyIntervalHours(noGoalHourlyIntervalHours);
}

function formatNoGoalIntervalLabel(hours) {
  if (hours < 1) {
    const minutes = Math.round(hours * 60);
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

function queryIdleState(seconds = getIdleDetectionSeconds()) {
  return new Promise((resolve) => {
    try {
      chrome.idle.queryState(seconds, (state) => {
        if (chrome.runtime.lastError) {
          resolve("active");
          return;
        }
        resolve(state || "active");
      });
    } catch {
      resolve("active");
    }
  });
}

async function refreshIdleState() {
  setIdleDetectionInterval();
  browserIdleState = await queryIdleState();
  return browserIdleState;
}

async function rebuildSessionStore({
  visitsKey,
  sessionsKey,
  intentsKey
}) {
  const data = await chrome.storage.local.get([visitsKey, intentsKey]);
  const visits = data[visitsKey] || [];
  const sessionIntents = data[intentsKey] || [];

  const sessionsWithMetrics = groupIntoSessions(visits).map((session) => {
    const metrics = session.metrics;
    if (!metrics) return session;

    const sessionId = session.visits?.[0]?.sessionId;

    let intent = sessionIntents.find((i) => i.sessionId === sessionId);

    if (!intent) {
      intent = sessionIntents.find((i) => i.startTime === metrics.start);
    }

    if (!intent) return session;

    const sessionName = normalizeSessionName(intent.sessionName);
    if (intent.intendedMinutes == null) {
      return {
        ...session,
        metrics: {
          ...metrics,
          sessionName
        }
      };
    }

    const intendedMs = intent.intendedMinutes * 60 * 1000;
    const durationMs = metrics.durationMs || 0;
    const overrunMs = Math.max(0, durationMs - intendedMs);
    const overrunRatio = intendedMs > 0 ? overrunMs / intendedMs : null;

    return {
      ...session,
      metrics: {
        ...metrics,
        sessionName,
        intendedMinutes: intent.intendedMinutes,
        intendedMs,
        overrunMs,
        overrunRatio
      }
    };
  });

  await chrome.storage.local.set({ [sessionsKey]: sessionsWithMetrics });
  return sessionsWithMetrics;
}

async function markVisitInteraction(tabId, url, ts = Date.now()) {
  if (!tabId) return;

  const {
    visits = [],
    analyticsVisits = []
  } = await chrome.storage.local.get(["visits", "analyticsVisits"]);
  const nextVisits = Array.isArray(visits) ? visits.slice() : [];
  const nextAnalyticsVisits = Array.isArray(analyticsVisits) ? analyticsVisits.slice() : [];
  let changed = false;

  const markLatestMatchingVisit = (list) => {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const visit = list[i];
      if (visit?.tabId !== tabId) continue;
      if (url && visit?.url && visit.url !== url) continue;
      const nextVisit = {
        ...visit,
        hadInteraction: true,
        lastActiveTime: Math.max(Number(visit?.lastActiveTime || 0), ts)
      };

      if (!visit?.firstInteractionTime) {
        nextVisit.firstInteractionTime = ts;
      }

      const visitChanged =
        nextVisit.hadInteraction !== visit?.hadInteraction ||
        nextVisit.firstInteractionTime !== visit?.firstInteractionTime ||
        nextVisit.lastActiveTime !== visit?.lastActiveTime;

      if (!visitChanged) return false;

      list[i] = nextVisit;
      return true;
    }
    return false;
  };

  const dashboardChanged = markLatestMatchingVisit(nextVisits);
  const analyticsChanged = markLatestMatchingVisit(nextAnalyticsVisits);
  changed = dashboardChanged || analyticsChanged;
  if (!changed) return;

  await chrome.storage.local.set({
    visits: nextVisits,
    analyticsVisits: nextAnalyticsVisits
  });
  await rebuildSessions();
  await rebuildAnalyticsSessions();
}

async function setLastUserActivity(ts) {
  await chrome.storage.local.set({ lastUserActivityAt: ts });
}

function shouldIgnoreUrl(url) {
  if (!url) return true;

  try {
    const parsed = new URL(url);
    return [
      "data:",
      "blob:",
      "javascript:",
      "about:",
      "devtools:"
    ].includes(parsed.protocol);
  } catch {
    return true;
  }
}

function shouldIgnoreExtensionPage(url) {
  if (!url) return false;

  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "chrome-extension:" &&
      (
        parsed.pathname.endsWith("/dashboard.html") ||
        parsed.pathname.endsWith("/popup.html") ||
        parsed.pathname.endsWith("/intent.html")
      )
    );
  } catch {
    return false;
  }
}

async function findExistingAutoIntentPopup() {
  if (autoIntentPopupWindowId != null) {
    try {
      const existingWindow = await chrome.windows.get(autoIntentPopupWindowId, { populate: true });
      const existingTab = (existingWindow.tabs || []).find((tab) => {
        if (autoIntentPopupTabId != null && tab.id === autoIntentPopupTabId) return true;
        return Boolean(tab?.url && tab.url.startsWith(chrome.runtime.getURL("intent.html")));
      });
      if (existingTab?.id && existingWindow?.id != null) {
        autoIntentPopupWindowId = existingWindow.id;
        autoIntentPopupTabId = existingTab.id;
        return { windowId: existingWindow.id, tabId: existingTab.id };
      }
    } catch {
      autoIntentPopupWindowId = null;
      autoIntentPopupTabId = null;
    }
  }

  const popupBaseUrl = chrome.runtime.getURL("intent.html");
  try {
    const windows = await chrome.windows.getAll({ populate: true });
    for (const win of windows) {
      for (const tab of win.tabs || []) {
        if (!tab?.url) continue;
        if (tab.url.startsWith(popupBaseUrl)) {
          autoIntentPopupWindowId = win.id ?? null;
          autoIntentPopupTabId = tab.id ?? null;
          return { windowId: win.id, tabId: tab.id };
        }
      }
    }
  } catch {}
  autoIntentPopupWindowId = null;
  autoIntentPopupTabId = null;
  return null;
}

async function ensureSingleAutoIntentPopup(createPopup) {
  return autoIntentPromptChain = autoIntentPromptChain.then(async () => {
    const existing = await findExistingAutoIntentPopup();
    if (existing?.windowId) {
      try {
        await chrome.windows.update(existing.windowId, { focused: true });
      } catch {}
      return false;
    }

    const created = await createPopup();
    if (created?.id != null) {
      autoIntentPopupWindowId = created.id;
      autoIntentPopupTabId = created.tabs?.[0]?.id ?? null;
    }
    return true;
  }).catch(() => false);
}

function toDomain(url) {
  try {
    const parsed = new URL(url);

    if (
      (parsed.protocol === "chrome:" && parsed.pathname === "//newtab/") ||
      (parsed.protocol === "chrome-search:" && parsed.pathname.includes("local-ntp"))
    ) {
      return "new-tab-page";
    }

    const host = parsed.hostname.replace(/^www\./, "");
    if (host) return host;

    if (parsed.protocol === "file:") {
      const parts = decodeURIComponent(parsed.pathname).split("/").filter(Boolean);
      return parts[parts.length - 1] || "local file";
    }

    const path = parsed.pathname.replace(/^\/+|\/+$/g, "");
    return `${parsed.protocol}//${path || "page"}`;
  } catch {
    return "unknown";
  }
}

function computeSessionMetrics(visits) {
  if (!visits.length) return null;
  const start = visits[0].time;
  const lastVisit = visits[visits.length - 1];
  const end = Math.max(
    lastVisit.time,
    Number(lastVisit.lastActiveTime || lastVisit.firstInteractionTime || lastVisit.time)
  );
  const durationMs = Math.max(0, end - start);

  const domains = visits.map((v) => v.domain || toDomain(v.url));
  const uniqueDomains = Array.from(new Set(domains));

  const timePerDomain = {};
  for (let i = 0; i < visits.length; i++) {
    const curr = visits[i];
    const next = visits[i + 1];
    const currRecordedEnd = Math.max(
      curr.time,
      Number(curr.lastActiveTime || curr.firstInteractionTime || curr.time)
    );
    const dt = next
      ? Math.max(0, next.time - curr.time)
      : Math.max(0, currRecordedEnd - curr.time);
    const key = curr.domain || toDomain(curr.url);
    timePerDomain[key] = (timePerDomain[key] || 0) + dt;
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

function createBasicNotification(id, title, message) {
  return new Promise((resolve) => {
    chrome.notifications.create(id, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("notification-icon.png"),
      title,
      message,
      priority: 1
    }, (notificationId) => {
      const error = chrome.runtime.lastError?.message || "";
      resolve({
        ok: !error,
        notificationId: notificationId || null,
        error
      });
    });
  });
}

async function markSessionNotificationSent(sessionId, key) {
  return markSessionNotificationValue(sessionId, key, true);
}

async function markSessionNotificationValue(sessionId, key, value) {
  if (!sessionId || !key) return;

  const {
    activeSession,
    analyticsActiveSession
  } = await chrome.storage.local.get(["activeSession", "analyticsActiveSession"]);
  const updates = {};

  if (activeSession?.id === sessionId) {
    updates.activeSession = {
      ...activeSession,
      [key]: value
    };
  }

  if (analyticsActiveSession?.id === sessionId) {
    updates.analyticsActiveSession = {
      ...analyticsActiveSession,
      [key]: value
    };
  }

  if (Object.keys(updates).length) {
    await chrome.storage.local.set(updates);
  }
}

async function maybeNotifySessionOverrun(activeSession) {
  if (!activeSession?.id || activeSession?.intendedMinutes == null) return;
  const preferences = await getNotificationPreferences();
  if (!preferences.overrun) return;
  if (isIdleStateInactive(await refreshIdleState()) && !videoPlaying) return;

  const sessionId = String(activeSession.id);
  if (activeSession.overrunNotificationSent) {
    lastOverrunNotificationSessionId = sessionId;
    return;
  }
  if (lastOverrunNotificationSessionId === sessionId) return;

  const intendedMs = Number(activeSession.intendedMinutes || 0) * 60 * 1000;
  if (intendedMs <= 0) return;

  const now = Date.now();
  const sessionStart = Number(activeSession.startTime || now);
  const elapsedMs = Math.max(0, now - sessionStart);

  if (elapsedMs <= intendedMs) return;

  try {
    await createBasicNotification(
      `session-overrun-${sessionId}`,
      "Over intended time",
      "You have now exceeded your intended browsing duration."
    );
    lastOverrunNotificationSessionId = sessionId;
    await markSessionNotificationSent(sessionId, "overrunNotificationSent");
  } catch {}
}

function groupIntoSessions(visits) {
  if (!visits.length) return [];
  const thresholdMs = getInactivityThresholdMs();

  const sorted = [...visits].sort((a, b) => a.time - b.time);
  const hasSessionIds = sorted.some((v) => v.sessionId != null);

  let sessions;

  if (hasSessionIds) {
    const byId = new Map();

    for (const v of sorted) {
      const key = v.sessionId != null ? v.sessionId : "__legacy__";
      if (!byId.has(key)) byId.set(key, []);
      byId.get(key).push(v);
    }

    sessions = Array.from(byId.values()).sort((a, b) => a[0].time - b[0].time);
  } else {
    sessions = [];
    let current = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      const gap = curr.time - prev.time;

      if (gap > thresholdMs) {
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
  return rebuildSessionStore({
    visitsKey: "visits",
    sessionsKey: "sessions",
    intentsKey: "sessionIntents"
  });
}

async function rebuildAnalyticsSessions() {
  return rebuildSessionStore({
    visitsKey: "analyticsVisits",
    sessionsKey: "analyticsSessions",
    intentsKey: "analyticsSessionIntents"
  });
}

async function stopCurrentSession() {
  const {
    activeSession,
    analyticsActiveSession
  } = await chrome.storage.local.get(["activeSession", "analyticsActiveSession"]);

  if (!activeSession && !analyticsActiveSession) {
    return { ok: true, stopped: false };
  }

  await chrome.storage.local.set({
    activeSession: null,
    analyticsActiveSession: null,
    pendingManualSession: null,
    pendingAutoResume: null,
    awaitingResumeIntent: false,
    lastUserActivityAt: Date.now()
  });

  lastOverrunNotificationSessionId = null;
  lastGoalReminderSessionId = null;
  lastEndingSoonNotificationSessionId = null;
  lastSessionEndedNotificationSessionId = null;

  await rebuildSessions();
  await rebuildAnalyticsSessions();
  return { ok: true, stopped: true };
}

async function promptForAutoSessionIntent(sessionId) {
  if (!sessionId || lastPromptedAutoSessionId === sessionId) return;
  if (!chromeAppFocused) return;

  const {
    activeSession,
    analyticsActiveSession
  } = await chrome.storage.local.get(["activeSession", "analyticsActiveSession"]);

  if (activeSession?.id !== sessionId) return;
  if (activeSession?.goalSelectionMade === true) return;
  const existing = await findExistingAutoIntentPopup();
  if (activeSession?.autoIntentPrompted === true) {
    if (existing?.windowId) {
      lastPromptedAutoSessionId = sessionId;
      try {
        await chrome.windows.update(existing.windowId, { focused: true });
      } catch {}
      return;
    }
  }

  const updates = {
    activeSession: {
      ...activeSession,
      autoIntentPrompted: true
    }
  };

  if (analyticsActiveSession?.id === sessionId) {
    updates.analyticsActiveSession = {
      ...analyticsActiveSession,
      autoIntentPrompted: true
    };
  }

  await chrome.storage.local.set(updates);
  lastPromptedAutoSessionId = sessionId;

  try {
    const popupUrl = chrome.runtime.getURL("intent.html?mode=auto");
    await ensureSingleAutoIntentPopup(async () => {
      return chrome.windows.create({
        url: popupUrl,
        type: "popup",
        width: 640,
        height: 560,
        focused: true
      });
    });
  } catch {}
}

async function promptForPendingAutoIntent() {
  if (!chromeAppFocused) return;

  const popupUrl = chrome.runtime.getURL("intent.html?mode=auto");
  const existing = await findExistingAutoIntentPopup();
  const { pendingAutoResume, awaitingResumeIntent } = await chrome.storage.local.get([
    "pendingAutoResume",
    "awaitingResumeIntent"
  ]);

  if (!awaitingResumeIntent) return;
  if (!pendingAutoResume?.id) return;

  if (pendingAutoResume.autoIntentPrompted === true) {
    if (existing?.windowId) {
      await chrome.windows.update(existing.windowId, { focused: true });
      return;
    }

    await chrome.storage.local.set({
      pendingAutoResume: {
        ...pendingAutoResume,
        autoIntentPrompted: false
      }
    });
  }

  const { pendingAutoResume: refreshedPendingAutoResume } = await chrome.storage.local.get([
    "pendingAutoResume"
  ]);
  const nextPendingAutoResume = refreshedPendingAutoResume || pendingAutoResume;
  if (!nextPendingAutoResume?.id) return;

  await chrome.storage.local.set({
    pendingAutoResume: {
      ...nextPendingAutoResume,
      autoIntentPrompted: true
    }
  });

  try {
    await ensureSingleAutoIntentPopup(async () => {
      return chrome.windows.create({
        url: popupUrl,
        type: "popup",
        width: 640,
        height: 560,
        focused: true
      });
    });
  } catch {}
}

async function stagePendingAutoResume(tab, source = "activity-resume", ts = Date.now()) {
  const url = tab?.url || "";
  if (!url || shouldIgnoreUrl(url) || shouldIgnoreExtensionPage(url)) return false;

  const { pendingAutoResume } = await chrome.storage.local.get(["pendingAutoResume"]);
  const nextPending = {
    id: pendingAutoResume?.id || `${ts}`,
    url,
    tabId: tab?.id ?? null,
    favIconUrl: tab?.favIconUrl || "",
    source,
    detectedAt: ts,
    autoIntentPrompted: pendingAutoResume?.autoIntentPrompted || false
  };

  await chrome.storage.local.set({
    pendingAutoResume: nextPending,
    awaitingResumeIntent: true,
    lastUserActivityAt: ts
  });

  await promptForPendingAutoIntent();
  return true;
}

async function acceptPendingAutoResumeWithoutGoal() {
  const {
    pendingAutoResume,
    awaitingResumeIntent,
    activeSession,
    analyticsActiveSession,
    visits = [],
    analyticsVisits = []
  } = await chrome.storage.local.get([
    "pendingAutoResume",
    "awaitingResumeIntent",
    "activeSession",
    "analyticsActiveSession",
    "visits",
    "analyticsVisits"
  ]);

  if (activeSession?.id || !awaitingResumeIntent || !pendingAutoResume?.url) {
    return { ok: true, started: false };
  }

  const now = Date.now();
  const sessionId = `${now}`;
  const domain = toDomain(pendingAutoResume.url);
  const newSession = {
    id: sessionId,
    startTime: now,
    lastEventTime: now,
    uniqueDomains: domain && domain !== "unknown" ? [domain] : [],
    visitCount: 1,
    intendedMinutes: null,
    sessionName: "",
    goalSelectionMade: false,
    autoIntentPrompted: false
  };
  const newVisit = {
    url: pendingAutoResume.url,
    domain,
    time: now,
    lastActiveTime: now,
    source: pendingAutoResume.source || "activity-resume",
    tabId: pendingAutoResume.tabId ?? null,
    favIconUrl: pendingAutoResume.favIconUrl || "",
    hadInteraction: true,
    firstInteractionTime: now,
    sessionId
  };

  await chrome.storage.local.set({
    visits: [...visits, newVisit],
    analyticsVisits: [...analyticsVisits, { ...newVisit }],
    activeSession: newSession,
    analyticsActiveSession: {
      ...(analyticsActiveSession || newSession),
      ...newSession
    },
    pendingAutoResume: null,
    awaitingResumeIntent: false,
    lastUserActivityAt: now
  });

  await rebuildSessions();
  await rebuildAnalyticsSessions();
  await maybeNotifyMissingGoal(newSession);
  return { ok: true, started: true };
}

async function dismissPendingAutoResumePrompt() {
  const { pendingAutoResume, awaitingResumeIntent } = await chrome.storage.local.get([
    "pendingAutoResume",
    "awaitingResumeIntent"
  ]);

  if (!awaitingResumeIntent || !pendingAutoResume?.id) {
    return { ok: true, dismissed: false };
  }

  await chrome.storage.local.set({
    pendingAutoResume: {
      ...pendingAutoResume,
      autoIntentPrompted: false
    }
  });

  autoIntentPopupWindowId = null;
  autoIntentPopupTabId = null;
  return { ok: true, dismissed: true };
}

async function ensureAutoIntentPromptForActiveSession() {
  if (!chromeAppFocused) return false;

  const { activeSession, pendingAutoResume, awaitingResumeIntent } = await chrome.storage.local.get([
    "activeSession",
    "pendingAutoResume",
    "awaitingResumeIntent"
  ]);
  if (!activeSession?.id && awaitingResumeIntent && pendingAutoResume?.id) {
    await promptForPendingAutoIntent();
    return true;
  }
  if (!activeSession?.id) return false;
  if (activeSession.goalSelectionMade === true) return false;

  await promptForAutoSessionIntent(activeSession.id);
  return true;
}

async function heartbeatActiveSession(ts) {
  const {
    activeSession,
    analyticsActiveSession
  } = await chrome.storage.local.get(["activeSession", "analyticsActiveSession"]);
  const updates = {};

  if (activeSession && (activeSession.lastEventTime || 0) < ts) {
    updates.activeSession = {
      ...activeSession,
      lastEventTime: ts
    };
  }

  if (analyticsActiveSession && (analyticsActiveSession.lastEventTime || 0) < ts) {
    updates.analyticsActiveSession = {
      ...analyticsActiveSession,
      lastEventTime: ts
    };
  }

  if (Object.keys(updates).length) {
    await chrome.storage.local.set(updates);
  }

  await maybeNotifySessionOverrun(updates.activeSession || activeSession);
  await maybeNotifyMissingGoal(updates.activeSession || activeSession);
}

async function resumeSessionFromForegroundActivity(tab, ts = Date.now()) {
  const url = tab?.url || "";
  if (!url || shouldIgnoreUrl(url) || shouldIgnoreExtensionPage(url)) return false;

  const { activeSession } = await chrome.storage.local.get(["activeSession"]);
  if (activeSession?.id && activeSession.goalSelectionMade !== true) {
    await promptForAutoSessionIntent(activeSession.id);
  }
  const shouldResume = !activeSession;

  if (!shouldResume) return false;

  await stagePendingAutoResume(tab, "activity-resume", ts);
  return true;
}

async function logVisit(url, source, tabId = null, favIconUrl = "") {
  return logVisitChain = logVisitChain.then(async () => {
    if (shouldIgnoreUrl(url)) return;
    if (shouldIgnoreExtensionPage(url)) return;

    const now = Date.now();
    const visit = {
      url,
      domain: toDomain(url),
      time: now,
      lastActiveTime: now,
      source,
      tabId,
      favIconUrl,
      hadInteraction: false
    };

    const data = await chrome.storage.local.get([
      "visits",
      "activeSession",
      "pendingManualSession",
      "pendingAutoResume",
      "awaitingResumeIntent",
      "manualSessionStarts",
      "analyticsVisits",
      "analyticsActiveSession"
    ]);
    const visits = data.visits || [];
    const analyticsVisits = data.analyticsVisits || [];
    let active = data.activeSession || null;
    const pendingManualSession = data.pendingManualSession || null;
    const pendingAutoResume = data.pendingAutoResume || null;
    const awaitingResumeIntent = Boolean(data.awaitingResumeIntent);
    const manualSessionStarts = Array.isArray(data.manualSessionStarts) ? data.manualSessionStarts.slice() : [];
    let analyticsActive = data.analyticsActiveSession || null;
    let startedAutoSession = false;
    let startedPendingManualSession = false;
    const findLatestMatchingVisitIndex = (list) => {
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const row = list[i];
        if (!row) continue;
        if (row.url !== url) continue;
        if (row.tabId == null || tabId == null || row.tabId !== tabId) continue;
        return i;
      }
      return -1;
    };

    const latestVisitIndex = findLatestMatchingVisitIndex(visits);
    const latestVisit = latestVisitIndex >= 0 ? visits[latestVisitIndex] : null;
    const shouldCollapseRepeatVisit =
      latestVisit &&
      (
        source === "page-reload" ||
        (
          source === "navigation" &&
          now - Number(latestVisit.time || 0) <= REPEAT_VISIT_COLLAPSE_WINDOW_MS
        )
      );

    if (shouldCollapseRepeatVisit) {
      const nextVisits = visits.slice();
      nextVisits[latestVisitIndex] = {
        ...latestVisit,
        lastActiveTime: now,
        favIconUrl: favIconUrl || latestVisit.favIconUrl || ""
      };

      const nextAnalyticsVisits = analyticsVisits.slice();
      const latestAnalyticsIndex = findLatestMatchingVisitIndex(nextAnalyticsVisits);
      if (latestAnalyticsIndex >= 0) {
        const latestAnalyticsVisit = nextAnalyticsVisits[latestAnalyticsIndex];
        nextAnalyticsVisits[latestAnalyticsIndex] = {
          ...latestAnalyticsVisit,
          lastActiveTime: now,
          favIconUrl: favIconUrl || latestAnalyticsVisit.favIconUrl || ""
        };
      }

      await chrome.storage.local.set({
        visits: nextVisits,
        analyticsVisits: nextAnalyticsVisits
      });
      await heartbeatActiveSession(now);
      await rebuildSessions();
      await rebuildAnalyticsSessions();
      return;
    }

    if (!active && (pendingAutoResume?.id || awaitingResumeIntent)) {
      await chrome.storage.local.set({
        pendingAutoResume: {
          ...pendingAutoResume,
          id: pendingAutoResume?.id || `${now}`,
          url,
          tabId,
          favIconUrl,
          source,
          detectedAt: now,
          autoIntentPrompted: pendingAutoResume?.autoIntentPrompted || false
        },
        awaitingResumeIntent: true,
        lastUserActivityAt: now
      });
      await promptForPendingAutoIntent();
      return;
    }

    if (!active && pendingManualSession?.id) {
      active = {
        id: pendingManualSession.id,
        startTime: now,
        lastEventTime: now,
        uniqueDomains: [],
        visitCount: 0,
        intendedMinutes:
          pendingManualSession.intendedMinutes == null ? null : Number(pendingManualSession.intendedMinutes),
        sessionName: normalizeSessionName(pendingManualSession.sessionName || ""),
        goalSelectionMade: true,
        autoIntentPrompted: false
      };
      startedAutoSession = true;
      startedPendingManualSession = true;
    }

    if (!active) {
      active = {
        id: `${now}`,
        startTime: now,
        lastEventTime: now,
        uniqueDomains: [],
        visitCount: 0,
        goalSelectionMade: false
      };
      startedAutoSession = true;
    }

    if (!analyticsActive) {
      analyticsActive = {
        id: active?.id || `${now}`,
        startTime: now,
        lastEventTime: now,
        uniqueDomains: [],
        visitCount: 0,
        goalSelectionMade: active?.goalSelectionMade ?? false
      };
    }

    if (startedAutoSession) {
      await setLastUserActivity(now);
    }

    active.lastEventTime = now;
    active.visitCount += 1;

    if (!active.uniqueDomains.includes(visit.domain)) {
      active.uniqueDomains.push(visit.domain);
    }

    visit.sessionId = active.id;
    const analyticsVisit = {
      ...visit,
      sessionId: analyticsActive.id
    };

    visits.push(visit);
    analyticsVisits.push(analyticsVisit);

    await chrome.storage.local.set({
      visits,
      activeSession: active,
      analyticsVisits,
      pendingManualSession: null,
      pendingAutoResume: null,
      awaitingResumeIntent: false,
      manualSessionStarts: startedPendingManualSession ? [...manualSessionStarts, now] : manualSessionStarts,
      analyticsActiveSession: {
        ...analyticsActive,
        lastEventTime: now,
        visitCount: (analyticsActive.visitCount || 0) + 1,
        uniqueDomains: analyticsActive.uniqueDomains?.includes(analyticsVisit.domain)
          ? analyticsActive.uniqueDomains
          : [...(analyticsActive.uniqueDomains || []), analyticsVisit.domain]
      }
    });

    await rebuildSessions();
    await rebuildAnalyticsSessions();
    await maybeNotifySessionOverrun(active);
    await maybeNotifyMissingGoal(active);

    if (startedAutoSession) {
      await promptForAutoSessionIntent(active.id);
    }
  });
}

async function maybeNotifyMissingGoal(activeSession) {
  if (!activeSession?.id) return;
  if (activeSession.goalSelectionMade === true) return;
  const preferences = await getNotificationPreferences();
  if (!preferences.missingGoal) return;
  if (isIdleStateInactive(await refreshIdleState()) && !videoPlaying) return;

  const sessionId = String(activeSession.id);
  if (activeSession.missingGoalNotificationSent) {
    lastGoalReminderSessionId = sessionId;
    return;
  }
  if (lastGoalReminderSessionId === sessionId) return;

  const now = Date.now();
  const sessionStart = Number(activeSession.startTime || now);
  const elapsedMs = Math.max(0, now - sessionStart);
  if (elapsedMs < NO_GOAL_REMINDER_DELAY_MS) return;

  try {
    const result = await createBasicNotification(
      `session-goal-reminder-${sessionId}`,
      "No goal selected",
      "This current session has no goal. Start a new session to set a goal or choose No goal."
    );
    if (!result?.ok) return;
    lastGoalReminderSessionId = sessionId;
    await markSessionNotificationSent(sessionId, "missingGoalNotificationSent");
  } catch {}
}

async function maybeNotifyNoGoalHourly(activeSession) {
  if (!activeSession?.id) return;
  if (activeSession.goalSelectionMade !== true) return;
  if (activeSession.intendedMinutes != null) return;

  const preferences = await getNotificationPreferences();
  if (!preferences.noGoalHourly) return;
  if (isIdleStateInactive(await refreshIdleState()) && !videoPlaying) return;

  const now = Date.now();
  const sessionStart = Number(activeSession.startTime || now);
  const elapsedMs = Math.max(0, now - sessionStart);
  const intervalHours = await getNoGoalHourlyIntervalHours();
  const elapsedHours = Math.floor(elapsedMs / (60 * 60 * 1000));
  const completedMilestones = Math.floor(elapsedHours / intervalHours);
  if (completedMilestones < 1) return;

  const alreadySentMilestones = Number(activeSession.noGoalHourNotificationCount || 0);
  if (completedMilestones <= alreadySentMilestones) return;

  const milestoneHours = completedMilestones * intervalHours;
  const hourLabel = formatNoGoalIntervalLabel(milestoneHours);

  try {
    const result = await createBasicNotification(
      `session-no-goal-hourly-${activeSession.id}-${milestoneHours}`,
      `You are ${hourLabel} in`,
      "This session is still set to No goal."
    );
    if (!result?.ok) return;
    await markSessionNotificationValue(
      String(activeSession.id),
      "noGoalHourNotificationCount",
      completedMilestones
    );
  } catch {}
}

async function maybeNotifySessionEndingSoon(activeSession) {
  if (!activeSession?.id || activeSession?.intendedMinutes == null) return;
  const preferences = await getNotificationPreferences();
  if (!preferences.endingSoon) return;
  if (isIdleStateInactive(await refreshIdleState()) && !videoPlaying) return;

  const sessionId = String(activeSession.id);
  if (activeSession.endingSoonNotificationSent) {
    lastEndingSoonNotificationSessionId = sessionId;
    return;
  }
  if (lastEndingSoonNotificationSessionId === sessionId) return;
  if (lastOverrunNotificationSessionId === sessionId) return;

  const intendedMs = Number(activeSession.intendedMinutes || 0) * 60 * 1000;
  if (intendedMs <= 2 * 60 * 1000) return;

  const now = Date.now();
  const sessionStart = Number(activeSession.startTime || now);
  const elapsedMs = Math.max(0, now - sessionStart);
  const remainingMs = intendedMs - elapsedMs;

  if (remainingMs <= 0 || remainingMs > 2 * 60 * 1000) return;

  try {
    const result = await createBasicNotification(
      `session-ending-soon-${sessionId}`,
      "Your session is ending soon",
      "You have about 2 minutes left before reaching your intended browsing duration."
    );
    if (!result?.ok) return;
    lastEndingSoonNotificationSessionId = sessionId;
    await markSessionNotificationSent(sessionId, "endingSoonNotificationSent");
  } catch {}
}

async function maybeNotifySessionEnded(activeSession) {
  if (!activeSession?.id) return;
  const preferences = await getNotificationPreferences();
  if (!preferences.sessionEnded) return;

  const sessionId = String(activeSession.id);
  if (activeSession.sessionEndedNotificationSent) {
    lastSessionEndedNotificationSessionId = sessionId;
    return;
  }
  if (lastSessionEndedNotificationSessionId === sessionId) return;

  try {
    const result = await createBasicNotification(
      `session-ended-${sessionId}`,
      "Your session has ended",
      "This session ended because no activity was detected before your inactivity threshold."
    );
    if (!result?.ok) return;
    lastSessionEndedNotificationSessionId = sessionId;
    await markSessionNotificationSent(sessionId, "sessionEndedNotificationSent");
  } catch {}
}

async function runSessionMonitorTick() {
  const now = Date.now();
  const idleState = await refreshIdleState();
  const browserInactive = isIdleStateInactive(idleState);
  const data = await chrome.storage.local.get([
    "activeSession",
    "analyticsActiveSession",
    "pendingAutoResume",
    "awaitingResumeIntent"
  ]);
  const active = data.activeSession;
  const analyticsActive = data.analyticsActiveSession;
  const updates = {};

  if (active) {
    if (browserInactive && !videoPlaying) {
      await maybeNotifySessionEnded(active);
      updates.activeSession = null;
      updates.pendingAutoResume = null;
      updates.awaitingResumeIntent = true;
      lastOverrunNotificationSessionId = null;
      lastGoalReminderSessionId = null;
      lastEndingSoonNotificationSessionId = null;
    } else {
      await maybeNotifySessionEndingSoon(active);
      await maybeNotifySessionOverrun(active);
      await maybeNotifyMissingGoal(active);
      await maybeNotifyNoGoalHourly(active);
    }
  }

  if (analyticsActive) {
    if (browserInactive && !videoPlaying) {
      updates.analyticsActiveSession = null;
    }
  }

  if (Object.keys(updates).length) {
    await chrome.storage.local.set(updates);
  }
}

function ensureSessionMonitorAlarm() {
  chrome.alarms.create(SESSION_MONITOR_ALARM, {
    periodInMinutes: 0.5
  });
}

async function resumeFromActiveTab(source = "activity-resume") {
  try {
    if (!chromeAppFocused) return false;

    const { activeSession, pendingAutoResume, awaitingResumeIntent } = await chrome.storage.local.get([
      "activeSession",
      "pendingAutoResume",
      "awaitingResumeIntent"
    ]);
    if (activeSession?.id) {
      if (activeSession.goalSelectionMade !== true) {
        await promptForAutoSessionIntent(activeSession.id);
      }
      return false;
    }

    if (awaitingResumeIntent && pendingAutoResume?.id) {
      await promptForPendingAutoIntent();
      return true;
    }

    const tabs = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });
    const activeTab = tabs?.[0];
    if (!activeTab?.url) return false;

    await stagePendingAutoResume(activeTab, source, Date.now());
    return true;
  } catch {
    return false;
  }
}

function scheduleActiveSessionAlarms(activeSession) {
  chrome.alarms.clear(SESSION_OVERRUN_ALARM);
  chrome.alarms.clear(SESSION_GOAL_REMINDER_ALARM);
  chrome.alarms.clear(SESSION_ENDING_SOON_ALARM);

  if (!activeSession?.id) return;

  const now = Date.now();
  const sessionStart = Number(activeSession.startTime || now);

  if (activeSession.goalSelectionMade !== true) {
    chrome.alarms.create(SESSION_GOAL_REMINDER_ALARM, {
      when: sessionStart + NO_GOAL_REMINDER_DELAY_MS
    });
  }

  if (activeSession.intendedMinutes != null) {
    const intendedMs = Number(activeSession.intendedMinutes || 0) * 60 * 1000;
    if (intendedMs > 0) {
      if (intendedMs > 2 * 60 * 1000) {
        chrome.alarms.create(SESSION_ENDING_SOON_ALARM, {
          when: sessionStart + intendedMs - 2 * 60 * 1000
        });
      }
      chrome.alarms.create(SESSION_OVERRUN_ALARM, {
        when: sessionStart + intendedMs
      });
    }
  }
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  if (!chromeAppFocused) return;

  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url) {
      await logVisit(tab.url, "tab-switch", tabId, tab.favIconUrl || "");
    }
  } catch {}
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (autoIntentPopupTabId === tabId) {
    autoIntentPopupTabId = null;
    autoIntentPopupWindowId = null;
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (autoIntentPopupWindowId === windowId) {
    autoIntentPopupWindowId = null;
    autoIntentPopupTabId = null;
  }
});

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (!chromeAppFocused) return;
  if (details.frameId !== 0) return;
  if (!details.url) return;

  let source = "navigation";

  if (details.transitionType === "typed") source = "direct-url-entry";
  else if (details.transitionType === "link") source = "link-navigation";
  else if (details.transitionType === "reload") source = "page-reload";
  else if (details.transitionType === "auto_bookmark") source = "bookmark-navigation";
  else if (details.transitionType === "generated") source = "address-bar-search";

  let favIconUrl = "";
  try {
    const tab = await chrome.tabs.get(details.tabId);
    if (!tab?.active) return;
    favIconUrl = tab?.favIconUrl || "";
  } catch {}

  await logVisit(details.url, source, details.tabId, favIconUrl);
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    ensureSessionMonitorAlarm();
    await loadInactivityThreshold();
    await refreshIdleState();
    await rebuildSessions();
    await rebuildAnalyticsSessions();
  } catch {}
});

chrome.runtime.onInstalled.addListener(async () => {
  try {
    ensureSessionMonitorAlarm();
    const {
      visits,
      sessions,
      activeSession,
      sessionIntents,
      lastUserActivityAt,
      inactivityThresholdMinutes,
      analyticsVisits,
      analyticsSessions,
      analyticsActiveSession,
      analyticsSessionIntents,
      pendingManualSession,
      pendingAutoResume,
      awaitingResumeIntent
    } =
      await chrome.storage.local.get([
        "visits",
        "sessions",
        "activeSession",
        "sessionIntents",
        "lastUserActivityAt",
        "inactivityThresholdMinutes",
        "analyticsVisits",
        "analyticsSessions",
        "analyticsActiveSession",
        "analyticsSessionIntents",
        "pendingManualSession",
        "pendingAutoResume",
        "awaitingResumeIntent"
      ]);

    if (!visits) await chrome.storage.local.set({ visits: [] });
    if (!sessions) await chrome.storage.local.set({ sessions: [] });
    if (!activeSession) await chrome.storage.local.set({ activeSession: null });
    if (!sessionIntents) await chrome.storage.local.set({ sessionIntents: [] });
    if (!lastUserActivityAt) await chrome.storage.local.set({ lastUserActivityAt: Date.now() });
    if (!analyticsVisits) await chrome.storage.local.set({ analyticsVisits: visits || [] });
    if (!analyticsSessions) await chrome.storage.local.set({ analyticsSessions: sessions || [] });
    if (!analyticsActiveSession) await chrome.storage.local.set({ analyticsActiveSession: activeSession || null });
    if (!analyticsSessionIntents) {
      await chrome.storage.local.set({ analyticsSessionIntents: sessionIntents || [] });
    }
    if (pendingManualSession == null) {
      await chrome.storage.local.set({ pendingManualSession: null });
    }
    if (pendingAutoResume == null) {
      await chrome.storage.local.set({ pendingAutoResume: null });
    }
    if (awaitingResumeIntent == null) {
      await chrome.storage.local.set({ awaitingResumeIntent: false });
    }
    if (inactivityThresholdMinutes == null) {
      await chrome.storage.local.set({ inactivityThresholdMinutes: DEFAULT_INACTIVITY_THRESHOLD_MINUTES });
    }
    await loadInactivityThreshold();
    await refreshIdleState();
    await rebuildSessions();
    await rebuildAnalyticsSessions();
  } catch {}
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === SESSION_MONITOR_ALARM) {
    runSessionMonitorTick().catch(() => {});
    return;
  }

  if (
    alarm?.name === SESSION_OVERRUN_ALARM ||
    alarm?.name === SESSION_GOAL_REMINDER_ALARM ||
    alarm?.name === SESSION_ENDING_SOON_ALARM
  ) {
    chrome.storage.local.get(["activeSession"]).then(({ activeSession }) => {
      if (alarm.name === SESSION_ENDING_SOON_ALARM) {
        return maybeNotifySessionEndingSoon(activeSession);
      }

      if (alarm.name === SESSION_OVERRUN_ALARM) {
        return maybeNotifySessionOverrun(activeSession);
      }

      return maybeNotifyMissingGoal(activeSession);
    }).catch(() => {});
  }
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  chromeAppFocused = windowId !== chrome.windows.WINDOW_ID_NONE;

  if (chromeAppFocused) {
    ensureAutoIntentPromptForActiveSession()
      .then((promptedExisting) => {
        if (!promptedExisting) {
          return resumeFromActiveTab("chrome-focus-resume");
        }
        return false;
      })
      .catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === "userActivity") {
    const ts = Number(msg.ts) || Date.now();
    browserIdleState = "active";
    (async () => {
      try {
        const resumed = await resumeSessionFromForegroundActivity(sender?.tab, ts);
        await setLastUserActivity(ts);
        if (!resumed) {
          await heartbeatActiveSession(ts);
          await markVisitInteraction(sender?.tab?.id, sender?.tab?.url, ts);
        }
        sendResponse?.({ ok: true });
      } catch {
        sendResponse?.({ ok: false });
      }
    })();
    return true;
  }

  if (msg.type === "videoStatus") {
    (async () => {
      try {
        videoPlaying = msg.playing;
        if (msg.playing) {
          browserIdleState = "active";
          const ts = Number(msg.ts) || Date.now();
          await setLastUserActivity(ts);
          await heartbeatActiveSession(ts);
          await markVisitInteraction(sender?.tab?.id, sender?.tab?.url, ts);
        }
        sendResponse?.({ ok: true });
      } catch {
        sendResponse?.({ ok: false });
      }
    })();
    return true;
  }

  if (msg.type === "rebuildSessions") {
    Promise.all([rebuildSessions(), rebuildAnalyticsSessions()])
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));

    return true;
  }

  if (msg.type === "stopCurrentSession") {
    stopCurrentSession()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));

    return true;
  }

  if (msg.type === "acceptPendingAutoResumeWithoutGoal") {
    acceptPendingAutoResumeWithoutGoal()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));

    return true;
  }

  if (msg.type === "dismissPendingAutoResumePrompt") {
    dismissPendingAutoResumePrompt()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));

    return true;
  }

  if (msg.type === "askAnalyticsAssistant") {
    (async () => {
      try {
        const question = String(msg.question || "").trim();
        if (!question) {
          sendResponse({ ok: false, error: "Ask a question first." });
          return;
        }

        const backendUrl = getAiAssistantBackendUrl();

        const response = await fetch(backendUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            question,
            history: Array.isArray(msg.history) ? msg.history : [],
            context: msg.context || {}
          })
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          const apiError = payload?.detail || payload?.error || `Assistant backend failed (${response.status})`;
          sendResponse({ ok: false, error: apiError });
          return;
        }

        const answer = String(payload?.answer || payload?.report || "").trim();

        sendResponse({
          ok: true,
          answer: answer || "I couldn't extract an answer from the assistant backend."
        });
      } catch (error) {
        const backendUrl = getAiAssistantBackendUrl();
        sendResponse({
          ok: false,
          error: `Could not reach the AI assistant backend at ${backendUrl}.`
        });
      }
    })();

    return true;
  }

  if (msg.type === "testNotificationPreview") {
    const kind = msg.kind;
    const sendPreview = async () => {
      let title = "Screen Time Momentum";
      let message = "Test notification.";

      if (kind === "endingSoon") {
        title = "Your session is ending soon";
        message = "You have about 2 minutes left before reaching your intended browsing duration.";
      } else if (kind === "overrun") {
        title = "Over intended time";
        message = "You have now exceeded your intended browsing duration.";
      } else if (kind === "missingGoal") {
        title = "No goal selected";
        message = "This current session has no goal. Start a new session to set a goal or choose No goal.";
      } else if (kind === "noGoalHourly") {
        const intervalHours = await getNoGoalHourlyIntervalHours();
        const hourLabel = formatNoGoalIntervalLabel(intervalHours);
        title = `You are ${hourLabel} in`;
        message = "This session is still set to No goal.";
      } else if (kind === "sessionEnded") {
        title = "Your session has ended";
        message = "This session ended because no activity was detected before your inactivity threshold.";
      }

      return createBasicNotification(`test-preview-${kind}-${Date.now()}`, title, message);
    };

    sendPreview()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));

    return true;
  }

});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  if (changes.inactivityThresholdMinutes) {
    const minutes = normalizeInactivityThresholdMinutes(changes.inactivityThresholdMinutes.newValue);
    inactivityThresholdMs = minutes * 60 * 1000;
    setIdleDetectionInterval();
    rebuildSessions().catch(() => {});
    rebuildAnalyticsSessions().catch(() => {});
  }

  if (changes.activeSession) {
    scheduleActiveSessionAlarms(changes.activeSession.newValue || null);
  }
});

ensureSessionMonitorAlarm();
chrome.storage.local.get(["activeSession"]).then(({ activeSession }) => {
  scheduleActiveSessionAlarms(activeSession || null);
}).catch(() => {});
chrome.windows.getLastFocused().then((window) => {
  chromeAppFocused = Boolean(window?.id) && window.id !== chrome.windows.WINDOW_ID_NONE;
}).catch(() => {
  chromeAppFocused = true;
});
loadInactivityThreshold().catch(() => {});
refreshIdleState().catch(() => {});

chrome.idle.onStateChanged.addListener((state) => {
  browserIdleState = state || "active";
  if (state === "active") {
    (async () => {
      await setLastUserActivity(Date.now());
    })().catch(() => {});
    return;
  }
  runSessionMonitorTick().catch(() => {});
});
