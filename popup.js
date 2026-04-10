let chooserMode = null;
const launchMode = new URLSearchParams(window.location.search).get("intent");
const DEFAULT_INACTIVITY_THRESHOLD_MINUTES = 10;
let inactivityThresholdMs = DEFAULT_INACTIVITY_THRESHOLD_MINUTES * 60 * 1000;
const sessionHelpers = window.ScreenTimeSessionHelpers || null;
const normalizeSessionName =
  sessionHelpers?.normalizeSessionName ||
  ((value) => String(value || "").trim().replace(/\s+/g, " ").slice(0, 80));
const saveIntentToActiveSession = sessionHelpers?.saveIntentToActiveSession || null;
const startManualSession = sessionHelpers?.startManualSession || null;
let popupFailed = false;
let refreshTimerId = null;

function showPopupError(message) {
  popupFailed = true;
  const heading = document.getElementById("popupHeading");
  const progressChart = document.getElementById("popupProgressChart");
  const chooser = document.getElementById("intentChooser");
  const actionButtons = [
    document.getElementById("openDashboard"),
    document.getElementById("stopSession"),
    document.getElementById("newSession"),
    document.getElementById("otherIntentBtn"),
    document.getElementById("applyOtherIntent")
  ];

  if (heading) heading.textContent = "Extension needs refresh";
  if (progressChart) {
    progressChart.innerHTML = `<div style="padding:16px;text-align:center;color:#6b7280;font-size:13px;">${message}</div>`;
  }
  if (chooser) chooser.hidden = true;
  actionButtons.forEach((button) => {
    if (button) button.disabled = true;
  });
  document.querySelectorAll(".intentOption").forEach((button) => {
    button.disabled = true;
  });

  if (refreshTimerId) {
    window.clearInterval(refreshTimerId);
    refreshTimerId = null;
  }
}

function currentSessionName() {
  return normalizeSessionName(document.getElementById("sessionNameInput")?.value || "");
}

function normalizeInactivityThresholdMinutes(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return DEFAULT_INACTIVITY_THRESHOLD_MINUTES;
  return Math.min(120, Math.max(1, Math.round(minutes)));
}

async function loadInactivityThreshold() {
  const { inactivityThresholdMinutes } = await chrome.storage.local.get(["inactivityThresholdMinutes"]);
  inactivityThresholdMs =
    normalizeInactivityThresholdMinutes(inactivityThresholdMinutes) * 60 * 1000;
}

if (launchMode === "manual" || launchMode === "auto") {
  document.body.classList.add("chooserOnly");
  document.getElementById("popupHeading").hidden = true;
}

function fmtElapsed(ms) {
  ms = Math.max(0, ms);
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function buildProgressSvg(valueLabel, goalLabel, ratio, hasGoal = true) {
  const size = 148;
  const cx = size / 2;
  const cy = size / 2;
  const radius = 48;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - Math.max(0, Math.min(1, ratio)));
  const isOverGoal = hasGoal && ratio > 1;
  const accent = isOverGoal ? "#dc2626" : "#7d34d8";
  const track = isOverGoal ? "rgba(220, 38, 38, 0.12)" : "rgba(125, 52, 216, 0.12)";

  return `
    <svg class="popupProgressSvg" viewBox="0 0 ${size} ${size}" role="img">
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
      <text class="popupProgressValue" x="${cx}" y="${cy + 4}">${valueLabel}</text>
      <text class="popupProgressGoal" x="${cx}" y="${cy + 24}">/ ${goalLabel}</text>
    </svg>
  `;
}

function showChooser(mode) {
  chooserMode = mode;
  const chooser = document.getElementById("intentChooser");
  const title = document.getElementById("chooserTitle");
  const otherWrap = document.getElementById("otherIntentInputWrap");
  const otherInput = document.getElementById("otherIntentInput");
  const sessionNameInput = document.getElementById("sessionNameInput");

  title.textContent =
    mode === "manual"
      ? "Choose intended duration for new session"
      : "Your session has expired. A new one is now starting.";
  chooser.hidden = false;
  otherWrap.hidden = true;
  otherInput.value = "";
  if (sessionNameInput) sessionNameInput.value = "";
}

