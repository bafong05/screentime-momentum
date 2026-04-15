const mode = new URLSearchParams(window.location.search).get("mode") || "manual";
const sessionHelpers = window.ScreenTimeSessionHelpers || null;
const normalizeSessionName =
  sessionHelpers?.normalizeSessionName ||
  ((value) => String(value || "").trim().replace(/\s+/g, " ").slice(0, 80));
const saveIntentToActiveSession = sessionHelpers?.saveIntentToActiveSession || null;
const startManualSession = sessionHelpers?.startManualSession || null;
let intentSubmitted = false;
let dismissingAutoPrompt = false;
let autoDismissTimer = null;
let autoPromptDismissNotified = false;

function showIntentError(message) {
  const shell = document.querySelector(".intentShell");
  if (!shell) return;

  shell.innerHTML = `
    <section class="intentCard">
      <div class="intentEyebrow">Extension needs refresh</div>
      <h1>Session chooser unavailable</h1>
      <p class="intentHint">${message}</p>
    </section>
  `;
}

function currentSessionName() {
  return normalizeSessionName(document.getElementById("sessionNameInput")?.value || "");
}

function applyCopy() {
  const eyebrow = document.getElementById("intentEyebrow");
  const title = document.getElementById("intentTitle");
  const hint = document.getElementById("intentHint");

  eyebrow.hidden = false;
  hint.hidden = false;
  eyebrow.textContent = "New Session";
  hint.textContent = "A new session started after inactivity. Select a goal to continue.";
  title.textContent = "Choose intended duration for new session";
}

async function closeSelf() {
  const currentTab = await chrome.tabs.getCurrent();
  if (currentTab?.id) {
    await chrome.tabs.remove(currentTab.id);
    return;
  }

  window.close();
}

async function closeAllIntentWindows() {
  const intentBaseUrl = chrome.runtime.getURL("intent.html");
  const windows = await chrome.windows.getAll({ populate: true });
  const tabIds = [];

  for (const win of windows) {
    for (const tab of win.tabs || []) {
      if (tab?.id && tab?.url && tab.url.startsWith(intentBaseUrl)) {
        tabIds.push(tab.id);
      }
    }
  }

  if (tabIds.length) {
    try {
      await chrome.tabs.remove(tabIds);
      return;
    } catch {}
  }

  await closeSelf();
}

async function submitIntent(minutes) {
  if (minutes != null && (!Number.isFinite(minutes) || minutes <= 0)) return;
  intentSubmitted = true;
  const sessionName = currentSessionName();

  if (mode === "auto") {
    if (!saveIntentToActiveSession) throw new Error("Session helpers are unavailable.");
    await saveIntentToActiveSession(minutes, sessionName);
  } else {
    if (!startManualSession) throw new Error("Session helpers are unavailable.");
    await startManualSession(minutes, sessionName);
  }

  await closeAllIntentWindows();
}

async function dismissAutoPromptWithoutSelection() {
  if (mode !== "auto" || intentSubmitted || dismissingAutoPrompt) return;
  dismissingAutoPrompt = true;

  try {
    await chrome.runtime.sendMessage({ type: "dismissPendingAutoResumePrompt" });
    autoPromptDismissNotified = true;
  } catch {}

  await closeAllIntentWindows();
}

function scheduleAutoDismissIfIgnored() {
  if (mode !== "auto" || intentSubmitted || dismissingAutoPrompt) return;
  window.clearTimeout(autoDismissTimer);
  autoDismissTimer = window.setTimeout(() => {
    if (!document.hasFocus()) {
      dismissAutoPromptWithoutSelection().catch(() => {});
    }
  }, 2000);
}

function cancelAutoDismiss() {
  if (autoDismissTimer) {
    window.clearTimeout(autoDismissTimer);
    autoDismissTimer = null;
  }
}

function notifyAutoPromptDismissed() {
  if (mode !== "auto" || intentSubmitted || autoPromptDismissNotified) return;
  autoPromptDismissNotified = true;
  try {
    chrome.runtime.sendMessage({ type: "dismissPendingAutoResumePrompt" });
  } catch {}
}

function bindIntentEvents() {
  document.querySelectorAll(".intentOption").forEach((button) => {
    button.addEventListener("click", () => {
      submitIntent(button.dataset.noGoal ? null : Number(button.dataset.minutes));
    });
  });

  document.getElementById("applyOtherIntent").addEventListener("click", () => {
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

async function initIntentPage() {
  if (!sessionHelpers) {
    showIntentError("Reload the extension in chrome://extensions and reopen this window.");
    return;
  }

  applyCopy();
  bindIntentEvents();

  if (mode === "auto") {
    window.addEventListener("blur", scheduleAutoDismissIfIgnored);
    window.addEventListener("focus", cancelAutoDismiss);
    window.addEventListener("pagehide", notifyAutoPromptDismissed);
    window.addEventListener("beforeunload", notifyAutoPromptDismissed);
  }
}

initIntentPage().catch((error) => {
  console.error("Intent popup failed to initialize", error);
  showIntentError("Something went wrong while loading the session chooser. Try refreshing the extension.");
});
