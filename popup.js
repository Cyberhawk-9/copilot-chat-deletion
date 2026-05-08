const els = {
  badge: document.getElementById("connectionBadge"),
  loaded: document.getElementById("loadedCount"),
  selected: document.getElementById("selectedCount"),
  failed: document.getElementById("failedCount"),
  status: document.getElementById("status"),
  progress: document.getElementById("progressBar"),
  speed: document.getElementById("speedMode")
};

const buttons = [...document.querySelectorAll("button")];

function setBadge(text, type = "") {
  els.badge.textContent = text;
  els.badge.className = `badge ${type}`.trim();
}

function setStatus(message) {
  els.status.textContent = message || "Ready.";
}

function setProgress(percent = 0) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  els.progress.style.width = `${value}%`;
}

function updateStats(stats = {}) {
  els.loaded.textContent = stats.loaded ?? 0;
  els.selected.textContent = stats.selected ?? 0;
  els.failed.textContent = stats.failed ?? 0;

  if (typeof stats.progressPercent === "number") {
    setProgress(stats.progressPercent);
  }

  if (stats.running) {
    setBadge("Running", "warn");
  } else if (stats.connected) {
    setBadge("Connected", "ok");
  }
}

async function getActiveCopilotTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) return null;

  const url = tab.url || "";
  const isCopilot = url.includes("copilot.com") || url.includes("copilot.microsoft.com");

  return isCopilot ? tab : null;
}

async function send(action, extra = {}) {
  const tab = await getActiveCopilotTab();

  if (!tab) {
    setBadge("Open Copilot", "error");
    setStatus("Open a Copilot tab first, then run the extension.");
    return null;
  }

  setBadge("Working", "warn");
  setStatus(`Running: ${action}...`);

  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { action, ...extra }, (response) => {
      if (chrome.runtime.lastError) {
        setBadge("Refresh", "error");
        setStatus("Content script not ready. Refresh Copilot, then try again.");
        console.error(chrome.runtime.lastError.message);
        resolve(null);
        return;
      }

      if (!response?.ok) {
        setBadge("Issue", "error");
        setStatus(response?.message || "Something went wrong.");
        if (response?.stats) updateStats(response.stats);
        resolve(response);
        return;
      }

      setBadge("Connected", "ok");
      setStatus(response.message || "Done.");
      if (response.stats) updateStats(response.stats);
      resolve(response);
    });
  });
}

async function refreshStats() {
  const result = await send("stats");
  if (result?.stats) updateStats(result.stats);
}

function selectedMode() {
  return els.speed.value || "balanced";
}

function wire(id, action, extraFactory = () => ({})) {
  const el = document.getElementById(id);
  el.addEventListener("click", async () => {
    buttons.forEach((btn) => (btn.disabled = true));
    try {
      const result = await send(action, extraFactory());
      if (result?.stats) updateStats(result.stats);
    } finally {
      buttons.forEach((btn) => (btn.disabled = false));
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  wire("add", "add");
  wire("remove", "remove");
  wire("selectAll", "selectAll");
  wire("deselectAll", "deselectAll");
  wire("loadMore", "loadMore");
  wire("refresh", "stats");
  wire("retryFailed", "retryFailed", () => ({ mode: selectedMode() }));
  wire("cancelJob", "cancel");
  wire("deleteSelected", "deleteSelected", () => ({ mode: selectedMode() }));

  const tab = await getActiveCopilotTab();
  if (!tab) {
    setBadge("Open Copilot", "error");
    setStatus("Open Copilot first, then click Add Checkboxes.");
    return;
  }

  await refreshStats();
});
