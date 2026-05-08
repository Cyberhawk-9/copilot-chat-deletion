(() => {
  "use strict";

  if (window.__copilotDeleteHelperV1Loaded) return;
  window.__copilotDeleteHelperV1Loaded = true;

  const CHECKBOX_CLASS = "cdh-checkbox";
  const ROW_CLASS = "cdh-row";
  const FAILED_CLASS = "cdh-failed";
  const DELETED_CLASS = "cdh-deleted";
  const STATUS_ID = "cdh-status";

  const CHAT_SELECTORS = [
    '[role="option"][aria-label]',
    '[data-testid*="chat" i]',
    '[data-testid*="conversation" i]',
    '[aria-label][role="listitem"]',
    'nav [aria-label][tabindex]',
    'aside [aria-label][tabindex]'
  ];

  const EXCLUDE_RE = /new chat|settings|upgrade|profile|account|sign in|sign out|copilot pro|apps|plugins|notebook|discover|recent activity|clear all/i;

  const SPEEDS = {
    fast: {
      label: "Fast",
      menuDelay: 70,
      deleteDelay: 110,
      settleDelay: 230,
      betweenDelay: 80,
      menuTimeout: 650,
      optionTimeout: 900,
      confirmTimeout: 1100,
      retries: 1
    },
    balanced: {
      label: "Balanced",
      menuDelay: 120,
      deleteDelay: 180,
      settleDelay: 420,
      betweenDelay: 150,
      menuTimeout: 900,
      optionTimeout: 1200,
      confirmTimeout: 1600,
      retries: 2
    },
    safe: {
      label: "Safe",
      menuDelay: 220,
      deleteDelay: 320,
      settleDelay: 720,
      betweenDelay: 260,
      menuTimeout: 1400,
      optionTimeout: 1800,
      confirmTimeout: 2400,
      retries: 3
    }
  };

  const state = {
    running: false,
    cancelRequested: false,
    lastBox: null,
    failedRows: new Set(),
    lastJob: {
      total: 0,
      deleted: 0,
      failed: 0,
      skipped: 0,
      current: 0
    }
  };

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor(fn, timeout = 1000, interval = 40) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const result = await fn();
      if (result) return result;
      await delay(interval);
    }
    return null;
  }

  function isElement(value) {
    return value instanceof Element || value instanceof HTMLDocument;
  }

  function isVisible(el) {
    if (!isElement(el)) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity || "1") > 0.01
    );
  }

  function getText(el) {
    return (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function combinedText(el) {
    return `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""} ${getText(el)}`.trim();
  }

  function looksLikeChat(el) {
    if (!isVisible(el)) return false;

    const text = combinedText(el);
    if (!text || text.length < 2) return false;
    if (EXCLUDE_RE.test(text)) return false;

    const rect = el.getBoundingClientRect();
    if (rect.height < 18 || rect.height > 120) return false;
    if (rect.width < 90) return false;

    const interactive = el.matches('[role="option"], [role="listitem"], [tabindex], a, button') ||
      el.querySelector('button, a, [role="button"], [tabindex]');

    return Boolean(interactive);
  }

  function getChats() {
    const found = new Set();

    for (const selector of CHAT_SELECTORS) {
      document.querySelectorAll(selector).forEach((el) => {
        if (looksLikeChat(el)) found.add(el);
      });
    }

    return [...found]
      .filter((el) => !el.closest(`#${STATUS_ID}`))
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  }

  function getBoxes() {
    return [...document.querySelectorAll(`.${CHECKBOX_CLASS}`)].filter(isVisible);
  }

  function getSelectedRows() {
    return getBoxes()
      .filter((box) => box.checked && !box.disabled)
      .map((box) => box.closest(`.${ROW_CLASS}`) || box.closest(CHAT_SELECTORS.join(",")))
      .filter(Boolean)
      .filter(isVisible)
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  }

  function getFailedRows() {
    return [...state.failedRows]
      .filter((row) => row?.isConnected && isVisible(row))
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  }

  function ensureStatus() {
    let status = document.getElementById(STATUS_ID);
    if (status) return status;

    status = document.createElement("div");
    status.id = STATUS_ID;
    status.innerHTML = `
      <div class="cdh-status-title">Copilot Delete Helper</div>
      <div class="cdh-status-message">Ready</div>
      <div class="cdh-status-meter"><span></span></div>
    `;
    document.documentElement.appendChild(status);
    return status;
  }

  function setStatus(message, progressPercent = null, show = true) {
    const status = ensureStatus();
    const msg = status.querySelector(".cdh-status-message");
    const bar = status.querySelector(".cdh-status-meter span");

    if (msg) msg.textContent = message;
    if (bar && typeof progressPercent === "number") {
      bar.style.width = `${Math.max(0, Math.min(100, progressPercent))}%`;
    }
    status.style.display = show ? "block" : "none";
  }

  function getStats(extra = {}) {
    const chats = getChats();
    const boxes = getBoxes();
    const selected = boxes.filter((box) => box.checked && !box.disabled).length;
    const failed = getFailedRows().length;
    const progressPercent = state.lastJob.total
      ? Math.round(((state.lastJob.deleted + state.lastJob.failed + state.lastJob.skipped) / state.lastJob.total) * 100)
      : 0;

    return {
      connected: true,
      loaded: chats.length,
      checkboxes: boxes.length,
      selected,
      failed,
      running: state.running,
      progressPercent,
      job: { ...state.lastJob },
      ...extra
    };
  }

  function markRow(row) {
    row.classList.add(ROW_CLASS);
    row.dataset.cdhChatRow = "true";
  }

  function addCheckboxes() {
    let added = 0;
    const chats = getChats();

    for (const chat of chats) {
      markRow(chat);
      if (chat.querySelector(`.${CHECKBOX_CLASS}`)) continue;

      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = CHECKBOX_CLASS;
      box.title = "Select this Copilot chat";
      box.setAttribute("aria-label", "Select Copilot chat for deletion");

      box.addEventListener("click", (event) => {
        event.stopPropagation();
        const boxes = getBoxes();

        if (event.shiftKey && state.lastBox) {
          const start = boxes.indexOf(state.lastBox);
          const end = boxes.indexOf(box);

          if (start !== -1 && end !== -1) {
            const [from, to] = start < end ? [start, end] : [end, start];
            for (let i = from; i <= to; i += 1) {
              boxes[i].checked = box.checked;
            }
          }
        }

        state.lastBox = box;
      });

      for (const eventName of ["mousedown", "pointerdown", "mouseup", "pointerup", "dblclick"]) {
        box.addEventListener(eventName, (event) => event.stopPropagation());
      }

      const insertionTarget = chat.firstElementChild || chat;
      insertionTarget.prepend(box);
      added += 1;
    }

    setStatus(`Added ${added} checkbox(es). Loaded chats: ${chats.length}.`, null, true);
    return { message: `Added ${added} checkbox(es).`, stats: getStats() };
  }

  function removeCheckboxes() {
    const boxes = [...document.querySelectorAll(`.${CHECKBOX_CLASS}`)];
    boxes.forEach((box) => box.remove());
    document.querySelectorAll(`.${ROW_CLASS}`).forEach((row) => {
      row.classList.remove(ROW_CLASS, FAILED_CLASS, DELETED_CLASS);
      row.style.outline = "";
      row.style.opacity = "";
      row.style.pointerEvents = "";
      delete row.dataset.cdhChatRow;
    });
    state.lastBox = null;
    state.failedRows.clear();
    setStatus("Checkboxes removed.", 0, false);
    return { message: `Removed ${boxes.length} checkbox(es).`, stats: getStats() };
  }

  function selectAll() {
    addCheckboxes();
    const boxes = getBoxes();
    boxes.forEach((box) => {
      if (!box.disabled) box.checked = true;
    });
    setStatus(`Selected ${boxes.length} visible chat(s).`, null, true);
    return { message: `Selected ${boxes.length} visible chat(s).`, stats: getStats() };
  }

  function deselectAll() {
    const boxes = getBoxes();
    boxes.forEach((box) => {
      box.checked = false;
    });
    setStatus("Deselected all chats.", null, true);
    return { message: "Deselected all chats.", stats: getStats() };
  }

  function hover(el) {
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    for (const type of ["pointerover", "mouseover", "mouseenter", "mousemove"]) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  }

  function clickElement(el) {
    if (!el) return false;
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    el.click();
    return true;
  }

  function elementCenter(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  async function getMenuButton(chat, speed) {
    hover(chat);
    await delay(speed.menuDelay);

    const directSelectors = [
      'button[title*="Options" i]',
      'button[title*="More" i]',
      'button[aria-label*="options" i]',
      'button[aria-label*="more" i]',
      'button[aria-label*="menu" i]',
      'button[data-testid*="menu" i]',
      'button[data-testid*="option" i]',
      '[role="button"][aria-label*="options" i]',
      '[role="button"][aria-label*="more" i]'
    ];

    for (const selector of directSelectors) {
      const direct = chat.querySelector(selector);
      if (direct && isVisible(direct)) return direct;
    }

    const chatCenter = elementCenter(chat);
    const candidates = [...document.querySelectorAll('button, [role="button"]')]
      .filter(isVisible)
      .filter((btn) => {
        const text = `${btn.title || ""} ${btn.getAttribute("aria-label") || ""} ${btn.getAttribute("data-testid") || ""} ${getText(btn)}`;
        if (!/view options|more|menu|options|ellipsis|⋯|…/i.test(text)) return false;
        const btnCenter = elementCenter(btn);
        return Math.abs(btnCenter.y - chatCenter.y) < 48 && Math.abs(btnCenter.x - chatCenter.x) < Math.max(360, chat.getBoundingClientRect().width + 80);
      });

    return candidates[0] || null;
  }

  function getOpenMenuRoot() {
    const selectors = [
      '[role="menu"]',
      '[role="dialog"]',
      '[data-testid*="menu" i]',
      '[data-testid*="popover" i]',
      '[class*="popover" i]',
      '[class*="menu" i]'
    ];

    for (const selector of selectors) {
      const roots = [...document.querySelectorAll(selector)].filter(isVisible);
      if (roots.length) return roots[roots.length - 1];
    }
    return document;
  }

  function getDeleteOption() {
    const root = getOpenMenuRoot();
    const candidates = [...root.querySelectorAll('button, [role="menuitem"], [role="button"], div, span')]
      .filter(isVisible)
      .filter((el) => {
        const text = getText(el);
        const aria = el.getAttribute("aria-label") || "";
        return /^delete$/i.test(text) || /^delete$/i.test(aria) || /delete chat|delete conversation/i.test(`${text} ${aria}`);
      });

    return candidates[0] || null;
  }

  function getConfirmButton() {
    const candidates = [...document.querySelectorAll('button, [role="button"]')]
      .filter(isVisible)
      .filter((el) => {
        const text = getText(el);
        const aria = el.getAttribute("aria-label") || "";
        const combined = `${text} ${aria}`.trim();
        return /^(delete|confirm|yes|remove)$/i.test(text) || /delete/i.test(combined);
      });

    const destructive = candidates.find((el) => /delete/i.test(getText(el)) || /delete/i.test(el.getAttribute("aria-label") || ""));
    return destructive || candidates[0] || null;
  }

  async function deleteOne(row, speed) {
    row.classList.remove(FAILED_CLASS);
    row.style.outline = "";

    const menu = await waitFor(() => getMenuButton(row, speed), speed.menuTimeout, 50);
    if (!menu) throw new Error("Menu button not found.");

    clickElement(menu);
    await delay(speed.deleteDelay);

    const del = await waitFor(() => getDeleteOption(), speed.optionTimeout, 50);
    if (!del) throw new Error("Delete option not found.");

    clickElement(del);
    await delay(speed.deleteDelay);

    const confirm = await waitFor(() => getConfirmButton(), speed.confirmTimeout, 50);
    if (confirm) clickElement(confirm);

    await delay(speed.settleDelay);
  }

  async function deleteRows(rows, mode = "balanced", sourceLabel = "selected") {
    if (state.running) {
      return { ok: false, message: "A deletion job is already running.", stats: getStats() };
    }

    const speed = SPEEDS[mode] || SPEEDS.balanced;
    const uniqueRows = [...new Set(rows)].filter((row) => row?.isConnected && isVisible(row));

    if (!uniqueRows.length) {
      setStatus(`No ${sourceLabel} chats found.`, null, true);
      return { ok: true, message: `No ${sourceLabel} chats found.`, stats: getStats() };
    }

    const warning = [
      `Delete ${uniqueRows.length} ${sourceLabel} chat(s)?`,
      "",
      "Keep this Copilot tab focused and do not click around while deletion runs.",
      "Only loaded/visible chats can be selected."
    ].join("\n");

    if (!confirm(warning)) {
      setStatus("Canceled.", null, true);
      return { ok: true, message: "Canceled.", stats: getStats() };
    }

    state.running = true;
    state.cancelRequested = false;
    state.failedRows.clear();
    state.lastJob = { total: uniqueRows.length, deleted: 0, failed: 0, skipped: 0, current: 0 };

    let deleted = 0;
    let failed = 0;
    let skipped = 0;

    for (let index = 0; index < uniqueRows.length; index += 1) {
      const row = uniqueRows[index];
      state.lastJob.current = index + 1;

      if (state.cancelRequested) {
        skipped = uniqueRows.length - index;
        state.lastJob.skipped = skipped;
        break;
      }

      const progress = Math.round((index / uniqueRows.length) * 100);
      setStatus(`Deleting ${index + 1}/${uniqueRows.length} using ${speed.label} mode...`, progress, true);

      let success = false;
      let lastError = null;

      for (let attempt = 0; attempt <= speed.retries; attempt += 1) {
        if (state.cancelRequested) break;
        try {
          if (attempt > 0) {
            setStatus(`Retrying ${index + 1}/${uniqueRows.length} — attempt ${attempt + 1}...`, progress, true);
            await delay(speed.betweenDelay * (attempt + 1));
          }

          await deleteOne(row, speed);
          success = true;
          break;
        } catch (err) {
          lastError = err;
          console.warn("[Copilot Delete Helper] delete attempt failed", err);
        }
      }

      const box = row.querySelector(`.${CHECKBOX_CLASS}`);

      if (success) {
        deleted += 1;
        row.classList.add(DELETED_CLASS);
        row.classList.remove(FAILED_CLASS);
        row.style.opacity = "0.35";
        row.style.pointerEvents = "none";
        if (box) {
          box.checked = false;
          box.disabled = true;
        }
      } else {
        failed += 1;
        state.failedRows.add(row);
        row.classList.add(FAILED_CLASS);
        if (box) box.checked = false;
        row.title = lastError?.message ? `Failed: ${lastError.message}` : "Delete failed";
      }

      state.lastJob.deleted = deleted;
      state.lastJob.failed = failed;
      state.lastJob.skipped = skipped;

      const completed = deleted + failed + skipped;
      setStatus(`Started: ${uniqueRows.length} | Deleted: ${deleted} | Failed: ${failed} | Left: ${uniqueRows.length - completed}`, Math.round((completed / uniqueRows.length) * 100), true);
      await delay(speed.betweenDelay);
    }

    state.running = false;
    state.cancelRequested = false;

    addCheckboxes();

    const final = `Done. Started: ${uniqueRows.length} | Deleted: ${deleted} | Failed: ${failed} | Skipped: ${skipped}`;
    setStatus(final, 100, true);

    return { ok: true, message: final, stats: getStats() };
  }

  function findScrollContainers() {
    const candidates = [...document.querySelectorAll("aside, nav, main, section, div")]
      .filter(isVisible)
      .filter((el) => {
        const style = getComputedStyle(el);
        const canScroll = /(auto|scroll)/i.test(`${style.overflowY} ${style.overflow}`);
        return canScroll && el.scrollHeight > el.clientHeight + 80;
      })
      .sort((a, b) => {
        const aChats = a.querySelectorAll(CHAT_SELECTORS.join(",")).length;
        const bChats = b.querySelectorAll(CHAT_SELECTORS.join(",")).length;
        return bChats - aChats;
      });

    return candidates;
  }

  async function loadMoreChats() {
    addCheckboxes();

    const before = getChats().length;
    const containers = findScrollContainers();
    const target = containers[0] || document.scrollingElement || document.documentElement;

    let lastCount = before;
    let stablePasses = 0;
    const maxPasses = 18;

    setStatus("Trying to load more chats by scrolling the chat list...", 5, true);

    for (let pass = 0; pass < maxPasses; pass += 1) {
      target.scrollTop = Math.max(0, target.scrollTop - 900);
      target.dispatchEvent(new Event("scroll", { bubbles: true }));
      await delay(220);
      addCheckboxes();

      const count = getChats().length;
      const progress = Math.round(((pass + 1) / maxPasses) * 100);
      setStatus(`Loading pass ${pass + 1}/${maxPasses}. Loaded: ${count}.`, progress, true);

      if (count <= lastCount) {
        stablePasses += 1;
      } else {
        stablePasses = 0;
        lastCount = count;
      }

      if (stablePasses >= 4) break;
    }

    const after = getChats().length;
    const added = Math.max(0, after - before);
    setStatus(`Load complete. Added ${added} more chat(s). Loaded: ${after}.`, 100, true);
    return { message: `Load complete. Added ${added} more chat(s).`, stats: getStats() };
  }

  async function routeMessage(request) {
    switch (request.action) {
      case "stats":
        return { ok: true, message: "Stats refreshed.", stats: getStats() };
      case "add":
        return { ok: true, ...addCheckboxes() };
      case "remove":
        return { ok: true, ...removeCheckboxes() };
      case "selectAll":
        return { ok: true, ...selectAll() };
      case "deselectAll":
        return { ok: true, ...deselectAll() };
      case "loadMore":
        return { ok: true, ...(await loadMoreChats()) };
      case "deleteSelected":
        return await deleteRows(getSelectedRows(), request.mode, "selected");
      case "retryFailed":
        return await deleteRows(getFailedRows(), request.mode, "failed");
      case "cancel":
        state.cancelRequested = true;
        setStatus("Stop requested. Current chat will finish, then the job will stop.", null, true);
        return { ok: true, message: "Stop requested.", stats: getStats() };
      default:
        return { ok: false, message: "Unknown action.", stats: getStats() };
    }
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    routeMessage(request)
      .then(sendResponse)
      .catch((err) => {
        console.error("[Copilot Delete Helper]", err);
        sendResponse({ ok: false, message: err?.message || "Unexpected error.", stats: getStats() });
      });

    return true;
  });
})();
