const DEFAULT_INACTIVITY_THRESHOLD_MINUTES = 10;
const LEGITIMATE_TAB_DWELL_MS = 3000;
const DEFAULT_NO_GOAL_HOURLY_INTERVAL_HOURS = 1;
const NO_GOAL_INTERVAL_OPTIONS_HOURS = [0.25, 0.5, 1, 2];
let inactivityThresholdMs = DEFAULT_INACTIVITY_THRESHOLD_MINUTES * 60 * 1000;
const DISTRIBUTION_COLORS = [
  "#7d34d8",
  "#9150e4",
  "#a76cf0",
  "#ba87f7",
  "#cd9ff9",
  "#8b5cf6",
  "#6d28d9",
  "#ddd6fe"
];
const expandedSessionStarts = new Set();
const expandedHistoryDays = new Set();
const expandedHistorySessions = new Set();
const expandedSequenceLabels = new Set();
let historySearchQuery = "";
let historySearchScope = "all";
let footprintSelectedDomain = "";
const dashboardSessionHelpers = window.ScreenTimeSessionHelpers || null;
const startManualSession = dashboardSessionHelpers?.startManualSession || null;
let dashboardState = {
  activeSession: null,
  sessions: [],
  analyticsSessions: [],
  visits: [],
  inactivityThresholdMinutes: DEFAULT_INACTIVITY_THRESHOLD_MINUTES,
  noGoalHourlyIntervalHours: DEFAULT_NO_GOAL_HOURLY_INTERVAL_HOURS
};

function showDashboardError(message) {
  const shell = document.querySelector(".appShell");
  if (!shell) {
    document.body.innerHTML = `
      <div style="min-height:100vh;display:grid;place-items:center;padding:32px;background:#f6f4fb;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1f2937;">
        <div style="max-width:520px;padding:24px 26px;border-radius:20px;background:#fff;border:1px solid rgba(31,41,55,.10);box-shadow:0 12px 32px rgba(15,23,42,.08);">
          <div style="font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#7d34d8;margin-bottom:8px;">Extension needs refresh</div>
          <div style="font-size:28px;font-weight:800;line-height:1.08;letter-spacing:-.03em;margin-bottom:10px;">Dashboard unavailable</div>
          <div style="font-size:15px;line-height:1.5;color:#5f6373;">${escapeHtml(message)}</div>
        </div>
      </div>
    `;
    return;
  }

  shell.innerHTML = `
    <div style="min-height:100vh;display:grid;place-items:center;padding:32px;width:100%;">
      <div style="max-width:520px;padding:24px 26px;border-radius:20px;background:#fff;border:1px solid rgba(31,41,55,.10);box-shadow:0 12px 32px rgba(15,23,42,.08);">
        <div style="font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#7d34d8;margin-bottom:8px;">Extension needs refresh</div>
        <div style="font-size:28px;font-weight:800;line-height:1.08;letter-spacing:-.03em;margin-bottom:10px;">Dashboard unavailable</div>
        <div style="font-size:15px;line-height:1.5;color:#5f6373;">${escapeHtml(message)}</div>
      </div>
    </div>
  `;
}

window.addEventListener("error", (event) => {
  console.error("Dashboard runtime error", event.error || event.message || event);
  showDashboardError("Reload the extension in chrome://extensions and reopen the dashboard.");
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("Dashboard unhandled rejection", event.reason);
  showDashboardError("Reload the extension in chrome://extensions and reopen the dashboard.");
});

function normalizeInactivityThresholdMinutes(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return DEFAULT_INACTIVITY_THRESHOLD_MINUTES;
  return Math.min(120, Math.max(1, Math.round(minutes)));
}

function normalizeNoGoalHourlyIntervalHours(value) {
  const hours = Number(value);
  if (!Number.isFinite(hours)) return DEFAULT_NO_GOAL_HOURLY_INTERVAL_HOURS;
  if (NO_GOAL_INTERVAL_OPTIONS_HOURS.includes(hours)) return hours;
  return DEFAULT_NO_GOAL_HOURLY_INTERVAL_HOURS;
}

function normalizeSessionName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 80);
}

function describeSessionName(name) {
  const normalized = normalizeSessionName(name);
  return normalized || "Unnamed session";
}

function buildIntentRecord(sessionId, minutes, sessionName) {
  if (minutes == null && !sessionName) return null;
  return {
    sessionId,
    intendedMinutes: minutes,
    sessionName
  };
}

function syncInactivityThreshold(minutes) {
  const normalized = normalizeInactivityThresholdMinutes(minutes);
  inactivityThresholdMs = normalized * 60 * 1000;
  dashboardState.inactivityThresholdMinutes = normalized;
  return normalized;
}

function faviconUrl(domain, size = 32) {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${size}`;
}

function workspaceProductIcon(url, size = 32) {
  if (!url) return "";

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    const firstSegment = parsed.pathname.split("/").filter(Boolean)[0];

    if (host === "docs.google.com") {
      if (firstSegment === "document") {
        return "https://ssl.gstatic.com/docs/doclist/images/mediatype/icon_1_document_x16.png";
      }
      if (firstSegment === "spreadsheets") {
        return "https://ssl.gstatic.com/docs/doclist/images/mediatype/icon_1_spreadsheet_x16.png";
      }
      if (firstSegment === "presentation") {
        return "https://ssl.gstatic.com/docs/doclist/images/mediatype/icon_1_presentation_x16.png";
      }
      if (firstSegment === "forms") {
        return "https://ssl.gstatic.com/docs/doclist/images/mediatype/icon_1_form_x16.png";
      }
      if (firstSegment === "drive") {
        return "https://ssl.gstatic.com/images/branding/product/1x/drive_2020q4_32dp.png";
      }
    }
  } catch {}

  return "";
}

function resolveFaviconSrc(visitOrDomain, size = 32) {
  const visit = typeof visitOrDomain === "string" ? null : visitOrDomain;
  const domain = typeof visitOrDomain === "string" ? visitOrDomain : visitOrDomain?.domain;
  const url = visit?.url || "";

  if (visit?.favIconUrl) {
    return visit.favIconUrl;
  }

  const workspaceIcon = workspaceProductIcon(url, size);
  if (workspaceIcon) {
    return workspaceIcon;
  }

  return faviconUrl(domain, size);
}

function startOfDay(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function msToMinutes(ms) {
  return Math.round(Math.max(0, ms) / 60000);
}

function msToPretty(ms) {
  const mins = msToMinutes(ms);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function sessionDurationLabel(metrics = {}) {
  const durationMs = Math.max(0, metrics.durationMs || 0);
  const visitCount = metrics.totalVisits || 0;
  const roundedMinutes = Math.round(durationMs / 60000);
  const displayMinutes = visitCount > 0 ? Math.max(1, roundedMinutes) : roundedMinutes;

  if (displayMinutes < 60) return `${displayMinutes}m`;
  const h = Math.floor(displayMinutes / 60);
  const m = displayMinutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function minutesToHourLabel(minutes) {
  if (minutes <= 0) return "0h";
  const hours = minutes / 60;
  const rounded = Math.round(hours * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}h` : `${rounded.toFixed(1)}h`;
}

function fmtElapsed(ms) {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (char) => {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return map[char];
  });
}

function isValidDomain(domain) {
  if (!domain || typeof domain !== "string") return false;
  const normalized = domain.trim().toLowerCase();
  return Boolean(normalized) && normalized !== "unknown";
}

function isDisplayDomain(domain) {
  if (!isValidDomain(domain)) return false;
  const normalized = domain.trim().toLowerCase();
  if (["extensions", "newtab", "new-tab-page"].includes(normalized)) return false;
  return !(
    normalized.startsWith("data:") ||
    normalized.startsWith("data://") ||
    normalized.startsWith("blob:") ||
    normalized.startsWith("blob://") ||
    normalized.startsWith("javascript:") ||
    normalized.startsWith("about:") ||
    normalized.startsWith("devtools:")
  );
}

function hrefForVisit(visitOrUrl, fallbackLabel = "") {
  const rawUrl = typeof visitOrUrl === "string" ? visitOrUrl : visitOrUrl?.url;

  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      if (["data:", "blob:", "javascript:", "about:", "devtools:"].includes(parsed.protocol)) {
        return "#";
      }
      return parsed.toString();
    } catch {}
  }

  return isDisplayDomain(fallbackLabel) ? `https://${fallbackLabel}` : "#";
}

function extractGoogleSearchQuery(url) {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    const query = (parsed.searchParams.get("q") || "").trim();

    if (!host.startsWith("google.")) return null;
    if (parsed.pathname !== "/search") return null;
    if (!query) return null;

    return query;
  } catch {
    return null;
  }
}

function displayLabelForVisit(visit) {
  const fallbackDomain = visit?.domain || "unknown";
  const query = extractGoogleSearchQuery(visit?.url);
  if (query) return `Google search: "${query}"`;

  try {
    const parsed = new URL(visit?.url);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();

    if (parsed.protocol === "chrome:" || parsed.protocol === "chrome-search:") {
      const pageName = parsed.pathname
        .replace(/^\/+|\/+$/g, "")
        .replace(/^\/\//, "")
        .split("/")[0]
        .replace(/[-_]+/g, " ")
        .trim();

      if (pageName) {
        return `Chrome ${pageName.replace(/\b\w/g, (char) => char.toUpperCase())}`;
      }
    }

    if (host === "docs.google.com") {
      const section = parsed.pathname.split("/").filter(Boolean)[0];
      if (section === "document") return "Google Doc";
      if (section === "spreadsheets") return "Google Sheet";
      if (section === "presentation") return "Google Slides";
      if (section === "forms") return "Google Form";
      if (section === "drive") return "Google Drive";
    }

    if (host && parsed.pathname && parsed.pathname !== "/") {
      const firstSegment = parsed.pathname.split("/").filter(Boolean)[0];
      if (firstSegment && firstSegment.length <= 28) {
        return `${fallbackDomain}/${firstSegment}`;
      }
    }
  } catch {}

  return fallbackDomain;
}

function footprintLabelForVisit(visit) {
  const fallbackDomain = visit?.domain || "unknown";
  const query = extractGoogleSearchQuery(visit?.url);
  if (query) return `Google search: "${query}"`;

  try {
    const parsed = new URL(visit?.url);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();

    if (host.startsWith("google.")) {
      if (parsed.pathname === "/" || parsed.pathname === "") {
        return "Google homepage";
      }

      if (parsed.pathname === "/search") {
        const tabMode = parsed.searchParams.get("tbm");
        if (tabMode === "isch") return "Google Images";
        if (tabMode === "nws") return "Google News";
        if (tabMode === "vid") return "Google Videos";
        return "Google search";
      }
    }
  } catch {}

  return fallbackDomain;
}

function describeGoal(minutes) {
  return minutes ? `${minutes}m goal` : "No goal";
}

function normalizeSearchText(value) {
  return String(value || "").trim().toLowerCase();
}

function fmtDayLabel(ts) {
  return new Date(ts).toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric"
  });
}

function computeTodayFromSessions(sessions) {
  const todayStart = startOfDay();
  const tomorrowStart = todayStart + 24 * 60 * 60 * 1000;

  const todaySessions = sessions
    .filter((session) => session?.metrics?.start >= todayStart && session.metrics.start < tomorrowStart)
    .sort((a, b) => a.metrics.start - b.metrics.start);

  const totalTimeMs = todaySessions.reduce((sum, session) => sum + (session.metrics?.durationMs || 0), 0);
  const totalVisits = todaySessions.reduce((sum, session) => sum + (session.metrics?.totalVisits || 0), 0);
  const timePerDomain = {};
  const visitsPerDomain = {};
  const latestUrlPerDomain = {};

  for (const session of todaySessions) {
    for (const [domain, ms] of Object.entries(session.metrics?.timePerDomain || {})) {
      if (!isDisplayDomain(domain)) continue;
      timePerDomain[domain] = (timePerDomain[domain] || 0) + ms;
    }

    for (const visit of session.visits || []) {
      if (!isDisplayDomain(visit.domain)) continue;
      visitsPerDomain[visit.domain] = (visitsPerDomain[visit.domain] || 0) + 1;
      if (!latestUrlPerDomain[visit.domain] || visit.time > (latestUrlPerDomain[visit.domain].time || 0)) {
        latestUrlPerDomain[visit.domain] = { url: visit.url, time: visit.time };
      }
    }
  }

  const sortedDomains = Object.entries(timePerDomain).sort((a, b) => b[1] - a[1]);
  const topSite = sortedDomains[0]?.[0] || "-";

  return {
    todaySessions,
    totalTimeMs,
    totalVisits,
    timePerDomain,
    visitsPerDomain,
    latestUrlPerDomain,
    uniqueSiteCount: Object.keys(timePerDomain).length,
    avgSessionMs: todaySessions.length ? Math.round(totalTimeMs / todaySessions.length) : 0,
    topSite
  };
}

