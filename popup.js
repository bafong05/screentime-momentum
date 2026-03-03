function fmtElapsed(ms) {
  ms = Math.max(0, ms);
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function refresh() {
  const { activeSession } = await chrome.storage.local.get(["activeSession"]);

  const intentStatus = document.getElementById("intentStatus");
  const intentDisplay = document.getElementById("intentMinutesDisplay");

  if (!activeSession) {
    document.getElementById("elapsed").textContent = "0:00";
    document.getElementById("sitesCount").textContent = "0";
    document.getElementById("sitesList").textContent = "No session yet.";
    if (intentStatus) intentStatus.textContent = "No intent set.";
    if (intentDisplay) intentDisplay.textContent = "—";
    return;
  }

  const now = Date.now();
  document.getElementById("elapsed").textContent = fmtElapsed(now - activeSession.startTime);
  document.getElementById("sitesCount").textContent = String(activeSession.uniqueDomains?.length || 0);

  const domains = activeSession.uniqueDomains || [];
  const list = domains.slice(0, 6).join(", ");
  document.getElementById("sitesList").textContent =
    domains.length === 0 ? "—" : domains.length > 6 ? `${list}…` : list;

  if (intentStatus && intentDisplay) {
    if (activeSession.intendedMinutes == null) {
      intentStatus.textContent = "No intent set.";
      intentDisplay.textContent = "—";
    } else {
      intentStatus.textContent = "";
      intentDisplay.textContent = `${activeSession.intendedMinutes} min`;
    }
  }
}

document.getElementById("openDashboard").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});

document.getElementById("newSession").addEventListener("click", async () => {
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
    const filtered = intents.filter((i) => i.startTime !== now);
    filtered.push({ startTime: now, intendedMinutes: value });
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

refresh();
setInterval(refresh, 1000);