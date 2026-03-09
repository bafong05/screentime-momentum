const INACTIVITY_THRESHOLD_MS = 15 * 60 * 1000; // keep in sync with background.js

function faviconUrl(domain, size = 32) {
  // Uses Google’s favicon service
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${size}`;
}

function fmtElapsed(ms) {
  ms = Math.max(0, ms);
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function msToPretty(ms) {
  ms = Math.max(0, ms);
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m`;
}

function computeTodayFromSessions(sessions) {
  const todayStart = startOfToday();

  const todaySessions = sessions
    .filter((s) => s?.metrics?.start >= todayStart)
    .sort((a, b) => a.metrics.start - b.metrics.start);

  const totalTimeMs = todaySessions.reduce((sum, s) => sum + (s.metrics?.durationMs || 0), 0);
  const totalVisits = todaySessions.reduce((sum, s) => sum + (s.metrics?.totalVisits || 0), 0);

  // Aggregate time per domain (from session.metrics.timePerDomain)
  const timePerDomain = {};
  const visitsPerDomain = {};

  for (const s of todaySessions) {
    const tpd = s.metrics?.timePerDomain || {};
    for (const [domain, ms] of Object.entries(tpd)) {
      timePerDomain[domain] = (timePerDomain[domain] || 0) + ms;
    }

    // Visits by domain: count from visits array
    const visits = s.visits || [];
    for (const v of visits) {
      if (!v.domain) continue;
      visitsPerDomain[v.domain] = (visitsPerDomain[v.domain] || 0) + 1;
    }
  }

  const topSite = Object.entries(timePerDomain).sort((a, b) => b[1] - a[1])[0]?.[0] || "—";

  return {
    todaySessions,
    totalTimeMs,
    totalVisits,
    timePerDomain,
    visitsPerDomain,
    topSite
  };
}

// Persist which sessions are expanded across refresh (keyed by session start timestamp)
const expandedSessionStarts = new Set();
// Persist scroll position per expanded session so refresh doesn't jump to top
const sessionScrollTops = new Map();

function renderSessionsList(sessions) {
  const container = document.getElementById("sessionsList");
  if (!sessions.length) {
    container.innerHTML = `<div class="muted">No sessions yet. Browse a bit and come back.</div>`;
    return;
  }

  // Save scroll position of each expanded details panel before we re-render
  container.querySelectorAll(".sessionRow").forEach((row) => {
    const sessionStart = Number(row.dataset.sessionStart);
    if (Number.isNaN(sessionStart) || !expandedSessionStarts.has(sessionStart)) return;
    const inner = row.querySelector(".sessionDetailsInner");
    if (inner) sessionScrollTops.set(sessionStart, inner.scrollTop);
  });

  const recent = [...sessions]
    .filter((s) => s?.metrics)
    .sort((a, b) => b.metrics.start - a.metrics.start)
    .slice(0, 10);

  container.innerHTML = recent
    .map((s, idx) => {
      const startStr = fmtTime(s.metrics.start);
      const endStr = fmtTime(s.metrics.end);
      const timeLabel = `${startStr} – ${endStr}`;
      const durationLabel = msToPretty(s.metrics.durationMs || 0);
      const sitesLabel = `${s.metrics.totalSites ?? s.metrics.uniqueDomains?.length ?? 0} sites`;
      const visitsLabel = `${s.metrics.totalVisits || 0} visits`;

      const intendedMinutes = s.metrics.intendedMinutes;
      const overrunMs = s.metrics.overrunMs ?? null;

      const metaStr = [durationLabel, sitesLabel, visitsLabel].join(" · ");

      const intentBlock =
        intendedMinutes != null
          ? `<div class="sessionIntent">
              Intended: ${intendedMinutes}m
              ${
                overrunMs && overrunMs > 0
                  ? `<span class="sessionOverrun">(+${msToPretty(overrunMs)} over)</span>`
                  : ""
              }
            </div>`
          : "";

      const isExpanded = expandedSessionStarts.has(s.metrics.start);
      // Show most recent visit at the top of the list
      const visits = (s.visits || []).slice().sort((a, b) => b.time - a.time);
      const visitsHtml = visits
        .map(
          (v) =>
            `<div class="sessionVisit">
              <img
                class="favicon"
                src="${faviconUrl(v.domain, 32)}"
                alt=""
                loading="lazy"
                referrerpolicy="no-referrer"
                onerror="this.style.visibility='hidden';"
              />

              <span class="sessionVisitTime">${fmtTime(v.time)}</span>

              <a
                class="sessionVisitDomain"
                href="https://${v.domain}"
                target="_blank"
                rel="noopener noreferrer"
              >
                ${v.domain}
              </a>
            </div>`
        )
        .join("");

      return `
        <div class="sessionRow" data-session-start="${s.metrics.start}">
          <button type="button" class="sessionRowBtn" aria-expanded="${isExpanded}">
            <span class="sessionRowTime">${timeLabel}</span>
            <span class="sessionRowMeta">${metaStr}</span>
            <span class="sessionRowChevron">${isExpanded ? "▼" : "▶"}</span>
          </button>
      
          ${intentBlock}
          <div class="sessionDetails" ${isExpanded ? "" : "hidden"}>
            <div class="sessionDetailsInner">${visitsHtml || '<div class="muted">No visits recorded.</div>'}</div>
          </div>
        </div>
      `;
    })
    .join("");

  container.querySelectorAll(".sessionRowBtn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest(".sessionRow");
      const sessionStart = Number(row.dataset.sessionStart);
      const details = row.querySelector(".sessionDetails");
      const chevron = row.querySelector(".sessionRowChevron");
      const isOpen = !details.hidden;
      details.hidden = !details.hidden;
      if (details.hidden) {
        expandedSessionStarts.delete(sessionStart);
        sessionScrollTops.delete(sessionStart);
      } else {
        expandedSessionStarts.add(sessionStart);
      }
      btn.setAttribute("aria-expanded", !isOpen);
      chevron.textContent = isOpen ? "▶" : "▼";
    });
  });

  // Restore scroll position for each expanded session after re-render
  container.querySelectorAll(".sessionRow").forEach((row) => {
    const sessionStart = Number(row.dataset.sessionStart);
    const scrollTop = sessionScrollTops.get(sessionStart);
    if (scrollTop == null) return;
    const inner = row.querySelector(".sessionDetailsInner");
    if (inner) inner.scrollTop = scrollTop;
  });
}