function buildLiveSessions(sessions, activeSession, visits) {
  if (!activeSession?.id) return sessions;

  const lastVisit = [...visits]
    .reverse()
    .find((visit) => visit?.sessionId === activeSession.id && isDisplayDomain(visit.domain));

  if (!lastVisit) return sessions;

  const now = Date.now();
  const lastRecordedActiveTime = Math.max(
    lastVisit.time,
    Number(lastVisit.lastActiveTime || lastVisit.firstInteractionTime || lastVisit.time)
  );
  const effectiveEndTime = now;
  const liveTailMs = Math.max(0, effectiveEndTime - lastRecordedActiveTime);
  if (!liveTailMs) return sessions;

  return sessions.map((session) => {
    const sessionId = session?.visits?.[0]?.sessionId;
    if (sessionId !== activeSession.id || !session.metrics) return session;

    const timePerDomain = {
      ...(session.metrics.timePerDomain || {})
    };
    timePerDomain[lastVisit.domain] = (timePerDomain[lastVisit.domain] || 0) + liveTailMs;
    const liveDurationMs = Math.max(0, effectiveEndTime - Number(session.metrics.start || effectiveEndTime));

    return {
      ...session,
      metrics: {
        ...session.metrics,
        end: effectiveEndTime,
        durationMs: liveDurationMs,
        timePerDomain
      }
    };
  });
}

function computeHourlyMinutes(sessions) {
  const todayStart = startOfDay();
  const hourly = new Array(24).fill(0);
  const todayEnd = todayStart + 24 * 60 * 60 * 1000;

  for (const session of sessions) {
    const sessionStart = Number(session?.metrics?.start) || 0;
    const sessionEnd = Number(session?.metrics?.end) || 0;
    if (!sessionStart || sessionEnd <= sessionStart) continue;

    let cursor = Math.max(sessionStart, todayStart);
    const limit = Math.min(sessionEnd, todayEnd);

    while (cursor < limit) {
      const hourIndex = new Date(cursor).getHours();
      const hourEnd = Math.min(startOfDay(cursor) + (hourIndex + 1) * 60 * 60 * 1000, limit);
      hourly[hourIndex] += (hourEnd - cursor) / 60000;
      cursor = hourEnd;
    }
  }

  return hourly;
}

function computeWeekBars(sessions) {
  const days = [];
  const todayStart = startOfDay();
  const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  for (let offset = 6; offset >= 0; offset -= 1) {
    const dayStart = todayStart - offset * 24 * 60 * 60 * 1000;
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;
    const total = sessions.reduce((sum, session) => {
      const start = session?.metrics?.start || 0;
      return start >= dayStart && start < dayEnd ? sum + (session.metrics?.durationMs || 0) : sum;
    }, 0);

    days.push({
      label: weekdayLabels[new Date(dayStart).getDay()],
      minutes: msToMinutes(total)
    });
  }

  return days;
}

function computeHistoryDays(sessions) {
  const todayStart = startOfDay();
  const priorDayStarts = Array.from(
    new Set(
      (sessions || [])
        .map((session) => startOfDay(session?.metrics?.start || 0))
        .filter((dayStart) => dayStart > 0 && dayStart < todayStart)
    )
  ).sort((a, b) => b - a);

  return priorDayStarts.map((dayStart) => {
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;
    const daySessions = sessions.filter((session) => {
      const start = session?.metrics?.start || 0;
      return start >= dayStart && start < dayEnd;
    });

    const totalTimeMs = daySessions.reduce((sum, session) => sum + (session.metrics?.durationMs || 0), 0);
    const totalVisits = daySessions.reduce((sum, session) => sum + (session.metrics?.totalVisits || 0), 0);
    const timePerDomain = {};

    daySessions.forEach((session) => {
      Object.entries(session.metrics?.timePerDomain || {}).forEach(([domain, ms]) => {
        if (!isDisplayDomain(domain)) return;
        timePerDomain[domain] = (timePerDomain[domain] || 0) + ms;
      });
    });

    const sortedDomains = Object.entries(timePerDomain).sort((a, b) => b[1] - a[1]);
    return {
      dayStart,
      label: fmtDayLabel(dayStart),
      sessions: daySessions
        .slice()
        .sort((a, b) => (b?.metrics?.start || 0) - (a?.metrics?.start || 0)),
      sessionCount: daySessions.length,
      totalTimeMs,
      totalVisits,
      uniqueSites: Object.keys(timePerDomain).length,
      topSite: sortedDomains[0]?.[0] || "-",
      topSiteTimeMs: sortedDomains[0]?.[1] || 0
    };
  });
}

function computeTopSiteSequences(sessions, limit = 3, sequenceLength = 3) {
  const counts = new Map();

  const getSequenceSignature = (sequence) => {
    if (
      sequence.length === 3 &&
      sequence[0] === sequence[2] &&
      sequence[0] !== sequence[1]
    ) {
      const pair = [sequence[0], sequence[1]].sort((a, b) => a.localeCompare(b));
      return {
        key: `loop:${pair.join("<->")}`,
        type: "loop",
        pair
      };
    }

    return {
      key: sequence.join(" -> "),
      type: "sequence",
      pair: null
    };
  };

  (sessions || []).forEach((session) => {
    const legitimateDomains = getLegitimateSessionDomains(session);

    if (legitimateDomains.length < sequenceLength) return;

    for (let index = 0; index <= legitimateDomains.length - sequenceLength; index += 1) {
      const sequence = legitimateDomains.slice(index, index + sequenceLength);
      const signature = getSequenceSignature(sequence);
      const existing = counts.get(signature.key) || {
        sequence,
        type: signature.type,
        pair: signature.pair,
        label: signature.type === "loop"
          ? `${signature.pair[0]} ↔ ${signature.pair[1]} loop`
          : sequence.join(" -> "),
        count: 0,
        sessionStarts: new Set()
      };

      existing.count += 1;
      existing.sessionStarts.add(Number(session?.metrics?.start) || 0);
      counts.set(signature.key, existing);
    }
  });

  return Array.from(counts.values())
    .map((entry) => ({
      sequence: entry.sequence,
      type: entry.type,
      pair: entry.pair,
      label: entry.label,
      count: entry.count,
      sessions: entry.sessionStarts.size
    }))
    .sort((a, b) => (
      b.sessions - a.sessions ||
      b.count - a.count ||
      a.label.localeCompare(b.label)
    ))
    .slice(0, limit);
}

function getLegitimateSessionDomains(session) {
  const sessionVisits = Array.isArray(session?.visits) ? session.visits : [];
  const legitimateDomains = [];

  sessionVisits.forEach((visit, index) => {
    if (!isDisplayDomain(visit?.domain)) return;

    const nextVisit = sessionVisits[index + 1];
    const rawEnd = nextVisit?.time ?? session?.metrics?.end ?? visit.time;
    const dwellMs = Math.max(0, Math.min(rawEnd - visit.time, inactivityThresholdMs));
    const isLegitimate = Boolean(visit?.hadInteraction) || dwellMs >= LEGITIMATE_TAB_DWELL_MS;

    if (!isLegitimate) return;
    if (legitimateDomains[legitimateDomains.length - 1] === visit.domain) return;
    legitimateDomains.push(visit.domain);
  });

  return legitimateDomains;
}

function getLegitimateSessionNodes(session) {
  const sessionVisits = Array.isArray(session?.visits) ? session.visits : [];
  const nodes = [];

  sessionVisits.forEach((visit, index) => {
    if (!isDisplayDomain(visit?.domain)) return;

    const nextVisit = sessionVisits[index + 1];
    const rawEnd = nextVisit?.time ?? session?.metrics?.end ?? visit.time;
    const dwellMs = Math.max(0, Math.min(rawEnd - visit.time, inactivityThresholdMs));
    const isLegitimate = Boolean(visit?.hadInteraction) || dwellMs >= LEGITIMATE_TAB_DWELL_MS;
    const label = footprintLabelForVisit(visit);

    if (!isLegitimate || !label) return;
    if (nodes[nodes.length - 1] === label) return;
    nodes.push(label);
  });

  return nodes;
}

function computeFootprintOptions(sessions) {
  const counts = new Map();

  (sessions || []).forEach((session) => {
    getLegitimateSessionNodes(session).forEach((node) => {
      counts.set(node, (counts.get(node) || 0) + 1);
    });
  });

  return Array.from(counts.entries())
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
}

function computeFootprintFlows(sessions, anchorDomain, limit = 5) {
  const incoming = new Map();
  const outgoing = new Map();

  (sessions || []).forEach((session) => {
    const nodes = getLegitimateSessionNodes(session);
    nodes.forEach((node, index) => {
      if (node !== anchorDomain) return;
      const prev = nodes[index - 1];
      const next = nodes[index + 1];

      if (prev && prev !== anchorDomain) incoming.set(prev, (incoming.get(prev) || 0) + 1);
      if (next && next !== anchorDomain) outgoing.set(next, (outgoing.get(next) || 0) + 1);
    });
  });

  const rowsFor = (counts) => Array.from(counts.entries())
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
    .slice(0, limit);

  const incomingRows = rowsFor(incoming);
  const outgoingRows = rowsFor(outgoing);

  return {
    incomingRows,
    outgoingRows,
    strongestIncoming: incomingRows[0] || null,
    strongestOutgoing: outgoingRows[0] || null
  };
}