function hideChooser() {
  chooserMode = null;
  document.getElementById("intentChooser").hidden = true;
  document.getElementById("otherIntentInputWrap").hidden = true;
  document.getElementById("otherIntentInput").value = "";
  const sessionNameInput = document.getElementById("sessionNameInput");
  if (sessionNameInput) sessionNameInput.value = "";
}

async function submitIntent(minutes) {
  if (popupFailed) return;
  if (minutes != null && (!Number.isFinite(minutes) || minutes <= 0)) return;
  const sessionName = currentSessionName();

  if (chooserMode === "manual") {
    if (!startManualSession) throw new Error("Session helpers are unavailable.");
    await startManualSession(minutes, sessionName);
  } else {
    if (!saveIntentToActiveSession) throw new Error("Session helpers are unavailable.");
    await saveIntentToActiveSession(minutes, sessionName);
  }

  hideChooser();
  await refresh();
  window.close();
}

async function stopSession() {
  if (popupFailed) return;
  await chrome.runtime.sendMessage({ type: "stopCurrentSession" });
  hideChooser();
  await refresh();
}

async function refresh() {
  if (popupFailed) return;
  await loadInactivityThreshold();
  const { activeSession } = await chrome.storage.local.get(["activeSession"]);
  const progressChart = document.getElementById("popupProgressChart");

  if (!activeSession) {
    progressChart.innerHTML = buildProgressSvg("0:00", "free", 0);
    if (chooserMode !== "manual") {
      hideChooser();
    }
    return;
  }

  const now = Date.now();
  const effectiveEndTime = now;
  const elapsedMs = Math.max(0, effectiveEndTime - activeSession.startTime);
  const goalMinutes = activeSession.intendedMinutes;
  const ringBasisMinutes = goalMinutes || 30;
  const ratio = elapsedMs / (ringBasisMinutes * 60 * 1000);
  progressChart.innerHTML = buildProgressSvg(
    fmtElapsed(elapsedMs),
    goalMinutes ? `${goalMinutes}m` : "free",
    ratio,
    goalMinutes != null
  );

  if (activeSession.intendedMinutes != null && chooserMode !== "manual") {
    hideChooser();
  }
}

async function safeRefresh() {
  if (popupFailed) return;
  try {
    await refresh();
  } catch (error) {
    console.error("Popup refresh failed", error);
    showPopupError("The extension lost connection. Reload it in chrome://extensions and reopen the popup.");
  }
}

function bindPopupEvents() {
  document.getElementById("openDashboard").addEventListener("click", () => {
    if (popupFailed) return;
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  });

  document.getElementById("newSession").addEventListener("click", () => {
    if (popupFailed) return;
    showChooser("manual");
  });

  document.getElementById("stopSession").addEventListener("click", async () => {
    await stopSession();
  });

  document.querySelectorAll(".intentOption").forEach((button) => {
    button.addEventListener("click", () => {
      if (popupFailed) return;
      submitIntent(button.dataset.noGoal ? null : Number(button.dataset.minutes));
    });
  });

  document.getElementById("otherIntentBtn").addEventListener("click", () => {
    if (popupFailed) return;
    document.getElementById("otherIntentInputWrap").hidden = false;
    document.getElementById("otherIntentInput").focus();
  });

  document.getElementById("applyOtherIntent").addEventListener("click", () => {
    if (popupFailed) return;
    const value = Number(document.getElementById("otherIntentInput").value.trim());
    submitIntent(value);
  });

  document.getElementById("otherIntentInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      const value = Number(event.currentTarget.value.trim());
      submitIntent(value);
    }
  });
}

async function initPopup() {
  if (!sessionHelpers) {
    showPopupError("Reload the extension in chrome://extensions and reopen the popup.");
    return;
  }

  bindPopupEvents();
  await safeRefresh();

  if (launchMode === "manual" || launchMode === "auto") {
    showChooser(launchMode);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.activeSession || changes.inactivityThresholdMinutes) {
      safeRefresh();
    }
  });

  refreshTimerId = window.setInterval(safeRefresh, 1000);
}

initPopup().catch((error) => {
  console.error("Popup failed to initialize", error);
  showPopupError("Something went wrong while loading the popup. Try refreshing the extension.");
});