function renderTopSitesToday(timePerDomain, visitsPerDomain) {
  const container = document.getElementById("topSitesList");
  const rows = Object.entries(timePerDomain).sort((a, b) => b[1] - a[1]).slice(0, 10);

  if (!rows.length) {
    container.innerHTML = `<div class="muted">No site time yet today.</div>`;
    return;
  }

  container.innerHTML = rows
    .map(([domain, ms]) => {
      const visits = visitsPerDomain[domain] || 0;
      return `
        <div class="listRow">
          <div class="listMain">
            <a class="listTitle"
              href="https://${domain}"
              target="_blank"
              rel="noopener noreferrer">
              ${domain}
            </a>
            <div class="listMeta">${visits} visits</div>
          </div>
          <div class="listRight">${msToPretty(ms)}</div>
        </div>
      `;
    })
    .join("");
}

async function refresh() {
  const { activeSession, sessions = [], visits = [] } = await chrome.storage.local.get([
    "activeSession",
    "sessions",
    "visits"
  ]);

  // ---- Current session ----
  if (!activeSession) {
    document.getElementById("elapsed").textContent = "0:00";
    document.getElementById("sitesCount").textContent = "0";
    document.getElementById("sitesList").textContent = "No session yet.";
    document.getElementById("idlePill").textContent = "Inactive";
    document.getElementById("idlePill").className = "pill idle";
  } else {
    const now = Date.now();
    document.getElementById("elapsed").textContent = fmtElapsed(now - activeSession.startTime);
    document.getElementById("sitesCount").textContent = String(activeSession.uniqueDomains?.length || 0);

    const domains = activeSession.uniqueDomains || [];
    document.getElementById("sitesList").textContent = domains.join(", ") || "—";

    const idleMs = now - (activeSession.lastEventTime || activeSession.startTime);
    const isIdle = idleMs > INACTIVITY_THRESHOLD_MS;

    document.getElementById("idlePill").textContent = isIdle ? "Idle" : "Active";
    document.getElementById("idlePill").className = isIdle ? "pill idle" : "pill";
  }

  // ---- Today summary ----
  const today = computeTodayFromSessions(sessions);
  document.getElementById("todayTime").textContent = msToPretty(today.totalTimeMs);
  document.getElementById("todaySessions").textContent = String(today.todaySessions.length);
  document.getElementById("todayTopSite").textContent = today.topSite;
  document.getElementById("todayVisits").textContent = String(
    // if sessions aren't built yet, fall back to raw visit count today
    today.totalVisits || visits.filter((v) => v.time >= startOfToday()).length
  );

  // ---- Tables/lists ----
  renderSessionsList(sessions);
  renderTopSitesToday(today.timePerDomain, today.visitsPerDomain);
}

document.getElementById("newSessionBtn").addEventListener("click", async () => {
  const raw = window.prompt("Optional intended duration (minutes):", "");
  const now = Date.now();
  const newSession = {
    id: `${now}`,
    startTime: now,
    lastEventTime: now,
    uniqueDomains: [],
    visitCount: 0
  };

  const { manualSessionStarts = [], sessionIntents = [] } = await chrome.storage.local.get([
    "manualSessionStarts",
    "sessionIntents"
  ]);
  const updatedStarts = Array.isArray(manualSessionStarts) ? manualSessionStarts.slice() : [];
  updatedStarts.push(now);

  const intents = Array.isArray(sessionIntents) ? sessionIntents.slice() : [];
  const value = raw != null ? Number(raw.trim()) : NaN;

  if (raw && Number.isFinite(value) && value > 0) {
    const filtered = intents.filter((i) => i.sessionId !== newSession.id);
    filtered.push({ sessionId: newSession.id, intendedMinutes: value });
    newSession.intendedMinutes = value;
    await chrome.storage.local.set({
      activeSession: newSession,
      manualSessionStarts: updatedStarts,
      sessionIntents: filtered
    });
  } else {
    await chrome.storage.local.set({ activeSession: newSession, manualSessionStarts: updatedStarts });
  }

  chrome.runtime.sendMessage({ type: "rebuildSessions" }, () => {});
  await refresh();
});

document.getElementById("clearBtn").addEventListener("click", async () => {
  await chrome.storage.local.set({
    visits: [],
    sessions: [],
    activeSession: null,
    sessionIntents: [],
    manualSessionStarts: []
  });
  await refresh();
});

refresh();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.sessions || changes.activeSession || changes.visits) refresh();
});
setInterval(refresh, 1000);