function renderFootprintBranchChart(items, anchorDomain, direction) {
  if (!items.length) {
    return `<div class="muted">Not enough path data yet for this direction.</div>`;
  }

  const width = 460;
  const height = 320;
  const isIncoming = direction.includes("incoming");
  const anchorX = isIncoming ? 404 : 74;
  const anchorY = isIncoming ? 56 : 266;
  const points = isIncoming
    ? [
        { x: 354, y: 266 },
        { x: 280, y: 214 },
        { x: 232, y: 162 },
        { x: 184, y: 110 },
        { x: 142, y: 70 }
      ]
    : [
        { x: 124, y: 56 },
        { x: 198, y: 108 },
        { x: 246, y: 160 },
        { x: 294, y: 212 },
        { x: 336, y: 252 }
      ];
  const maxCount = Math.max(...items.map((item) => item.count), 1);

  const branches = items.map((item, index) => {
    const point = points[Math.min(index, points.length - 1)];
    const ratio = item.count / maxCount;
    const pathClass = ratio > 0.74 ? "footprintLinkStrong" : ratio > 0.44 ? "footprintLinkMedium" : "footprintLinkLight";
    const dotClass = ratio > 0.74 ? "footprintDotStrong" : ratio > 0.44 ? "footprintDotMedium" : "footprintDotLight";
    const dotRadius = 5 + ratio * 4;
    const labelX = isIncoming ? Math.max(18, point.x - 18) : point.x + 18;
    const labelY = point.y + 2;
    const metaX = labelX;
    const metaY = point.y + 22;
    const control1 = isIncoming
      ? { x: Math.round(anchorX + (point.x - anchorX) * 0.4), y: anchorY + 10 }
      : { x: Math.round(anchorX + (point.x - anchorX) * 0.48), y: anchorY - 10 };
    const control2 = isIncoming
      ? { x: control1.x - 22, y: point.y - 18 }
      : { x: control1.x + 22, y: point.y + 18 };
    const midpoint = cubicBezierPoint(
      { x: anchorX, y: anchorY },
      control1,
      control2,
      { x: point.x, y: point.y },
      0.5
    );
    const midX = Math.round(midpoint.x);
    const midY = Math.round(midpoint.y);
    const pathD = `M ${anchorX} ${anchorY} C ${control1.x} ${control1.y}, ${control2.x} ${control2.y}, ${point.x} ${point.y}`;
    const tooltipSite = escapeHtml(item.domain);
    const tooltipCount = `${item.count} ${item.count === 1 ? "path" : "paths"}`;

    return `
      <path class="footprintLink ${pathClass} footprintHoverTarget" data-footprint-site="${tooltipSite}" data-footprint-count="${tooltipCount}" d="${pathD}"></path>
      <circle class="footprintDot ${dotClass} footprintHoverTarget" data-footprint-site="${tooltipSite}" data-footprint-count="${tooltipCount}" cx="${midX}" cy="${midY}" r="${Math.round(dotRadius * 0.72)}"></circle>
      <circle class="footprintDot ${dotClass} footprintHoverTarget" data-footprint-site="${tooltipSite}" data-footprint-count="${tooltipCount}" cx="${point.x}" cy="${point.y}" r="${Math.round(dotRadius)}"></circle>
      <text class="footprintSvgLabel${isIncoming ? " footprintSvgLabelStart" : ""} footprintHoverTarget" data-footprint-site="${tooltipSite}" data-footprint-count="${tooltipCount}" x="${labelX}" y="${labelY}">${escapeHtml(item.domain)}</text>
      <text class="footprintSvgMeta${isIncoming ? " footprintSvgLabelStart" : ""} footprintHoverTarget" data-footprint-site="${tooltipSite}" data-footprint-count="${tooltipCount}" x="${metaX}" y="${metaY}">${item.count} ${item.count === 1 ? "path" : "paths"}</text>
    `;
  }).join("");

  return `
    <div class="footprintAnchorBadge ${isIncoming ? "footprintAnchorBadgeIncoming" : "footprintAnchorBadgeOutgoing"}">
      <span class="footprintAnchorBadgeTitle">${escapeHtml(anchorDomain)}</span>
      <span class="footprintAnchorBadgeMeta">anchor site</span>
    </div>
    <svg class="footprintSvg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(direction)} for ${escapeHtml(anchorDomain)}">
      ${
        isIncoming
          ? `<path class="footprintAxis" d="M52 34 L${width - 54} 34"></path>
             <path class="footprintAxis" d="M${width - 54} 34 L${width - 54} ${height - 20}"></path>`
          : `<path class="footprintAxis" d="M52 ${anchorY + 18} L${width - 22} ${anchorY + 18}"></path>
             <path class="footprintAxis" d="M52 ${anchorY + 18} L52 30"></path>`
      }
      ${branches}
    </svg>
  `;
}

function attachFootprintTooltips(container) {
  const tooltip = container.querySelector(".footprintTooltip");
  if (!tooltip) return;

  const showTooltip = (event) => {
    const site = event.currentTarget.dataset.footprintSite || "";
    const count = event.currentTarget.dataset.footprintCount || "";
    if (!site && !count) return;
    tooltip.innerHTML = `
      <div class="footprintTooltipTitle">${site}</div>
      <div class="footprintTooltipMeta">${count}</div>
    `;
    tooltip.hidden = false;
    moveTooltip(event);
  };

  const moveTooltip = (event) => {
    if (tooltip.hidden) return;
    const bounds = container.getBoundingClientRect();
    const x = event.clientX - bounds.left + 12;
    const y = event.clientY - bounds.top + 12;
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
  };

  const hideTooltip = () => {
    tooltip.hidden = true;
  };

  container.querySelectorAll(".footprintHoverTarget").forEach((node) => {
    node.addEventListener("mouseenter", showTooltip);
    node.addEventListener("mousemove", moveTooltip);
    node.addEventListener("mouseleave", hideTooltip);
  });
}

function renderFootprintExplorer(sessions) {
  const container = document.getElementById("footprintExplorer");
  const input = document.getElementById("footprintSiteInput");
  const datalist = document.getElementById("footprintSiteOptions");
  if (!container || !input || !datalist) return;

  const options = computeFootprintOptions(sessions);

  if (!options.length) {
    input.value = "";
    input.disabled = true;
    datalist.innerHTML = "";
    container.innerHTML = `<div class="muted">Browse across a few sessions to unlock the digital footprint explorer.</div>`;
    return;
  }

  const optionDomains = new Set(options.map((option) => option.domain));
  if (!optionDomains.has(footprintSelectedDomain)) {
    footprintSelectedDomain = options[0].domain;
  }

  input.disabled = false;
  input.value = footprintSelectedDomain;
  datalist.innerHTML = options
    .map((option) => `<option value="${escapeHtml(option.domain)}"></option>`)
    .join("");

  const { incomingRows, outgoingRows, strongestIncoming, strongestOutgoing } =
    computeFootprintFlows(sessions, footprintSelectedDomain);

  container.innerHTML = `
    <div class="footprintCharts">
      <div class="footprintChart">
        <div class="footprintChartHeader">
          <div class="footprintChartTitle">After ${escapeHtml(footprintSelectedDomain)}</div>
          <div class="footprintChartHint">The most common next stops after this site appears in a session path.</div>
        </div>
        <div class="footprintMapMockup">
          ${renderFootprintBranchChart(outgoingRows, footprintSelectedDomain, "outgoing paths")}
        </div>
      </div>
      <div class="footprintChart">
        <div class="footprintChartHeader">
          <div class="footprintChartTitle">Leading to ${escapeHtml(footprintSelectedDomain)}</div>
          <div class="footprintChartHint">The strongest incoming paths that tend to end at this site.</div>
        </div>
        <div class="footprintMapMockup">
          ${renderFootprintBranchChart(incomingRows, footprintSelectedDomain, "incoming paths")}
        </div>
      </div>
    </div>
    <div class="footprintInsights">
      <div class="footprintInsight">
        <span class="footprintInsightLabel">Most common next stop</span>
        <strong>${strongestOutgoing ? escapeHtml(strongestOutgoing.domain) : "No strong next stop yet"}</strong>
      </div>
      <div class="footprintInsight">
        <span class="footprintInsightLabel">Strongest incoming source</span>
        <strong>${strongestIncoming ? escapeHtml(strongestIncoming.domain) : "No strong source yet"}</strong>
      </div>
    </div>
    <div class="footprintTooltip" hidden></div>
  `;

  attachFootprintTooltips(container);
}

function computeExtendedSessionSites(sessions, limit = 3) {
  const counts = new Map();

  (sessions || []).forEach((session) => {
    const intendedMs = Number(session?.metrics?.intendedMs) || 0;
    const overrunMs = Number(session?.metrics?.overrunMs) || 0;
    const durationMs = Number(session?.metrics?.durationMs) || 0;
    if (intendedMs <= 0 || overrunMs <= 0) return;

    const uniqueDomains = new Set(
      (session?.visits || [])
        .map((visit) => visit?.domain)
        .filter(isDisplayDomain)
    );

    uniqueDomains.forEach((domain) => {
      const existing = counts.get(domain) || {
        domain,
        sessions: 0,
        totalTimeMs: 0
      };

      existing.sessions += 1;
      existing.totalTimeMs += durationMs;
      counts.set(domain, existing);
    });
  });

  return Array.from(counts.values())
    .sort((a, b) => (
      b.sessions - a.sessions ||
      b.totalTimeMs - a.totalTimeMs ||
      a.domain.localeCompare(b.domain)
    ))
    .slice(0, limit);
}

function hourLabel(hour) {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return d.toLocaleTimeString([], { hour: "numeric" }).toLowerCase();
}

function hourWindowLabel(startHour, span = 3) {
  const endHour = (startHour + span) % 24;
  return `${hourLabel(startHour)}-${hourLabel(endHour)}`;
}

function computeTimeOfDayTrends(sessions) {
  const hourly = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    label: hourLabel(hour),
    sessions: 0,
    totalTimeMs: 0,
    totalVisits: 0,
    avgDurationMs: 0,
    avgVisits: 0,
    goalSessions: 0,
    overrunSessions: 0,
    overrunRate: 0
  }));

  (sessions || []).forEach((session) => {
    const start = Number(session?.metrics?.start) || 0;
    const durationMs = Number(session?.metrics?.durationMs) || 0;
    const totalVisits = Number(session?.metrics?.totalVisits) || 0;
    const intendedMs = Number(session?.metrics?.intendedMs) || 0;
    const overrunMs = Number(session?.metrics?.overrunMs) || 0;
    if (!start) return;

    const bucket = hourly[new Date(start).getHours()];
    bucket.sessions += 1;
    bucket.totalTimeMs += durationMs;
    bucket.totalVisits += totalVisits;
    if (intendedMs > 0) {
      bucket.goalSessions += 1;
      if (overrunMs > 0) {
        bucket.overrunSessions += 1;
      }
    }
  });

  hourly.forEach((bucket) => {
    bucket.avgDurationMs = bucket.sessions ? Math.round(bucket.totalTimeMs / bucket.sessions) : 0;
    bucket.avgVisits = bucket.sessions ? Math.round((bucket.totalVisits / bucket.sessions) * 10) / 10 : 0;
    bucket.overrunRate = bucket.goalSessions ? bucket.overrunSessions / bucket.goalSessions : 0;
  });

  const topHours = [...hourly]
    .filter((bucket) => bucket.sessions > 0)
    .sort((a, b) => (
      b.sessions - a.sessions ||
      b.totalTimeMs - a.totalTimeMs ||
      a.hour - b.hour
    ))
    .slice(0, 3);

  const longestSessionHour = [...hourly]
    .filter((bucket) => bucket.sessions > 0)
    .sort((a, b) => (
      b.avgDurationMs - a.avgDurationMs ||
      b.sessions - a.sessions ||
      a.hour - b.hour
    ))[0] || null;

  const overrunProneHour = [...hourly]
    .filter((bucket) => bucket.goalSessions > 0)
    .sort((a, b) => (
      b.overrunRate - a.overrunRate ||
      b.overrunSessions - a.overrunSessions ||
      b.goalSessions - a.goalSessions ||
      a.hour - b.hour
    ))[0] || null;

  const activeWindows = hourly.map((bucket, startHour) => {
    let sessionsInWindow = 0;
    let totalTimeMs = 0;

    for (let offset = 0; offset < 3; offset += 1) {
      const windowBucket = hourly[(startHour + offset) % 24];
      sessionsInWindow += windowBucket.sessions;
      totalTimeMs += windowBucket.totalTimeMs;
    }

    return {
      startHour,
      label: hourWindowLabel(startHour, 3),
      sessions: sessionsInWindow,
      totalTimeMs
    };
  });

  const mostCommonActiveWindow = activeWindows
    .filter((window) => window.sessions > 0)
    .sort((a, b) => (
      b.sessions - a.sessions ||
      b.totalTimeMs - a.totalTimeMs ||
      a.startHour - b.startHour
    ))[0] || null;

  return { hourly, topHours, longestSessionHour, overrunProneHour, mostCommonActiveWindow };
}

function formatSequencePath(sequence) {
  return sequence.map(escapeHtml).join(' <span class="sequenceArrow">→</span> ');
}

function buildLinePath(points) {
  if (!points.length) return "";
  return points.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" ");
}

