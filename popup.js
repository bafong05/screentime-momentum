function fmtElapsed(ms) {
  ms = Math.max(0, ms);
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function refresh() {
  const { activeSession } = await chrome.storage.local.get(["activeSession"]);

  if (!activeSession) {
    document.getElementById("elapsed").textContent = "0:00";
    document.getElementById("sitesCount").textContent = "0";
    document.getElementById("sitesList").textContent = "No session yet.";
    return;
  }

  const now = Date.now();
  document.getElementById("elapsed").textContent = fmtElapsed(now - activeSession.startTime);
  document.getElementById("sitesCount").textContent = String(activeSession.uniqueDomains?.length || 0);

  const domains = activeSession.uniqueDomains || [];
  const list = domains.slice(0, 6).join(", ");
  document.getElementById("sitesList").textContent =
    domains.length === 0 ? "—" : domains.length > 6 ? `${list}…` : list;
}

document.getElementById("openDashboard").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});

document.getElementById("clearData").addEventListener("click", async () => {
  await chrome.storage.local.set({ visits: [], sessions: [], activeSession: null });
  await refresh();
});

refresh();
setInterval(refresh, 1000);