function attachChartTooltips(container, selector) {
  const tooltip = container.querySelector(".chartTooltip");
  if (!tooltip) return;

  const showTooltip = (event) => {
    const target = event.currentTarget;
    tooltip.textContent = target.dataset.tooltip || "";
    tooltip.hidden = false;

    const rect = container.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${Math.max(12, y - 14)}px`;
  };

  const hideTooltip = () => {
    tooltip.hidden = true;
  };

  container.querySelectorAll(selector).forEach((node) => {
    node.addEventListener("mouseenter", showTooltip);
    node.addEventListener("mousemove", showTooltip);
    node.addEventListener("mouseleave", hideTooltip);
  });
}

function renderActivityChart(values) {
  const container = document.getElementById("activityChart");
  const totalMinutes = values.reduce((sum, value) => sum + value, 0);
  document.getElementById("activityTotal").textContent = msToPretty(totalMinutes * 60000);
  const width = 640;
  const height = 270;
  const padding = { top: 18, right: 10, bottom: 38, left: 42 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(10, Math.ceil(Math.max(...values, 0) / 10) * 10);
  const tickValues = Array.from({ length: maxValue / 10 + 1 }, (_, index) => index * 10);
  const points = values.map((value, index) => {
    const x = padding.left + (index / 23) * innerWidth;
    const y = padding.top + innerHeight - (value / maxValue) * innerHeight;
    return { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) };
  });
  const linePath = buildLinePath(points);
  const areaPath = `${linePath} L ${padding.left + innerWidth} ${padding.top + innerHeight} L ${padding.left} ${padding.top + innerHeight} Z`;

  const gridLines = tickValues
    .map((tick) => {
      const y = padding.top + innerHeight - (tick / maxValue) * innerHeight;
      return `
        <line class="gridLine" x1="${padding.left}" y1="${y}" x2="${padding.left + innerWidth}" y2="${y}"></line>
        <text class="tickLabel" x="${padding.left - 8}" y="${y + 4}" text-anchor="end">${tick}m</text>
      `;
    })
    .join("");

  const xLabels = values
    .map((_, index) => {
      if (index % 3 !== 0) return "";
      const x = padding.left + (index / 23) * innerWidth;
      const d = new Date();
      d.setHours(index, 0, 0, 0);
      const label = d.toLocaleTimeString([], { hour: "numeric" }).toLowerCase();
      return `<text class="axisLabel" x="${x}" y="${height - 10}" text-anchor="middle">${label}</text>`;
    })
    .join("");

  const pointMarkers = points
    .map((point, index) => {
      const d = new Date();
      d.setHours(index, 0, 0, 0);
      const label = d.toLocaleTimeString([], { hour: "numeric" }).toLowerCase();
      return `
        <circle
          class="linePoint"
          cx="${point.x}"
          cy="${point.y}"
          r="5"
          data-tooltip="${label}: ${msToPretty(values[index] * 60000)}"
        ></circle>
      `;
    })
    .join("");

  container.innerHTML = `
    <svg class="chartSvg" viewBox="0 0 ${width} ${height}" role="img">
      <defs>
        <linearGradient id="activityFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#a76cf0" stop-opacity="0.28"></stop>
          <stop offset="100%" stop-color="#a76cf0" stop-opacity="0.02"></stop>
        </linearGradient>
      </defs>
      ${gridLines}
      ${xLabels}
      <path class="lineArea" d="${areaPath}"></path>
      <path class="linePath" d="${linePath}"></path>
      ${pointMarkers}
    </svg>
    <div class="chartTooltip" hidden></div>
  `;

  attachChartTooltips(container, ".linePoint");
}

function renderWeekChart(days) {
  const container = document.getElementById("weekChart");
  const width = 640;
  const height = 260;
  const padding = { top: 12, right: 8, bottom: 34, left: 38 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(180, ...days.map((day) => day.minutes), 1);
  const slotWidth = innerWidth / days.length;
  const barWidth = Math.max(28, slotWidth - 8);
  const tickValues = [60, 120, 180];

  const gridLines = tickValues
    .map((tick) => {
      const y = padding.top + innerHeight - (tick / maxValue) * innerHeight;
      return `
        <line class="gridLine" x1="${padding.left}" y1="${y}" x2="${padding.left + innerWidth}" y2="${y}"></line>
        <text class="tickLabel" x="${padding.left - 8}" y="${y + 4}" text-anchor="end">${minutesToHourLabel(tick)}</text>
      `;
    })
    .join("");

  const bars = days
    .map((day, index) => {
      const x = padding.left + index * slotWidth + (slotWidth - barWidth) / 2;
      const barHeight = (day.minutes / maxValue) * innerHeight;
      const y = padding.top + innerHeight - barHeight;
      return `
        <rect
          class="barRect"
          x="${x}"
          y="${y}"
          width="${barWidth}"
          height="${barHeight}"
          rx="8"
          data-tooltip="${day.label}: ${msToPretty(day.minutes * 60000)}"
        ></rect>
        <text class="axisLabel" x="${x + barWidth / 2}" y="${height - 10}" text-anchor="middle">${day.label}</text>
      `;
    })
    .join("");

  container.innerHTML = `
    <svg class="chartSvg" viewBox="0 0 ${width} ${height}" role="img">
      <defs>
        <linearGradient id="weekBarFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#9b5cf2"></stop>
          <stop offset="100%" stop-color="#7d34d8"></stop>
        </linearGradient>
      </defs>
      ${gridLines}
      ${bars}
    </svg>
    <div class="chartTooltip" hidden></div>
  `;

  attachChartTooltips(container, ".barRect");
}

function polarPoint(cx, cy, radius, angle) {
  return {
    x: cx + radius * Math.cos(angle),
    y: cy + radius * Math.sin(angle)
  };
}

function ringSlicePath(cx, cy, innerRadius, outerRadius, startAngle, endAngle) {
  const outerStart = polarPoint(cx, cy, outerRadius, startAngle);
  const outerEnd = polarPoint(cx, cy, outerRadius, endAngle);
  const innerEnd = polarPoint(cx, cy, innerRadius, endAngle);
  const innerStart = polarPoint(cx, cy, innerRadius, startAngle);
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;

  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y}`,
    "Z"
  ].join(" ");
}

function cubicBezierPoint(start, control1, control2, end, t) {
  const mt = 1 - t;
  return {
    x: mt ** 3 * start.x + 3 * mt ** 2 * t * control1.x + 3 * mt * t ** 2 * control2.x + t ** 3 * end.x,
    y: mt ** 3 * start.y + 3 * mt ** 2 * t * control1.y + 3 * mt * t ** 2 * control2.y + t ** 3 * end.y
  };
}

function renderDistributionChart(timePerDomain) {
  const container = document.getElementById("distributionChart");
  const rows = Object.entries(timePerDomain)
    .filter(([, ms]) => Number.isFinite(ms) && ms > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  if (!rows.length) {
    container.innerHTML = `<div class="muted">No site time yet today.</div>`;
    return;
  }

  const total = rows.reduce((sum, [, ms]) => sum + ms, 0);
  if (!Number.isFinite(total) || total <= 0) {
    container.innerHTML = `<div class="muted">No site time yet today.</div>`;
    return;
  }

  const cx = 110;
  const cy = 110;
  const outer = 70;
  const inner = 38;
  let angle = -Math.PI / 2;

  const slices = rows
    .map(([domain, ms], index) => {
      const sliceAngle = (ms / total) * Math.PI * 2;
      const start = angle;
      const end = angle + sliceAngle;
      angle = end;
      return `
        <path
          class="distributionSlice"
          d="${ringSlicePath(cx, cy, inner, outer, start, end)}"
          fill="${DISTRIBUTION_COLORS[index % DISTRIBUTION_COLORS.length]}"
          data-tooltip="${domain}: ${msToPretty(ms)} (${Math.round((ms / total) * 100)}%)"
        ></path>
      `;
    })
    .join("");

  const legend = rows
    .map(
      ([domain, ms], index) => `
        <span class="legendRow">
          <span class="legendSwatch" style="background:${DISTRIBUTION_COLORS[index % DISTRIBUTION_COLORS.length]}"></span>
          <span class="legendLabel">${escapeHtml(domain)}</span>
          <span class="legendValue">${Math.round((ms / total) * 100)}%</span>
        </span>
      `
    )
    .join("");

  container.innerHTML = `
    <svg class="chartSvg" viewBox="0 0 220 220" role="img" style="max-width:220px;">
      ${slices}
      <circle cx="${cx}" cy="${cy}" r="${inner - 2}" fill="white" fill-opacity="0.95"></circle>
    </svg>
    <div class="legendList">${legend}</div>
    <div class="chartTooltip" hidden></div>
  `;

  attachChartTooltips(container, ".distributionSlice");
}

function renderCurrentSession(activeSession, visits = []) {
  const progressContainer = document.getElementById("sessionProgressChart");
  const sitesList = document.getElementById("sitesList");
  const sessionSites = document.getElementById("sessionSites");
  const sessionVisitsCount = document.getElementById("sessionVisits");
  const currentSessionName = document.getElementById("currentSessionName");
  const sessionGoal = document.getElementById("sessionGoal");

  if (!activeSession) {
    progressContainer.innerHTML = buildProgressSvg("0:00", "No goal", 0);
    sitesList.textContent = "No session yet.";
    sessionSites.textContent = "0 sites";
    sessionVisitsCount.textContent = "0 visits";
    currentSessionName.textContent = "Session Name: No active session";
    currentSessionName.dataset.sessionId = "";
    currentSessionName.dataset.sessionStart = "";
    currentSessionName.dataset.sessionName = "";
    currentSessionName.classList.remove("sessionNameEditable");
    sessionGoal.textContent = "Goal: -";
    return;
  }

  const now = Date.now();
  const currentSessionVisits = (visits || []).filter(
    (visit) => visit?.sessionId === activeSession.id && isDisplayDomain(visit.domain)
  );
  const validDomains = Array.from(new Set(currentSessionVisits.map((visit) => visit.domain)));
  const visitUrls = new Map();
  currentSessionVisits.forEach((visit) => {
    if (!visitUrls.has(visit.domain)) {
      visitUrls.set(visit.domain, visit.url);
    }
  });
  const siteChips = validDomains.length
    ? validDomains
        .slice(0, 4)
        .map(
          (domain) => `
            <a
              class="siteChip"
              href="${hrefForVisit(visitUrls.get(domain), domain)}"
              target="_blank"
              rel="noopener noreferrer"
            >
              <img src="${resolveFaviconSrc(currentSessionVisits.find((visit) => visit.domain === domain) || domain, 32)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden';" />
              <span class="siteChipLabel">${escapeHtml(domain)}</span>
            </a>
          `
        )
        .join("")
    : "No sites yet.";

  const effectiveEndTime = now;
  const elapsedMs = Math.max(0, effectiveEndTime - activeSession.startTime);
  const goalMinutes = activeSession.intendedMinutes;
  const ringBasisMinutes = goalMinutes || 30;
  const ratio = elapsedMs / (ringBasisMinutes * 60 * 1000);

  progressContainer.innerHTML = buildProgressSvg(
    fmtElapsed(elapsedMs),
    goalMinutes ? `${goalMinutes}m` : "free",
    ratio,
    goalMinutes != null
  );
  sitesList.innerHTML = siteChips;
  sessionSites.textContent = `${validDomains.length} ${validDomains.length === 1 ? "site" : "sites"}`;
  sessionVisitsCount.textContent = `${currentSessionVisits.length} visits`;
  currentSessionName.classList.add("sessionNameEditable");
  currentSessionName.textContent = `Session Name: ${describeSessionName(activeSession.sessionName)}`;
  currentSessionName.dataset.sessionId = activeSession.id || "";
  currentSessionName.dataset.sessionStart = String(activeSession.startTime || "");
  currentSessionName.dataset.sessionName = activeSession.sessionName || "";
  sessionGoal.textContent = `Goal: ${describeGoal(goalMinutes)}`;
}

function renderCurrentSessionData(activeSession, visits) {
  const container = document.getElementById("currentSessionData");

  if (!activeSession) {
    container.innerHTML = `<div class="muted">No session yet.</div>`;
    return;
  }

  const sessionVisits = (visits || [])
    .filter((visit) => visit?.sessionId === activeSession.id && isDisplayDomain(visit.domain))
    .sort((a, b) => b.time - a.time);

  if (!sessionVisits.length) {
    container.innerHTML = `<div class="muted">No sites recorded in the current session yet.</div>`;
    return;
  }

  container.innerHTML = `
    <div class="sessionDetailsList">
      ${sessionVisits
        .map(
          (visit) => `
            <div class="sessionVisitRow">
              <div class="sessionVisitMain">
                <img src="${resolveFaviconSrc(visit, 32)}" alt="" class="siteFavicon" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden';" />
                <a
                  class="sessionVisitDomain"
                  href="${hrefForVisit(visit, visit.domain)}"
                  target="_blank"
                  rel="noopener noreferrer"
                >${escapeHtml(displayLabelForVisit(visit))}</a>
              </div>
              <div class="sessionVisitTime">${fmtTime(visit.time)}</div>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function buildProgressSvg(valueLabel, goalLabel, ratio, hasGoal = true) {
  const size = 160;
  const cx = size / 2;
  const cy = size / 2;
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - Math.max(0, Math.min(1, ratio)));
  const isOverGoal = hasGoal && ratio > 1;
  const accent = isOverGoal ? "#dc2626" : "#7d34d8";
  const track = isOverGoal ? "rgba(220, 38, 38, 0.12)" : "rgba(125, 52, 216, 0.12)";

  return `
    <svg class="chartSvg" viewBox="0 0 ${size} ${size}" role="img">
      <circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${track}" stroke-width="10"></circle>
      <circle
        cx="${cx}"
        cy="${cy}"
        r="${radius}"
        fill="none"
        stroke="${accent}"
        stroke-width="10"
        stroke-linecap="round"
        stroke-dasharray="${circumference}"
        stroke-dashoffset="${dashOffset}"
        transform="rotate(-90 ${cx} ${cy})"
      ></circle>
      <text class="progressValue" x="${cx}" y="${cy + 4}">${valueLabel}</text>
      <text class="progressGoal" x="${cx}" y="${cy + 24}">/ ${goalLabel}</text>
    </svg>
  `;
}

function buildSessionVisitsHtml(visits = []) {
  return visits
    .filter((visit) => isDisplayDomain(visit.domain))
    .slice()
    .sort((a, b) => b.time - a.time)
    .map(
      (visit) => `
        <div class="sessionVisitRow">
          <div class="sessionVisitMain">
            <img src="${resolveFaviconSrc(visit, 32)}" alt="" class="siteFavicon" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden';" />
            <a
              class="sessionVisitDomain"
              href="${hrefForVisit(visit, visit.domain)}"
              target="_blank"
              rel="noopener noreferrer"
            >${escapeHtml(displayLabelForVisit(visit))}</a>
          </div>
          <div class="sessionVisitTime">${fmtTime(visit.time)}</div>
        </div>
      `
    )
    .join("");
}

function buildGoalBadgeHtml(metrics = {}) {
  const goal = metrics.intendedMinutes;
  const overrunMs = metrics.overrunMs || 0;
  const overrunMinutes = msToMinutes(overrunMs);

  if (!goal) return "";

  if (overrunMinutes > 0) {
    return `
      <div class="badgeStack">
        <div class="goalBadge">${goal}m goal</div>
        <div class="overrunBadge">${overrunMinutes}m over</div>
      </div>
    `;
  }

  return `<div class="goalBadge">${goal}m goal</div>`;
}

function buildTrashIcon() {
  return `
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3.5 4.5h9"></path>
      <path d="M6.5 2.5h3"></path>
      <path d="M5 4.5v7"></path>
      <path d="M8 4.5v7"></path>
      <path d="M11 4.5v7"></path>
      <path d="M4.5 4.5l.5 8h6l.5-8"></path>
    </svg>
  `;
}

async function updateSessionName(sessionId, sessionStart, sessionName) {
  const normalizedName = normalizeSessionName(sessionName);
  const {
    activeSession,
    analyticsActiveSession,
    sessionIntents = [],
    analyticsSessionIntents = []
  } = await chrome.storage.local.get([
    "activeSession",
    "analyticsActiveSession",
    "sessionIntents",
    "analyticsSessionIntents"
  ]);

  const upsertIntentName = (intents, fallbackMinutes = null) => {
    const next = Array.isArray(intents) ? intents.slice() : [];
    const matchIndex = next.findIndex((intent) => (
      String(intent?.sessionId || "") === String(sessionId || "") ||
      Number(intent?.startTime || 0) === Number(sessionStart || 0)
    ));

    if (!normalizedName) {
      if (matchIndex >= 0) {
        const existing = next[matchIndex];
        if (existing?.intendedMinutes == null) {
          next.splice(matchIndex, 1);
        } else {
          next[matchIndex] = { ...existing, sessionName: "" };
        }
      }
      return next;
    }

    if (matchIndex >= 0) {
      next[matchIndex] = {
        ...next[matchIndex],
        sessionName: normalizedName
      };
      return next;
    }

    next.push({
      sessionId,
      startTime: sessionStart,
      intendedMinutes: fallbackMinutes,
      sessionName: normalizedName
    });
    return next;
  };

  const nextActiveSession =
    activeSession &&
    (
      String(activeSession.id || "") === String(sessionId || "") ||
      Number(activeSession.startTime || 0) === Number(sessionStart || 0)
    )
      ? { ...activeSession, sessionName: normalizedName }
      : activeSession;

  const nextAnalyticsActiveSession =
    analyticsActiveSession &&
    (
      String(analyticsActiveSession.id || "") === String(sessionId || "") ||
      Number(analyticsActiveSession.startTime || 0) === Number(sessionStart || 0)
    )
      ? { ...analyticsActiveSession, sessionName: normalizedName }
      : analyticsActiveSession;

  await chrome.storage.local.set({
    activeSession: nextActiveSession || null,
    analyticsActiveSession: nextAnalyticsActiveSession || null,
    sessionIntents: upsertIntentName(sessionIntents, nextActiveSession?.intendedMinutes ?? null),
    analyticsSessionIntents: upsertIntentName(analyticsSessionIntents, nextAnalyticsActiveSession?.intendedMinutes ?? null)
  });

  chrome.runtime.sendMessage({ type: "rebuildSessions" }, () => {});
  await refresh();
}

async function deleteSessionData(sessionId, sessionStart) {
  const sessionIdString = String(sessionId || "");
  const sessionStartNumber = Number(sessionStart || 0);
  const {
    activeSession,
    visits = [],
    sessionIntents = [],
    manualSessionStarts = [],
    lastUserActivityAt
  } = await chrome.storage.local.get([
    "activeSession",
    "visits",
    "sessionIntents",
    "manualSessionStarts",
    "lastUserActivityAt"
  ]);

  const matchesSession = (valueSessionId, valueStartTime) => (
    (sessionIdString && String(valueSessionId || "") === sessionIdString) ||
    (sessionStartNumber && Number(valueStartTime || 0) === sessionStartNumber)
  );

  const keptVisits = visits.filter((visit) => !matchesSession(visit?.sessionId, visit?.sessionStartTime));
  const keptIntents = sessionIntents.filter((intent) => !matchesSession(intent?.sessionId, intent?.startTime));
  const keptManualStarts = manualSessionStarts.filter((ts) => Number(ts) !== sessionStartNumber);
  const shouldClearActiveSession = activeSession && matchesSession(activeSession.id, activeSession.startTime);

  await chrome.storage.local.set({
    visits: keptVisits,
    sessions: [],
    activeSession: shouldClearActiveSession ? null : activeSession || null,
    sessionIntents: keptIntents,
    manualSessionStarts: keptManualStarts,
    lastUserActivityAt: shouldClearActiveSession ? Date.now() : lastUserActivityAt
  });

  chrome.runtime.sendMessage({ type: "rebuildSessions" }, () => {});
  setStatusText("clearDataStatus", "That session was removed from dashboard history. Analytics data was kept.");
  await refresh();
}

function promptRenameSession(node) {
  const sessionId = node.dataset.sessionId || "";
  const sessionStart = Number(node.dataset.sessionStart || 0);
  if (!sessionId && !sessionStart) return;
  const currentName = node.dataset.sessionName || "";
  const nextName = window.prompt("Name this session:", currentName);
  if (nextName == null) return;
  return updateSessionName(sessionId, sessionStart, nextName);
}

function renderSessionsList(sessions) {
  const container = document.getElementById("sessionsList");
  const todayStart = startOfDay();
  const todaySessions = [...sessions]
    .filter((session) => session?.metrics)
    .filter((session) => (session.metrics?.start || 0) >= todayStart)
    .sort((a, b) => b.metrics.start - a.metrics.start)
    .slice(0, 6);

  document.getElementById("recentSessionsCount").textContent = `${todaySessions.length} sessions today`;

  if (!todaySessions.length) {
    container.innerHTML = `<div class="muted">No sessions yet today. Browse a bit and come back.</div>`;
    return;
  }

  const sessionKeys = todaySessions.map((session) => String(session.metrics.start));
  const existingRows = Array.from(container.querySelectorAll(".sessionRow"));
  const canPatch =
    existingRows.length === todaySessions.length &&
    existingRows.every((row, index) => row.dataset.sessionStart === sessionKeys[index]);

  if (canPatch) {
    todaySessions.forEach((session, index) => {
      const row = existingRows[index];
      const validUniqueDomains = (session.metrics.uniqueDomains || []).filter(isDisplayDomain);
      const badgeSlot = row.querySelector(".sessionBadgeSlot");
      const detailsList = row.querySelector(".sessionDetailsList");
      const nameNode = row.querySelector(".sessionName");
      const visitsHtml = buildSessionVisitsHtml(session.visits || []);
      row.querySelector(".sessionTime").textContent =
        `${fmtTime(session.metrics.start)} - ${fmtTime(session.metrics.end)}`;
      if (nameNode) {
        nameNode.textContent = describeSessionName(session.metrics.sessionName);
        nameNode.classList.add("sessionNameEditable");
        nameNode.dataset.sessionId = session.visits?.[0]?.sessionId || session.id || "";
        nameNode.dataset.sessionStart = String(session.metrics.start);
        nameNode.dataset.sessionName = session.metrics.sessionName || "";
      }
      const deleteButton = row.querySelector(".sessionDeleteBtn");
      if (deleteButton) {
        deleteButton.dataset.sessionId = session.visits?.[0]?.sessionId || session.id || "";
        deleteButton.dataset.sessionStart = String(session.metrics.start);
        deleteButton.dataset.sessionName = session.metrics.sessionName || "";
      }

      const meta = row.querySelectorAll(".sessionMeta span");
      if (meta[0]) meta[0].textContent = sessionDurationLabel(session.metrics);
      if (meta[1]) meta[1].textContent = `${validUniqueDomains.length} sites`;
      if (meta[2]) meta[2].textContent = `${session.metrics.totalVisits || 0} visits`;
      if (badgeSlot) {
        badgeSlot.innerHTML = buildGoalBadgeHtml(session.metrics);
      }
      if (detailsList) {
        detailsList.innerHTML = visitsHtml || '<div class="muted">No visits recorded.</div>';
      }
    });
    return;
  }

  container.innerHTML = todaySessions
    .map((session) => {
      const startStr = fmtTime(session.metrics.start);
      const endStr = fmtTime(session.metrics.end);
      const sessionKey = session.metrics.start;
      const goal = session.metrics.intendedMinutes;
      const isExpanded = expandedSessionStarts.has(sessionKey);
      const validUniqueDomains = (session.metrics.uniqueDomains || []).filter(isDisplayDomain);
      const visitsHtml = buildSessionVisitsHtml(session.visits || []);

      return `
        <div class="sessionRow" data-session-start="${sessionKey}">
          <div class="sessionHeader">
            <div class="sessionRowActions">
              <button type="button" class="sessionToggle" aria-expanded="${isExpanded}">
                <div class="sessionHeader">
                  <div>
                    <div class="sessionTime">${startStr} - ${endStr}</div>
                    <div
                      class="sessionName sessionNameEditable"
                      data-session-id="${escapeHtml(session.visits?.[0]?.sessionId || session.id || "")}"
                      data-session-start="${session.metrics.start}"
                      data-session-name="${escapeHtml(session.metrics.sessionName || "")}"
                    >${escapeHtml(describeSessionName(session.metrics.sessionName))}</div>
                  </div>
                  <div class="sessionHeaderRight">
                    <div class="sessionBadgeSlot">${buildGoalBadgeHtml(session.metrics)}</div>
                  </div>
                </div>
              </button>
              <div class="sessionActionRail">
                <button
                  type="button"
                  class="sessionExpandBtn"
                  data-session-start="${session.metrics.start}"
                  aria-expanded="${isExpanded}"
                  aria-label="${isExpanded ? "Collapse" : "Expand"} session details"
                ><span class="sessionChevron">${isExpanded ? "−" : "+"}</span></button>
                <button
                  type="button"
                  class="sessionDeleteBtn"
                  data-session-id="${escapeHtml(session.visits?.[0]?.sessionId || session.id || "")}"
                  data-session-start="${session.metrics.start}"
                  data-session-name="${escapeHtml(describeSessionName(session.metrics.sessionName))}"
                  aria-label="Delete ${escapeHtml(describeSessionName(session.metrics.sessionName))}"
                >${buildTrashIcon()}</button>
              </div>
            </div>
          </div>
          <div class="sessionMeta">
            <span>${sessionDurationLabel(session.metrics)}</span>
            <span>${validUniqueDomains.length} sites</span>
            <span>${session.metrics.totalVisits || 0} visits</span>
          </div>
          <div class="sessionDetails" ${isExpanded ? "" : "hidden"}>
            <div class="sessionDetailsList">
              ${visitsHtml || '<div class="muted">No visits recorded.</div>'}
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  container.querySelectorAll(".sessionToggle").forEach((button) => {
    button.addEventListener("click", () => {
      const row = button.closest(".sessionRow");
      const sessionKey = Number(row.dataset.sessionStart);
      const details = row.querySelector(".sessionDetails");
      const chevron = row.querySelector(".sessionChevron");
      const expandButton = row.querySelector(".sessionExpandBtn");
      const nextExpanded = details.hidden;

      details.hidden = !nextExpanded;
      button.setAttribute("aria-expanded", String(nextExpanded));
      if (expandButton) {
        expandButton.setAttribute("aria-expanded", String(nextExpanded));
        expandButton.setAttribute("aria-label", `${nextExpanded ? "Collapse" : "Expand"} session details`);
      }
      chevron.textContent = nextExpanded ? "−" : "+";

      if (nextExpanded) {
        expandedSessionStarts.add(sessionKey);
      } else {
        expandedSessionStarts.delete(sessionKey);
      }
    });
  });

  container.querySelectorAll(".sessionExpandBtn").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const row = button.closest(".sessionRow");
      const toggle = row.querySelector(".sessionToggle");
      if (toggle) toggle.click();
    });
  });

  container.querySelectorAll(".sessionNameEditable").forEach((node) => {
    node.addEventListener("click", async (event) => {
      event.stopPropagation();
      await promptRenameSession(node);
    });
  });

  container.querySelectorAll(".sessionDeleteBtn").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const sessionId = button.dataset.sessionId || "";
      const sessionStart = Number(button.dataset.sessionStart || 0);
      const sessionName = button.dataset.sessionName || "this session";
      const confirmed = window.confirm(`Delete ${sessionName} from dashboard history? Analytics data will be kept.`);
      if (!confirmed) return;
      await deleteSessionData(sessionId, sessionStart);
    });
  });
}

function renderTopSitesToday(timePerDomain, visitsPerDomain, latestUrlPerDomain = {}) {
  const container = document.getElementById("topSitesList");
  const rows = Object.entries(timePerDomain)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  if (!rows.length) {
    container.innerHTML = `<div class="muted">No site time yet today.</div>`;
    return;
  }

  const domains = rows.map(([domain]) => domain);
  const existingRows = Array.from(container.querySelectorAll(".siteRow"));
  const canPatch =
    existingRows.length === rows.length &&
    existingRows.every((row, index) => row.dataset.domain === domains[index]);

  if (canPatch) {
    rows.forEach(([domain, ms], index) => {
      const row = existingRows[index];
      const meta = row.querySelector(".siteMeta");
      const time = row.querySelector(".siteTime");
      if (meta) meta.textContent = `${visitsPerDomain[domain] || 0} visits`;
      if (time) time.textContent = msToPretty(ms);
    });
    return;
  }

  container.innerHTML = rows
    .map(([domain, ms], index) => `
      <div class="siteRow" data-domain="${domain}">
        <div class="siteRank">${index + 1}</div>
        <div class="siteMain">
          <img src="${resolveFaviconSrc({ domain, url: latestUrlPerDomain[domain]?.url }, 32)}" alt="" class="siteFavicon" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden';" />
          <div>
            <a class="siteName" href="${hrefForVisit(latestUrlPerDomain[domain]?.url, domain)}" target="_blank" rel="noopener noreferrer">${escapeHtml(domain)}</a>
            <div class="siteMeta">${visitsPerDomain[domain] || 0} visits</div>
          </div>
        </div>
        <div class="siteTime">${msToPretty(ms)}</div>
      </div>
    `)
    .join("");
}

function renderHistoryList(sessions) {
  const container = document.getElementById("historyList");
  const query = normalizeSearchText(historySearchQuery);
  const rows = computeHistoryDays(sessions)
    .map((day) => {
      if (!query) return day;

      const dayMatches = normalizeSearchText(day.label).includes(query);
      const filteredSessions = day.sessions.filter((session) => {
        const sessionName = describeSessionName(session?.metrics?.sessionName);
        const sitesText = (session?.visits || [])
          .filter((visit) => isDisplayDomain(visit?.domain))
          .map((visit) => `${visit.domain} ${displayLabelForVisit(visit)}`)
          .join(" ");
        const sessionText = normalizeSearchText(sessionName);
        const siteText = normalizeSearchText(sitesText);
        const dateText = normalizeSearchText([
          day.label,
          fmtTime(session?.metrics?.start || 0),
          fmtTime(session?.metrics?.end || 0)
        ].join(" "));

        if (historySearchScope === "session") return sessionText.includes(query);
        if (historySearchScope === "site") return siteText.includes(query);
        if (historySearchScope === "date") return dateText.includes(query);

        return [sessionText, siteText, dateText].some((value) => value.includes(query));
      });

      const visibleSessions =
        historySearchScope === "date"
          ? (dayMatches ? day.sessions : filteredSessions)
          : filteredSessions;
      if (!visibleSessions.length) return null;

      const visibleTimePerDomain = {};
      visibleSessions.forEach((session) => {
        Object.entries(session.metrics?.timePerDomain || {}).forEach(([domain, ms]) => {
          if (!isDisplayDomain(domain)) return;
          visibleTimePerDomain[domain] = (visibleTimePerDomain[domain] || 0) + ms;
        });
      });
      const sortedDomains = Object.entries(visibleTimePerDomain).sort((a, b) => b[1] - a[1]);

      return {
        ...day,
        sessions: visibleSessions,
        sessionCount: visibleSessions.length,
        totalTimeMs: visibleSessions.reduce((sum, session) => sum + (session.metrics?.durationMs || 0), 0),
        totalVisits: visibleSessions.reduce((sum, session) => sum + (session.metrics?.totalVisits || 0), 0),
        uniqueSites: Object.keys(visibleTimePerDomain).length,
        topSite: sortedDomains[0]?.[0] || "-"
      };
    })
    .filter((day) => day && (day.totalTimeMs > 0 || day.sessionCount > 0));

  if (!rows.length) {
    container.innerHTML = `<div class="muted">${
      query
        ? "No history sessions matched that search."
        : "No previous-day history yet."
    }</div>`;
    return;
  }

  container.innerHTML = rows
    .map(
      (day) => `
        <div class="historyRow">
          <button type="button" class="historyToggle" aria-expanded="${expandedHistoryDays.has(day.dayStart)}">
            <div class="historyRowMain">
              <div class="historyDay">
                <div class="historyDate">${day.label}</div>
                <div class="historyTopSite">Top site: ${escapeHtml(day.topSite)}</div>
              </div>
              <div class="historyStats">
                <div class="historyStat">
                  <strong>${msToPretty(day.totalTimeMs)}</strong>
                  <span>Tracked time</span>
                </div>
                <div class="historyStat">
                  <strong>${day.sessionCount}</strong>
                  <span>Sessions</span>
                </div>
                <div class="historyStat">
                  <strong>${day.totalVisits}</strong>
                  <span>Visits</span>
                </div>
                <div class="historyStat">
                  <strong>${day.uniqueSites}</strong>
                  <span>Sites</span>
                </div>
                <span class="sessionChevron">${expandedHistoryDays.has(day.dayStart) ? "−" : "+"}</span>
              </div>
            </div>
          </button>
          <div class="historyDetails" ${expandedHistoryDays.has(day.dayStart) ? "" : "hidden"}>
            <div class="historyDetailsList">
              ${day.sessions
                .map((session) => {
                  const historySessionKey = `${day.dayStart}-${session.metrics.start}`;
                  const isHistorySessionExpanded = expandedHistorySessions.has(historySessionKey);
                  const validUniqueDomains = (session.metrics?.uniqueDomains || []).filter(isDisplayDomain);
                  const visitsHtml = (session.visits || [])
                    .filter((visit) => isDisplayDomain(visit.domain))
                    .slice()
                    .sort((a, b) => b.time - a.time)
                    .map(
                      (visit) => `
                        <div class="sessionVisitRow">
                          <div class="sessionVisitMain">
                            <img src="${resolveFaviconSrc(visit, 32)}" alt="" class="siteFavicon" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden';" />
                            <a
                              class="sessionVisitDomain"
                              href="${hrefForVisit(visit, visit.domain)}"
                              target="_blank"
                              rel="noopener noreferrer"
                            >${escapeHtml(displayLabelForVisit(visit))}</a>
                          </div>
                          <div class="sessionVisitTime">${fmtTime(visit.time)}</div>
                        </div>
                      `
                    )
                    .join("");

                  return `
                    <div class="historySessionCard">
                      <div class="historySessionHeaderRow">
                        <button
                          type="button"
                          class="historySessionToggle"
                          data-history-session-key="${historySessionKey}"
                          aria-expanded="${isHistorySessionExpanded}"
                        >
                          <div class="historySessionHeader">
                            <div>
                              <div class="sessionTime">${fmtTime(session.metrics.start)} - ${fmtTime(session.metrics.end)}</div>
                              <div
                                class="historySessionName sessionNameEditable"
                                data-session-id="${escapeHtml(session.visits?.[0]?.sessionId || session.id || "")}"
                                data-session-start="${session.metrics.start}"
                                data-session-name="${escapeHtml(session.metrics.sessionName || "")}"
                              >${escapeHtml(describeSessionName(session.metrics.sessionName))}</div>
                            </div>
                            <div class="historySessionHeaderRight">
                              <div class="sessionBadgeSlot">${buildGoalBadgeHtml(session.metrics)}</div>
                            </div>
                          </div>
                          <div class="sessionMeta">
                            <span>${sessionDurationLabel(session.metrics)}</span>
                            <span>${validUniqueDomains.length} sites</span>
                            <span>${session.metrics.totalVisits || 0} visits</span>
                          </div>
                        </button>
                        <div class="sessionActionRail">
                          <button
                            type="button"
                            class="sessionExpandBtn historySessionExpandBtn"
                            data-history-session-key="${historySessionKey}"
                            aria-expanded="${isHistorySessionExpanded}"
                            aria-label="${isHistorySessionExpanded ? "Collapse" : "Expand"} session details"
                          ><span class="sessionChevron">${isHistorySessionExpanded ? "−" : "+"}</span></button>
                          <button
                            type="button"
                            class="sessionDeleteBtn"
                            data-session-id="${escapeHtml(session.visits?.[0]?.sessionId || session.id || "")}"
                            data-session-start="${session.metrics.start}"
                            data-session-name="${escapeHtml(describeSessionName(session.metrics.sessionName))}"
                            aria-label="Delete ${escapeHtml(describeSessionName(session.metrics.sessionName))}"
                          >${buildTrashIcon()}</button>
                        </div>
                      </div>
                      <div class="historySessionDetails" ${isHistorySessionExpanded ? "" : "hidden"}>
                        <div class="sessionDetailsList">
                          ${visitsHtml || '<div class="muted">No visits recorded.</div>'}
                        </div>
                      </div>
                    </div>
                  `;
                })
                .join("")}
            </div>
          </div>
        </div>
      `
    )
    .join("");

  container.querySelectorAll(".historyToggle").forEach((button, index) => {
    button.addEventListener("click", () => {
      const day = rows[index];
      const row = button.closest(".historyRow");
      const details = row.querySelector(".historyDetails");
      const chevron = row.querySelector(".sessionChevron");
      const nextExpanded = details.hidden;

      details.hidden = !nextExpanded;
      button.setAttribute("aria-expanded", String(nextExpanded));
      chevron.textContent = nextExpanded ? "−" : "+";

      if (nextExpanded) {
        expandedHistoryDays.add(day.dayStart);
      } else {
        expandedHistoryDays.delete(day.dayStart);
      }
    });
  });

  container.querySelectorAll(".historySessionToggle").forEach((button) => {
    button.addEventListener("click", () => {
      const sessionKey = button.dataset.historySessionKey;
      const card = button.closest(".historySessionCard");
      const details = card.querySelector(".historySessionDetails");
      const chevron = card.querySelector(".sessionChevron");
      const expandButton = card.querySelector(".historySessionExpandBtn");
      const nextExpanded = details.hidden;

      details.hidden = !nextExpanded;
      button.setAttribute("aria-expanded", String(nextExpanded));
      if (expandButton) {
        expandButton.setAttribute("aria-expanded", String(nextExpanded));
        expandButton.setAttribute("aria-label", `${nextExpanded ? "Collapse" : "Expand"} session details`);
      }
      chevron.textContent = nextExpanded ? "−" : "+";

      if (nextExpanded) {
        expandedHistorySessions.add(sessionKey);
      } else {
        expandedHistorySessions.delete(sessionKey);
      }
    });
  });

  container.querySelectorAll(".historySessionExpandBtn").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const card = button.closest(".historySessionCard");
      const toggle = card.querySelector(".historySessionToggle");
      if (toggle) toggle.click();
    });
  });

  container.querySelectorAll(".historySessionName.sessionNameEditable").forEach((node) => {
    node.addEventListener("click", async (event) => {
      event.stopPropagation();
      await promptRenameSession(node);
    });
  });

  container.querySelectorAll(".sessionDeleteBtn").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const sessionId = button.dataset.sessionId || "";
      const sessionStart = Number(button.dataset.sessionStart || 0);
      const sessionName = button.dataset.sessionName || "this session";
      const confirmed = window.confirm(`Delete ${sessionName} from dashboard history? Analytics data will be kept.`);
      if (!confirmed) return;
      await deleteSessionData(sessionId, sessionStart);
    });
  });
}

function renderSequenceInsights(sessions) {
  const container = document.getElementById("sequenceInsights");
  if (!container) return;

  const rows = computeTopSiteSequences(sessions);

  if (!rows.length) {
    container.innerHTML = `<div class="muted">Not enough multi-site session history yet to identify common sequences.</div>`;
    return;
  }

  container.innerHTML = rows
    .map((row, index) => `
      <div class="siteRow sequenceRow">
        <div class="siteRank">${index + 1}</div>
        <div class="sequenceMain">
          <div class="sequencePath">${
            row.type === "loop"
              ? `${escapeHtml(row.pair[0])} <span class="sequenceArrow">↔</span> ${escapeHtml(row.pair[1])} <span class="sequenceLoopLabel">loop</span>`
              : formatSequencePath(row.sequence)
          }</div>
          <div class="sequenceMeta">${
            row.type === "loop"
              ? `${row.count} back-and-forth repeats across ${row.sessions} sessions`
              : `${row.count} occurrences across ${row.sessions} sessions`
          }</div>
        </div>
        <div class="siteTime">${row.type === "loop" ? `${row.sessions}s` : `${row.count}x`}</div>
      </div>
    `)
    .join("");
}

function renderExtendedSessionInsights(sessions) {
  const container = document.getElementById("extendedSessionInsights");
  if (!container) return;

  const rows = computeExtendedSessionSites(sessions);

  if (!rows.length) {
    container.innerHTML = `<div class="muted">No sessions with an intended duration have gone over their goal yet.</div>`;
    return;
  }

  container.innerHTML = rows
    .map((row, index) => `
      <div class="siteRow">
        <div class="siteRank">${index + 1}</div>
        <div class="siteMain">
          <div>
            <div class="siteName">${escapeHtml(row.domain)}</div>
            <div class="siteMeta">Appeared in ${row.sessions} extended sessions</div>
          </div>
        </div>
      </div>
    `)
    .join("");
}

function renderTimeOfDayInsights(sessions) {
  const container = document.getElementById("timeOfDayInsights");
  if (!container) return;

  const { hourly, topHours, longestSessionHour, overrunProneHour, mostCommonActiveWindow } = computeTimeOfDayTrends(sessions);

  if (!topHours.length) {
    container.innerHTML = `<div class="muted">Not enough session history yet to identify start-time trends.</div>`;
    return;
  }

  const [peakHour, secondHour, thirdHour] = topHours;
  container.innerHTML = `
    <div class="timeOfDayMetrics">
      <div class="timeOfDayMetric">
        <span>Peak hour</span>
        <strong>${peakHour.label}</strong>
        <small>${peakHour.sessions} ${peakHour.sessions === 1 ? "session start" : "session starts"}</small>
      </div>
      <div class="timeOfDayMetric">
        <span>Longest session time</span>
        <strong>${longestSessionHour ? longestSessionHour.label : "-"}</strong>
        <small>${longestSessionHour ? `${msToPretty(longestSessionHour.avgDurationMs)} avg session` : "No session data"}</small>
      </div>
      <div class="timeOfDayMetric">
        <span>Overrun-prone hour</span>
        <strong>${overrunProneHour ? overrunProneHour.label : "-"}</strong>
        <small>${overrunProneHour ? `${Math.round(overrunProneHour.overrunRate * 100)}% of goal-based sessions ran over` : "No goal-based sessions yet"}</small>
      </div>
      <div class="timeOfDayMetric">
        <span>Most common active window</span>
        <strong>${mostCommonActiveWindow ? mostCommonActiveWindow.label : "-"}</strong>
        <small>${mostCommonActiveWindow ? `${mostCommonActiveWindow.sessions} session starts across this 3-hour window` : "No session data"}</small>
      </div>
    </div>
  `;
}

function renderSettings(minutes, statusText = "") {
  const normalized = syncInactivityThreshold(minutes);
  const input = document.getElementById("thresholdInput");
  const status = document.getElementById("thresholdStatus");
  const endingSoon = document.getElementById("notifyEndingSoon");
  const overrun = document.getElementById("notifyOverrun");
  const missingGoal = document.getElementById("notifyMissingGoal");
  const noGoalHourly = document.getElementById("notifyNoGoalHourly");
  const sessionEnded = document.getElementById("notifySessionEnded");
  const noGoalHourlyInterval = document.getElementById("noGoalHourlyInterval");
  if (input) input.value = String(normalized);
  if (status) status.textContent = statusText || `Current timeout: ${normalized} minutes.`;
  if (endingSoon) endingSoon.checked = dashboardState.notificationPreferences?.endingSoon !== false;
  if (overrun) overrun.checked = dashboardState.notificationPreferences?.overrun !== false;
  if (missingGoal) missingGoal.checked = dashboardState.notificationPreferences?.missingGoal !== false;
  if (noGoalHourly) noGoalHourly.checked = dashboardState.notificationPreferences?.noGoalHourly !== false;
  if (sessionEnded) sessionEnded.checked = dashboardState.notificationPreferences?.sessionEnded !== false;
  if (noGoalHourlyInterval) {
    noGoalHourlyInterval.value = String(
      normalizeNoGoalHourlyIntervalHours(dashboardState.noGoalHourlyIntervalHours)
    );
  }
}

function setStatusText(id, text) {
  const node = document.getElementById(id);
  if (node) node.textContent = text;
}

async function clearTodayData() {
  const todayStart = startOfDay();
  const tomorrowStart = todayStart + 24 * 60 * 60 * 1000;
  const {
    visits = [],
    sessions = [],
    activeSession,
    sessionIntents = [],
    manualSessionStarts = [],
    lastUserActivityAt
  } = await chrome.storage.local.get([
    "visits",
    "sessions",
    "activeSession",
    "sessionIntents",
    "manualSessionStarts",
    "lastUserActivityAt"
  ]);

  const keptVisits = visits.filter((visit) => {
    const time = Number(visit?.time) || 0;
    return time < todayStart || time >= tomorrowStart;
  });

  const todaySessionIds = new Set(
    sessions
      .filter((session) => {
        const start = Number(session?.metrics?.start) || 0;
        return start >= todayStart && start < tomorrowStart;
      })
      .map((session) => String(session?.visits?.[0]?.sessionId || session?.id || ""))
      .filter(Boolean)
  );
  if (activeSession?.startTime >= todayStart && activeSession.startTime < tomorrowStart) {
    todaySessionIds.add(String(activeSession.id));
  }

  const keptIntents = sessionIntents.filter((intent) => {
    const sessionIdMatchesToday = todaySessionIds.has(String(intent?.sessionId || ""));
    const startTime = Number(intent?.startTime) || 0;
    return !sessionIdMatchesToday && (startTime < todayStart || startTime >= tomorrowStart || !startTime);
  });

  const keptManualStarts = manualSessionStarts.filter((ts) => ts < todayStart || ts >= tomorrowStart);
  const shouldClearActiveSession =
    activeSession?.startTime >= todayStart && activeSession?.startTime < tomorrowStart;

  await chrome.storage.local.set({
    visits: keptVisits,
    sessions: [],
    activeSession: shouldClearActiveSession ? null : activeSession || null,
    sessionIntents: keptIntents,
    manualSessionStarts: keptManualStarts,
    lastUserActivityAt: shouldClearActiveSession ? Date.now() : lastUserActivityAt
  });

  chrome.runtime.sendMessage({ type: "rebuildSessions" }, () => {});
  setStatusText("clearDataStatus", "Today's dashboard history was cleared. Analytics data was kept.");
  await refresh();
}

async function clearCurrentSessionData() {
  const {
    activeSession,
    visits = [],
    sessionIntents = [],
    manualSessionStarts = []
  } = await chrome.storage.local.get([
    "activeSession",
    "visits",
    "sessionIntents",
    "manualSessionStarts"
  ]);

  if (!activeSession?.id) {
    setStatusText("clearDataStatus", "There is no active session to clear.");
    return;
  }

  const sessionId = String(activeSession.id);
  const keptVisits = visits.filter((visit) => String(visit?.sessionId || "") !== sessionId);
  const keptIntents = sessionIntents.filter((intent) => String(intent?.sessionId || "") !== sessionId);
  const keptManualStarts = manualSessionStarts.filter((ts) => ts !== activeSession.startTime);

  await chrome.storage.local.set({
    visits: keptVisits,
    sessions: [],
    activeSession: null,
    sessionIntents: keptIntents,
    manualSessionStarts: keptManualStarts,
    lastUserActivityAt: Date.now()
  });

  chrome.runtime.sendMessage({ type: "rebuildSessions" }, () => {});
  setStatusText("clearDataStatus", "Current dashboard session was cleared. Analytics data was kept.");
  await refresh();
}

async function clearAllData() {
  await chrome.storage.local.set({
    visits: [],
    sessions: [],
    activeSession: null,
    sessionIntents: [],
    manualSessionStarts: [],
    lastUserActivityAt: Date.now()
  });

  chrome.runtime.sendMessage({ type: "rebuildSessions" }, () => {});
  setStatusText("clearDataStatus", "All dashboard history was cleared. Analytics data was kept.");
  await refresh();
}

function renderDashboard(data) {
  const thresholdMinutes = syncInactivityThreshold(data.inactivityThresholdMinutes);
  dashboardState = {
    activeSession: data.activeSession || null,
    sessions: data.sessions || [],
    analyticsSessions: data.analyticsSessions || [],
    visits: data.visits || [],
    inactivityThresholdMinutes: thresholdMinutes,
    noGoalHourlyIntervalHours: normalizeNoGoalHourlyIntervalHours(data.noGoalHourlyIntervalHours),
    notificationPreferences: data.notificationPreferences || {
      endingSoon: true,
      overrun: true,
      missingGoal: true,
      noGoalHourly: true,
      sessionEnded: true
    }
  };

  const liveSessions = buildLiveSessions(
    dashboardState.sessions,
    dashboardState.activeSession,
    dashboardState.visits
  );
  const analyticsSessions = dashboardState.analyticsSessions.length
    ? dashboardState.analyticsSessions
    : liveSessions;
  const today = computeTodayFromSessions(liveSessions);

  document.getElementById("todayTime").textContent = msToPretty(today.totalTimeMs);

  renderCurrentSession(dashboardState.activeSession, dashboardState.visits);
  renderCurrentSessionData(dashboardState.activeSession, dashboardState.visits);
  renderActivityChart(computeHourlyMinutes(today.todaySessions));
  renderWeekChart(computeWeekBars(liveSessions));
  renderDistributionChart(today.timePerDomain);
  renderSessionsList(liveSessions);
  renderTopSitesToday(today.timePerDomain, today.visitsPerDomain, today.latestUrlPerDomain);
  renderHistoryList(liveSessions);
  renderSequenceInsights(analyticsSessions);
  renderExtendedSessionInsights(analyticsSessions);
  renderTimeOfDayInsights(analyticsSessions);
  renderFootprintExplorer(analyticsSessions.length ? analyticsSessions : liveSessions);
  renderSettings(thresholdMinutes);
}

function tickCurrentSession() {
  renderCurrentSession(dashboardState.activeSession, dashboardState.visits);
  renderCurrentSessionData(dashboardState.activeSession, dashboardState.visits);
}

async function refresh() {
  const data = await chrome.storage.local.get([
    "activeSession",
    "sessions",
    "analyticsSessions",
    "analyticsVisits",
    "visits",
    "inactivityThresholdMinutes",
    "noGoalHourlyIntervalHours",
    "notificationPreferences"
  ]);

  const visits = Array.isArray(data.visits) ? data.visits : [];
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  const analyticsVisits = Array.isArray(data.analyticsVisits) ? data.analyticsVisits : [];
  const analyticsSessions = Array.isArray(data.analyticsSessions) ? data.analyticsSessions : [];
  if ((visits.length && !sessions.length) || (analyticsVisits.length && !analyticsSessions.length)) {
    try {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "rebuildSessions" }, () => resolve());
      });
      const rebuilt = await chrome.storage.local.get([
        "activeSession",
        "sessions",
        "analyticsSessions",
        "visits",
        "inactivityThresholdMinutes",
        "noGoalHourlyIntervalHours"
      ]);
      renderDashboard(rebuilt);
      return;
    } catch {}
  }

  renderDashboard(data);
}

async function stopCurrentSessionFromUi() {
  const response = await chrome.runtime.sendMessage({ type: "stopCurrentSession" });
  if (response?.stopped) {
    await refresh();
    return;
  }

  if (response?.ok) {
    await refresh();
  }
}

function scheduleRefreshRetries() {
  [300, 1200, 2500].forEach((delay) => {
    window.setTimeout(() => {
      refresh().catch(() => {});
    }, delay);
  });
}

async function startNewSession(minutes, sessionName = "") {
  if (!startManualSession) {
    showDashboardError("Reload the extension in chrome://extensions and reopen the dashboard.");
    return;
  }
  await startManualSession(minutes, sessionName);
  await refresh();
}

async function openIntentChooser(mode) {
  if (mode === "manual") {
    document.getElementById("intentModal").hidden = false;
    document.getElementById("intentModalOtherInput").value = "";
    document.getElementById("intentModalSessionName").value = "";
    document.getElementById("intentModalOtherInput").focus();
    return;
  }

  await chrome.tabs.create({
    url: chrome.runtime.getURL(`intent.html?mode=${encodeURIComponent(mode)}`),
    active: true
  });
}

function closeIntentModal() {
  document.getElementById("intentModal").hidden = true;
}

async function submitManualIntent(minutes) {
  if (minutes != null && (!Number.isFinite(minutes) || minutes <= 0)) return;
  const sessionName = normalizeSessionName(document.getElementById("intentModalSessionName")?.value || "");
  await startNewSession(minutes, sessionName);
  closeIntentModal();
}

const navItems = Array.from(document.querySelectorAll(".navItem"));
const tabPanels = Array.from(document.querySelectorAll("[data-tab-panel]"));

function setActiveTab(tabName) {
  navItems.forEach((button) => {
    const isActive = button.dataset.tab === tabName;
    button.classList.toggle("isActive", isActive);
    button.setAttribute("aria-current", isActive ? "page" : "false");
  });

  tabPanels.forEach((panel) => {
    const isActive = panel.dataset.tabPanel === tabName;
    panel.hidden = !isActive;
    panel.classList.toggle("isActive", isActive);
  });
}

navItems.forEach((button) => {
  button.addEventListener("click", () => {
    setActiveTab(button.dataset.tab);
  });
});

document.getElementById("refreshBtn").addEventListener("click", async () => {
  await refresh();
});

document.getElementById("newSessionBtn").addEventListener("click", async () => {
  await openIntentChooser("manual");
});

document.getElementById("stopSessionBtn").addEventListener("click", async () => {
  await stopCurrentSessionFromUi();
});

document.getElementById("currentSessionName").addEventListener("click", async (event) => {
  event.stopPropagation();
  await promptRenameSession(event.currentTarget);
});

document.getElementById("historySearchInput").addEventListener("input", (event) => {
  historySearchQuery = event.currentTarget.value || "";
  renderHistoryList(buildLiveSessions(
    dashboardState.sessions,
    dashboardState.activeSession,
    dashboardState.visits
  ));
});

document.getElementById("historySearchScope").addEventListener("change", (event) => {
  historySearchScope = event.currentTarget.value || "all";
  const input = document.getElementById("historySearchInput");
  const placeholders = {
    all: "Search history",
    session: "Search session names",
    site: "Search sites or pages",
    date: "Search dates or times"
  };
  input.placeholder = placeholders[historySearchScope] || "Search history";
  renderHistoryList(buildLiveSessions(
    dashboardState.sessions,
    dashboardState.activeSession,
    dashboardState.visits
  ));
});

function updateFootprintSelection(value) {
  const sessions = dashboardState.analyticsSessions.length ? dashboardState.analyticsSessions : dashboardState.sessions;
  const options = computeFootprintOptions(sessions);
  const match = options.find((option) => option.domain.toLowerCase() === String(value || "").trim().toLowerCase());
  if (!match) return;
  footprintSelectedDomain = match.domain;
  renderFootprintExplorer(sessions);
}

document.getElementById("footprintSiteInput").addEventListener("change", (event) => {
  updateFootprintSelection(event.currentTarget.value);
});

document.getElementById("footprintSiteInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    updateFootprintSelection(event.currentTarget.value);
  }
});

document.getElementById("closeIntentModalBtn").addEventListener("click", () => {
  closeIntentModal();
});

document.querySelectorAll(".intentModalOption").forEach((button) => {
  button.addEventListener("click", () => {
    submitManualIntent(button.dataset.noGoal ? null : Number(button.dataset.minutes));
  });
});

document.getElementById("intentModalOtherSubmit").addEventListener("click", () => {
  const value = Number(document.getElementById("intentModalOtherInput").value.trim());
  submitManualIntent(value);
});

document.getElementById("intentModalOtherInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    const value = Number(event.currentTarget.value.trim());
    submitManualIntent(value);
  } else if (event.key === "Escape") {
    closeIntentModal();
  }
});

document.getElementById("saveThresholdBtn").addEventListener("click", async () => {
  const input = document.getElementById("thresholdInput");
  const minutes = normalizeInactivityThresholdMinutes(input.value);
  await chrome.storage.local.set({ inactivityThresholdMinutes: minutes });
  renderSettings(minutes, `Saved. Sessions now expire after ${minutes} minutes of inactivity.`);
  await refresh();
});

document.getElementById("thresholdInput").addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") return;
  document.getElementById("saveThresholdBtn").click();
});

document.querySelectorAll(".thresholdPresetBtn").forEach((button) => {
  button.addEventListener("click", async () => {
    const minutes = normalizeInactivityThresholdMinutes(button.dataset.minutes);
    await chrome.storage.local.set({ inactivityThresholdMinutes: minutes });
    renderSettings(minutes, `Saved. Sessions now expire after ${minutes} minutes of inactivity.`);
    await refresh();
  });
});

["notifyEndingSoon", "notifyOverrun", "notifyMissingGoal", "notifyNoGoalHourly", "notifySessionEnded"].forEach((id) => {
  document.getElementById(id).addEventListener("change", async () => {
    const nextPreferences = {
      endingSoon: document.getElementById("notifyEndingSoon").checked,
      overrun: document.getElementById("notifyOverrun").checked,
      missingGoal: document.getElementById("notifyMissingGoal").checked,
      noGoalHourly: document.getElementById("notifyNoGoalHourly").checked,
      sessionEnded: document.getElementById("notifySessionEnded").checked
    };
    await chrome.storage.local.set({ notificationPreferences: nextPreferences });
    dashboardState.notificationPreferences = nextPreferences;
    setStatusText("notificationPreferencesStatus", "Notification preferences saved.");
  });
});

document.getElementById("noGoalHourlyInterval").addEventListener("change", async (event) => {
  const hours = normalizeNoGoalHourlyIntervalHours(event.currentTarget.value);
  await chrome.storage.local.set({ noGoalHourlyIntervalHours: hours });
  dashboardState.noGoalHourlyIntervalHours = hours;
  setStatusText("notificationPreferencesStatus", "Notification preferences saved.");
});

document.querySelectorAll(".notificationTestBtn").forEach((button) => {
  button.addEventListener("click", async () => {
    const kind = button.dataset.notificationTest || "";
    setStatusText("notificationPreferencesStatus", "Sending preview notification...");
    try {
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "testNotificationPreview", kind }, resolve);
      });

      if (response?.ok) {
        setStatusText("notificationPreferencesStatus", "Preview notification sent.");
      } else {
        setStatusText("notificationPreferencesStatus", `Could not send preview notification${response?.error ? `: ${response.error}` : "."}`);
      }
    } catch {
      setStatusText("notificationPreferencesStatus", "Could not send preview notification.");
    }
  });
});

document.getElementById("clearDataBtn").addEventListener("click", async () => {
  const scope = document.getElementById("clearDataScope").value;

  if (scope === "current") {
    const confirmed = window.confirm("Clear the current dashboard session and its recorded visits? Analytics will be kept.");
    if (!confirmed) return;
    await clearCurrentSessionData();
    return;
  }

  if (scope === "today") {
    const confirmed = window.confirm("Clear today's dashboard visits and sessions? Analytics will be kept.");
    if (!confirmed) return;
    await clearTodayData();
    return;
  }

  const confirmed = window.confirm("Clear all dashboard visits, sessions, goals, and current progress? Analytics will be kept.");
  if (!confirmed) return;
  await clearAllData();
});

document.querySelectorAll("[data-analytics-toggle]").forEach((button) => {
  button.addEventListener("click", () => {
    const nextSibling = button.nextElementSibling;
    const body = nextSibling?.classList.contains("analyticsSectionBody")
      ? nextSibling
      : button.closest(".panelCard")?.querySelector(".analyticsSectionBody");
    const chevron = button.querySelector(".analyticsChevron");
    if (!body) return;

    const nextExpanded = body.hidden;
    body.hidden = !nextExpanded;
    button.setAttribute("aria-expanded", String(nextExpanded));
    if (chevron) chevron.textContent = nextExpanded ? "−" : "+";
  });
});

setActiveTab("overview");
refresh();
scheduleRefreshRetries();

window.addEventListener("focus", () => {
  refresh().catch(() => {});
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    refresh().catch(() => {});
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !document.getElementById("intentModal").hidden) {
    closeIntentModal();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.activeSession) {
    dashboardState.activeSession = changes.activeSession.newValue || null;
  }
  if (changes.sessions) {
    dashboardState.sessions = changes.sessions.newValue || [];
  }
  if (changes.analyticsSessions) {
    dashboardState.analyticsSessions = changes.analyticsSessions.newValue || [];
  }
  if (changes.visits) {
    dashboardState.visits = changes.visits.newValue || [];
  }
  if (changes.inactivityThresholdMinutes) {
    const minutes = syncInactivityThreshold(changes.inactivityThresholdMinutes.newValue);
    renderSettings(minutes, `Current timeout: ${minutes} minutes.`);
  }
  if (changes.notificationPreferences) {
    dashboardState.notificationPreferences = changes.notificationPreferences.newValue || {
      endingSoon: true,
      overrun: true,
      missingGoal: true,
      sessionEnded: true
    };
    renderSettings(dashboardState.inactivityThresholdMinutes, document.getElementById("thresholdStatus")?.textContent || "");
  }
  if (changes.noGoalHourlyIntervalHours) {
    dashboardState.noGoalHourlyIntervalHours = normalizeNoGoalHourlyIntervalHours(
      changes.noGoalHourlyIntervalHours.newValue
    );
    renderSettings(dashboardState.inactivityThresholdMinutes, document.getElementById("thresholdStatus")?.textContent || "");
  }

  if (changes.sessions || changes.analyticsSessions || changes.activeSession || changes.visits || changes.inactivityThresholdMinutes || changes.notificationPreferences || changes.noGoalHourlyIntervalHours) {
    renderDashboard(dashboardState);
  }
});

setInterval(tickCurrentSession, 1000);
