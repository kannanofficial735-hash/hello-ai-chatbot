/**
 * history-ui.js — history drawer UI (PLAN §7, anim-06)
 *
 * Owns: drawer rows/search, temporal grouping, hold-to-pin (500 ms) +
 * FLIP flight, swipe rows, context menu (Pin/Rename/Share/Export/
 * Duplicate/Archive/Delete + undo/Chat info), delete + 5 s undo toast,
 * new-chat highlight, empty state, whole-history export/import footer.
 *
 * Does NOT own: the drawer open/close shell wiring (app.js binds the
 * buttons/scrim/Esc and exposes window.HelloAI.openHistory/closeHistory;
 * the slide animation itself is CSS on [hidden] in css/history.css),
 * the store (js/store.js), or titles (js/titles.js — called, never
 * rewritten). Communicates with chat.js only via CustomEvents
 * ('hello-ai:open-chat', 'hello-ai:new-chat', 'hello-ai:chat-deleted')
 * and the window.HelloAI.history API below.
 *
 * Non-negotiables: every title/snippet is rendered via textContent only
 * (never innerHTML with user content); delete is transactional in the
 * store (chat + messages together) and only becomes final when the 5 s
 * undo window expires; export is a file download, never an upload; no
 * cross-device sync (the drawer footer says so plainly).
 *
 * Pure gesture helpers (decideSwipeRelease / decideDrawerDismiss) are
 * dependency-free and unit-tested in js/history-ui.test.js. Works in the
 * browser (window.HelloAI.history + window.HelloAI.historyUI) and in Node
 * (module.exports) for those pure helpers.
 */
'use strict';

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Object.assign({}, api.pure, { historyUI: api.historyUI });
  }
  root.HelloAI = root.HelloAI || {};
  root.HelloAI.history = api.historyUI;
  root.HelloAI.historyUI = api.historyUI; // alias: titles.md calls it historyUI
  // chat.js calls window.HelloAI.refreshHistoryRow(chatId) after a message
  // is stored / the AI title lands. Deferred lookup (not a direct copy of
  // the function) so it picks up the real implementation assigned in boot(),
  // not the no-op stub above.
  root.HelloAI.refreshHistoryRow = function (chatId) {
    return api.historyUI.refreshRow(chatId);
  };
  Object.assign(root.HelloAI, api.pure);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  // --- Gesture thresholds (anim-06 §2a / §5b — exact, do not tune by feel) --
  const HOLD = {
    TAP_MAX_MS: 200,
    RING_START_MS: 250,
    PIN_TRIGGER_MS: 500,
    MOVE_CANCEL_PX: 10,
  };
  const SWIPE = {
    MAX_PX: 160, // two actions x ~80 px
    OPEN_PX: 80,
    DELETE_PX: 140,
    OPEN_VELOCITY_PX_MS: -0.4,
    DELETE_VELOCITY_PX_MS: -0.6,
  };
  const DRAWER_DISMISS_FRACTION = 0.35;
  const DRAWER_DISMISS_VELOCITY_PX_MS = -0.5;
  const UNDO_MS = 5000;

  /**
   * Row swipe release decision (anim-06 §5b). dx is negative (left swipe),
   * velocity in px/ms (negative = leftwards). Full-swipe delete needs BOTH
   * distance >= 140 px AND fast velocity; a fast flick alone only opens.
   */
  function decideSwipeRelease(dx, velocity) {
    if (dx <= -SWIPE.DELETE_PX && velocity <= SWIPE.DELETE_VELOCITY_PX_MS) return 'delete';
    if (dx <= -SWIPE.OPEN_PX || velocity <= SWIPE.OPEN_VELOCITY_PX_MS) return 'open';
    return 'close';
  }

  /** Drawer swipe-to-dismiss (anim-06 §1d): > 35% of width or fast left flick. */
  function decideDrawerDismiss(dx, width, velocity) {
    if (dx >= 0) return false;
    return Math.abs(dx) > DRAWER_DISMISS_FRACTION * width ||
      velocity <= DRAWER_DISMISS_VELOCITY_PX_MS;
  }

  // --- Browser-only UI ------------------------------------------------------
  const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

  const historyUI = {
    // Public API (see build-notes/history.md for the full contract).
    openChat: function () {},
    newChat: function () {},
    refresh: function () {},
    refreshRow: function () {},
    notifyMessage: function () {},
    setCurrentChatId: function () {},
    getCurrentChatId: function () { return null; },
  };

  if (!isBrowser) {
    return { historyUI, pure: { decideSwipeRelease, decideDrawerDismiss, HOLD, SWIPE } };
  }

  const store = root.HelloAI && root.HelloAI.store;
  const doc = document;

  // --- Small DOM helpers (textContent only, never innerHTML) ----------------
  function el(id) { return doc.getElementById(id); }
  function make(tag, className, text) {
    const n = doc.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }
  function announce(message) {
    const live = el('livePolite');
    if (live) live.textContent = message;
  }

  // --- State ----------------------------------------------------------------
  const state = {
    chats: [],
    currentChatId: null,
    query: '',
    showArchived: false,
    listChanged: true, // stagger rows on the next drawer open
    highlightId: null, // new-chat gold highlight, once only
    openSwipeId: null,
    menuChatId: null,
    pendingDelete: null, // { chat, index, timer, toast }
    storeFailed: false,
    booted: false,
  };

  let drawer, scrim, list, searchInput, emptyState, toastRoot;
  let timeTimer = null;
  let emptyCta = null;
  let archivedBtn = null;
  let menuEl = null;
  let menuScrim = null;
  let modalEl = null;

  // --- Toasts ---------------------------------------------------------------
  function showToast(text, options) {
    const opts = options || {};
    if (!toastRoot) return null;
    const toast = make('div', 'toast is-entering');
    toast.setAttribute('role', 'status');
    toast.appendChild(make('span', 'toast-text', text));
    let timer = null;
    const dismiss = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      toast.classList.remove('is-entering');
      toast.classList.add('is-exiting');
      window.setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 220);
    };
    if (opts.actionLabel) {
      const btn = make('button', 'toast-action pressable', opts.actionLabel);
      btn.type = 'button';
      btn.addEventListener('click', () => { dismiss(); if (opts.onAction) opts.onAction(); });
      toast.appendChild(btn);
    }
    if (opts.durationMs) {
      const bar = make('div', 'toast-progress');
      toast.appendChild(bar);
      // The progress line drains over the undo window (linear = a timer).
      bar.style.animationDuration = opts.durationMs + 'ms';
      timer = window.setTimeout(dismiss, opts.durationMs);
    } else {
      timer = window.setTimeout(dismiss, 4000);
    }
    toastRoot.appendChild(toast);
    return { toast, dismiss };
  }

  // --- Generic small modal (import mode chooser, chat info) ------------------
  function openModal(title, bodyLines, actions) {
    closeModal();
    const wrap = make('div', 'history-modal-wrap');
    const scrimEl = make('div', 'history-modal-scrim');
    const box = make('div', 'history-modal glass-light');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', title);
    box.appendChild(make('h3', 'history-modal-title', title));
    (bodyLines || []).forEach((line) => box.appendChild(make('p', 'history-modal-line', line)));
    const row = make('div', 'history-modal-actions');
    (actions || []).forEach((a) => {
      const btn = make('button', 'history-modal-btn pressable' + (a.danger ? ' is-danger' : ''), a.label);
      btn.type = 'button';
      btn.addEventListener('click', () => { closeModal(); if (a.onClick) a.onClick(); });
      row.appendChild(btn);
    });
    const cancel = make('button', 'history-modal-btn pressable', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', closeModal);
    row.appendChild(cancel);
    box.appendChild(row);
    wrap.appendChild(scrimEl);
    wrap.appendChild(box);
    scrimEl.addEventListener('click', closeModal);
    doc.body.appendChild(wrap);
    modalEl = wrap;
    const first = box.querySelector('button');
    if (first) first.focus();
    return wrap;
  }
  function closeModal() {
    if (modalEl && modalEl.parentNode) modalEl.parentNode.removeChild(modalEl);
    modalEl = null;
  }

  // --- Store loading ----------------------------------------------------------
  async function loadChats() {
    if (!store) { state.storeFailed = true; render(); return; }
    try {
      await store.ensureReady();
      state.chats = await store.listChats({ includeArchived: true });
      state.storeFailed = false;
    } catch (_e) {
      state.storeFailed = true;
    }
    render();
  }

  // --- FLIP helpers (anim-06 §3b) --------------------------------------------
  function captureRects() {
    const map = new Map();
    if (!list) return map;
    list.querySelectorAll('.history-row-wrap').forEach((w) => {
      map.set(w.dataset.chatId, w.getBoundingClientRect().top);
    });
    return map;
  }
  function flipFrom(before, movedId) {
    if (!list) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let animated = 0;
    list.querySelectorAll('.history-row-wrap').forEach((w) => {
      const oldTop = before.get(w.dataset.chatId);
      if (oldTop == null) return;
      const delta = oldTop - w.getBoundingClientRect().top;
      if (Math.abs(delta) < 2) return;
      if (animated >= 6 && w.dataset.chatId !== movedId) return;
      animated++;
      const dur = Math.abs(delta) < 120 ? 320 : Math.abs(delta) > 400 ? 500 : 420;
      w.style.transition = 'none';
      w.style.transform = 'translateY(' + delta + 'px)';
      void w.getBoundingClientRect(); // reflow so the transition retargets
      w.style.transition = 'transform ' + dur + 'ms var(--ease-out-emph)';
      w.style.transform = '';
      w.addEventListener('transitionend', () => {
        w.style.transition = '';
        w.style.transform = '';
      }, { once: true });
    });
  }

  // --- Row construction (textContent only) ------------------------------------
  function buildRow(chat) {
    const wrap = make('li', 'history-row-wrap');
    wrap.dataset.chatId = chat.id;

    // Swipe actions live UNDER the row; the row slides away to reveal them.
    const actions = make('div', 'swipe-actions');
    actions.setAttribute('aria-hidden', 'true');
    const shareBtn = make('button', 'swipe-action swipe-share', 'Share');
    shareBtn.type = 'button';
    shareBtn.tabIndex = -1;
    const deleteBtn = make('button', 'swipe-action swipe-delete', 'Delete');
    deleteBtn.type = 'button';
    deleteBtn.tabIndex = -1;
    actions.appendChild(shareBtn);
    actions.appendChild(deleteBtn);
    wrap.appendChild(actions);

    const row = make('div', 'history-row');
    row.dataset.chatId = chat.id;
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.setAttribute(
      'aria-label',
      (chat.pinned ? 'Pinned chat: ' : 'Chat: ') + (chat.title || 'Untitled chat')
    );
    if (chat.pinned) row.classList.add('is-pinned');

    // Pin glyph: the real SVG from assets/icons/sprite.svg (was the "📌"
    // placeholder). Decorative only (aria-hidden); the pinned state is
    // announced via the row's aria-label ("Pinned chat: …"), never by emoji.
    const pin = make('span', 'pin-icon', '');
    pin.setAttribute('aria-hidden', 'true');
    const pinSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    pinSvg.setAttribute('class', 'icon');
    pinSvg.setAttribute('width', '16');
    pinSvg.setAttribute('height', '16');
    pinSvg.setAttribute('aria-hidden', 'true');
    const pinUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    pinUse.setAttribute('href', 'assets/icons/sprite.svg#icon-pin');
    pinSvg.appendChild(pinUse);
    pin.appendChild(pinSvg);
    row.appendChild(pin);

    const text = make('span', 'row-text');
    text.appendChild(make('span', 'row-title', chat.title || 'Untitled chat'));
    text.appendChild(make('span', 'row-preview', chat.preview || ''));
    row.appendChild(text);

    row.appendChild(make('span', 'row-time', store.relativeTime(chat.updatedAt)));
    const more = make('button', 'row-more pressable', '•••');
    more.type = 'button';
    more.setAttribute('aria-label', 'More options for ' + (chat.title || 'this chat'));
    more.setAttribute('aria-haspopup', 'menu');
    row.appendChild(more);

    // Hold-progress ring (SVG circle; stroke-dashoffset animates linearly).
    const ring = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ring.setAttribute('class', 'hold-ring');
    ring.setAttribute('viewBox', '0 0 44 44');
    ring.setAttribute('aria-hidden', 'true');
    const circle = doc.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '22');
    circle.setAttribute('cy', '22');
    circle.setAttribute('r', '20');
    ring.appendChild(circle);
    row.appendChild(ring);

    wrap.appendChild(row);
    bindRowGestures(wrap, row, chat);
    shareBtn.addEventListener('click', () => { closeOpenSwipe(); shareChat(chat.id); });
    deleteBtn.addEventListener('click', () => { closeOpenSwipe(); requestDelete(chat.id); });
    more.addEventListener('click', (e) => { e.stopPropagation(); openMenu(chat.id, more); });
    return wrap;
  }

  // --- Render -----------------------------------------------------------------
  function render() {
    if (!list) return;
    const scrollTop = list.scrollTop;
    while (list.firstChild) list.removeChild(list.firstChild);

    const visible = state.chats.filter((c) => !c.archived || state.showArchived);
    const query = (state.query || '').trim();
    let rows = [];
    let empty = false;

    if (state.storeFailed) {
      empty = true;
      if (emptyState) {
        emptyState.textContent =
          'History couldn\'t load — your browser storage is unavailable. Chats won\'t be saved on this device.';
        emptyState.hidden = false;
      }
      if (emptyCta) emptyCta.hidden = true;
    } else if (query) {
      rows = visible.filter((c) => store.matchesQuery(c, query));
      const header = make('li', 'group-header', 'Search results');
      list.appendChild(header);
      rows.forEach((c) => list.appendChild(buildRow(c)));
      empty = rows.length === 0;
      if (emptyState) {
        emptyState.textContent = 'No chats match "' + query + '".';
        emptyState.hidden = false;
      }
      if (emptyCta) emptyCta.hidden = true;
    } else {
      const groups = store.groupChats(visible, Date.now(), { includeArchived: state.showArchived });
      const sections = [
        ['Pinned', groups.pinned],
        ['Today', groups.today],
        ['Yesterday', groups.yesterday],
        ['Last 7 days', groups.last7],
        ['Last 30 days', groups.last30],
        ['Older', groups.older],
      ];
      let total = 0;
      sections.forEach(([label, items]) => {
        if (!items.length) return;
        total += items.length;
        list.appendChild(make('li', 'group-header', label));
        items.forEach((c) => list.appendChild(buildRow(c)));
      });
      empty = total === 0;
      if (emptyState) {
        emptyState.textContent =
          'No chats yet — your conversations will appear here. Ask your first question →';
        emptyState.hidden = !empty;
      }
      if (emptyCta) emptyCta.hidden = !empty;
    }

    if (archivedBtn) {
      const n = state.chats.filter((c) => c.archived).length;
      archivedBtn.textContent = state.showArchived
        ? 'Hide archived chats (' + n + ')'
        : 'Archived chats (' + n + ')';
      archivedBtn.hidden = n === 0 && !state.showArchived;
    }

    // One-time stagger on drawer open (anim-06 §1c): first 6 rows, 30 ms apart.
    if (state.listChanged && !query) {
      const wraps = list.querySelectorAll('.history-row-wrap');
      wraps.forEach((w, i) => {
        if (i < 6) {
          w.classList.add('row-enter');
          w.style.animationDelay = (60 + i * 30) + 'ms';
        }
      });
      window.setTimeout(() => {
        list.querySelectorAll('.row-enter').forEach((w) => {
          w.classList.remove('row-enter');
          w.style.animationDelay = '';
        });
      }, 900);
      state.listChanged = false;
    }

    // One-time gold highlight for the newest chat (anim-06 §8b).
    if (state.highlightId) {
      const target = list.querySelector('.history-row-wrap[data-chat-id="' + state.highlightId + '"]');
      if (target) {
        target.classList.add('is-new');
        window.setTimeout(() => target.classList.remove('is-new'), 950);
      }
      state.highlightId = null;
    }

    list.scrollTop = scrollTop;
  }

  /** Silent in-place update of one row (AI title swap — no animation, §(c.1)). */
  function refreshRowInPlace(chatId) {
    if (!list) return;
    const chat = state.chats.find((c) => c.id === chatId);
    const wrap = list.querySelector('.history-row-wrap[data-chat-id="' + chatId + '"]');
    if (!chat || !wrap) return;
    const titleEl = wrap.querySelector('.row-title');
    const previewEl = wrap.querySelector('.row-preview');
    const timeEl = wrap.querySelector('.row-time');
    if (titleEl) titleEl.textContent = chat.title || 'Untitled chat';
    if (previewEl) previewEl.textContent = chat.preview || '';
    if (timeEl) timeEl.textContent = store.relativeTime(chat.updatedAt);
    const row = wrap.querySelector('.history-row');
    if (row) {
      row.setAttribute(
        'aria-label',
        (chat.pinned ? 'Pinned chat: ' : 'Chat: ') + (chat.title || 'Untitled chat')
      );
    }
  }

  // --- Row gestures: tap / hold-to-pin / swipe --------------------------------
  function bindRowGestures(wrap, row, chat) {
    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let pointerId = null;
    let holdTimers = [];
    let swiping = false;
    let lastX = 0;
    let lastT = 0;
    let velocity = 0;
    let pinFired = false;

    function clearHoldTimers() {
      holdTimers.forEach((t) => clearTimeout(t));
      holdTimers = [];
      row.classList.remove('is-pressed', 'is-holding');
    }

    row.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.row-more')) return; // ••• has its own handler
      if (e.button != null && e.button !== 0) return;
      if (state.openSwipeId && state.openSwipeId !== chat.id) closeOpenSwipe();
      pointerId = e.pointerId;
      startX = lastX = e.clientX;
      startY = e.clientY;
      startTime = lastT = e.timeStamp || Date.now();
      velocity = 0;
      swiping = false;
      pinFired = false;
      try { row.setPointerCapture(e.pointerId); } catch (_err) { /* older browsers */ }
      row.classList.add('is-pressed'); // sinks in 120 ms (CSS)
      holdTimers.push(window.setTimeout(() => {
        row.classList.add('is-holding'); // ring starts filling (250 ms)
        if (navigator.vibrate) navigator.vibrate(10);
      }, HOLD.RING_START_MS));
      holdTimers.push(window.setTimeout(() => {
        pinFired = true;
        row.classList.remove('is-pressed', 'is-holding');
        if (navigator.vibrate) navigator.vibrate(15);
        togglePin(chat.id);
      }, HOLD.PIN_TRIGGER_MS));
    });

    row.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const now = e.timeStamp || Date.now();
      velocity = (e.clientX - lastX) / Math.max(1, now - lastT);
      lastX = e.clientX;
      lastT = now;
      if (!swiping) {
        if (Math.abs(dx) > HOLD.MOVE_CANCEL_PX || Math.abs(dy) > HOLD.MOVE_CANCEL_PX) {
          clearHoldTimers();
          row.classList.remove('is-pressed');
          // Horizontal drag becomes a swipe; vertical drag is a scroll
          // (touch-action: pan-y lets the list scroll natively).
          if (dx < 0 && Math.abs(dx) >= Math.abs(dy)) {
            swiping = true;
            row.classList.add('is-swiping');
          }
        }
        return;
      }
      const clamped = Math.max(-SWIPE.MAX_PX, Math.min(0, dx));
      row.style.transition = 'none';
      row.style.transform = 'translateX(' + clamped + 'px)';
    });

    function endGesture(e, cancelled) {
      if (e.pointerId !== pointerId) return;
      pointerId = null;
      const elapsed = (e.timeStamp || Date.now()) - startTime;
      const dx = e.clientX - startX;
      clearHoldTimers();
      row.classList.remove('is-pressed');
      if (swiping) {
        swiping = false;
        row.classList.remove('is-swiping');
        row.style.transition = '';
        const decision = cancelled ? 'close' : decideSwipeRelease(dx, velocity);
        if (decision === 'delete') {
          row.style.transition = 'transform 250ms var(--ease-in), opacity 250ms var(--ease-in)';
          row.style.transform = 'translateX(-100%)';
          row.style.opacity = '0';
          window.setTimeout(() => requestDelete(chat.id), 250);
        } else if (decision === 'open') {
          row.style.transition = 'transform 250ms var(--ease-out-emph)';
          row.style.transform = 'translateX(-' + SWIPE.MAX_PX + 'px)';
          state.openSwipeId = chat.id;
          window.setTimeout(() => { row.style.transition = ''; }, 260);
        } else {
          row.style.transition = 'transform 220ms var(--ease-out)';
          row.style.transform = '';
          state.openSwipeId = null;
          window.setTimeout(() => { row.style.transition = ''; row.style.transform = ''; }, 230);
        }
        return;
      }
      if (pinFired) return; // pin already committed; suppress the tap
      if (!cancelled && elapsed < HOLD.TAP_MAX_MS && Math.abs(dx) < HOLD.MOVE_CANCEL_PX) {
        openChat(chat.id);
      }
      // Release at 200–499 ms or after a move: cancel, no action (anim-06 §2a).
    }

    row.addEventListener('pointerup', (e) => endGesture(e, false));
    row.addEventListener('pointercancel', (e) => endGesture(e, true));

    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openChat(chat.id); }
      else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault();
        openMenu(chat.id, row.querySelector('.row-more'));
      }
    });
  }

  function closeOpenSwipe() {
    if (!state.openSwipeId || !list) return;
    const wrap = list.querySelector('.history-row-wrap[data-chat-id="' + state.openSwipeId + '"]');
    if (wrap) {
      const row = wrap.querySelector('.history-row');
      if (row) {
        row.style.transition = 'transform 220ms var(--ease-out)';
        row.style.transform = '';
        window.setTimeout(() => { row.style.transition = ''; }, 230);
      }
    }
    state.openSwipeId = null;
  }

  // --- Pin / unpin (FLIP flight, anim-06 §3–4) ---------------------------------
  async function togglePin(chatId) {
    const chat = state.chats.find((c) => c.id === chatId);
    if (!chat || !store) return;
    const before = captureRects();
    const pinned = !chat.pinned;
    try {
      const updated = await store.setPinned(chatId, pinned);
      if (!updated) return;
      chat.pinned = updated.pinned;
      chat.pinnedAt = updated.pinnedAt;
      state.listChanged = true;
      render();
      flipFrom(before, chatId);
      const wrap = list.querySelector('.history-row-wrap[data-chat-id="' + chatId + '"]');
      if (wrap && pinned) {
        const row = wrap.querySelector('.history-row');
        if (row) {
          row.classList.add('is-pinning');
          window.setTimeout(() => row.classList.remove('is-pinning'), 300);
        }
      }
      announce(pinned ? 'Chat pinned.' : 'Chat unpinned.');
    } catch (_e) {
      showToast('Couldn\'t change the pin — try again.');
    }
  }

  // --- Open / new chat ----------------------------------------------------------
  function openChat(chatId) {
    state.currentChatId = chatId;
    closeOpenSwipe();
    closeMenu();
    doc.dispatchEvent(new CustomEvent('hello-ai:open-chat', { detail: { chatId } }));
    if (root.HelloAI.showChat) root.HelloAI.showChat();
    if (root.HelloAI.closeHistory) root.HelloAI.closeHistory();
  }

  function newChat() {
    state.currentChatId = null;
    closeMenu();
    doc.dispatchEvent(new CustomEvent('hello-ai:new-chat', {}));
    if (root.HelloAI.showHome) root.HelloAI.showHome();
    if (root.HelloAI.closeHistory) root.HelloAI.closeHistory();
    const input = el('messageInput') || el('homeComposerInput');
    if (input) window.setTimeout(() => input.focus(), 100);
  }

  // --- Context menu ---------------------------------------------------------------
  function openMenu(chatId, anchorEl) {
    closeMenu();
    const chat = state.chats.find((c) => c.id === chatId);
    if (!chat) return;
    state.menuChatId = chatId;

    menuScrim = make('div', 'menu-scrim');
    menuScrim.addEventListener('click', closeMenu);
    drawer.appendChild(menuScrim);

    menuEl = make('div', 'chat-menu glass-light');
    menuEl.setAttribute('role', 'menu');
    const items = [
      { label: chat.pinned ? 'Unpin' : 'Pin', action: () => togglePin(chatId) },
      { label: 'Rename', action: () => startRename(chatId) },
      { label: 'Share', action: () => shareChat(chatId) },
      { label: 'Export', action: () => exportSingleChat(chatId) },
      { label: 'Duplicate', action: () => duplicateChat(chatId) },
      { label: chat.archived ? 'Unarchive' : 'Archive', action: () => archiveChat(chatId) },
      { label: 'Delete', danger: true, action: () => requestDelete(chatId) },
      { label: 'Chat info', action: () => showChatInfo(chatId) },
    ];
    items.forEach((item, i) => {
      const btn = make('button', 'menu-item pressable' + (item.danger ? ' is-danger' : ''), item.label);
      btn.type = 'button';
      btn.setAttribute('role', 'menuitem');
      btn.style.transitionDelay = (60 + i * 20) + 'ms';
      btn.addEventListener('click', () => {
        closeMenu();
        // Actions start only after the menu is fully closed (anim-06 §6c).
        window.setTimeout(item.action, 200);
      });
      menuEl.appendChild(btn);
    });

    drawer.appendChild(menuEl);
    // Position: bloom from the row, growing away from the nearest screen edge.
    const anchorRect = anchorEl ? anchorEl.getBoundingClientRect() : null;
    const drawerRect = drawer.getBoundingClientRect();
    const menuHeight = Math.min(8 * 48, window.innerHeight - 32);
    let top = anchorRect ? anchorRect.bottom - drawerRect.top + 4 : 80;
    if (anchorRect && anchorRect.top > window.innerHeight / 2) {
      top = anchorRect.top - drawerRect.top - menuHeight - 4;
      menuEl.classList.add('origin-bottom');
    }
    menuEl.style.top = Math.max(8, Math.min(top, drawerRect.height - menuHeight - 8)) + 'px';
    menuEl.style.right = '12px';
    requestAnimationFrame(() => menuEl.classList.add('is-open'));
    const first = menuEl.querySelector('.menu-item');
    if (first) first.focus();
    const row = list.querySelector('.history-row-wrap[data-chat-id="' + chatId + '"] .history-row');
    if (row) row.classList.add('menu-source');
  }

  function closeMenu() {
    if (menuEl) {
      const closing = menuEl;
      closing.classList.remove('is-open');
      closing.classList.add('is-closing');
      window.setTimeout(() => { if (closing.parentNode) closing.parentNode.removeChild(closing); }, 200);
      menuEl = null;
    }
    if (menuScrim && menuScrim.parentNode) menuScrim.parentNode.removeChild(menuScrim);
    menuScrim = null;
    if (list) {
      list.querySelectorAll('.menu-source').forEach((r) => r.classList.remove('menu-source'));
    }
    state.menuChatId = null;
  }

  // --- Rename (inline; sets titleManual — auto-titles never overwrite it) --------
  function startRename(chatId) {
    const chat = state.chats.find((c) => c.id === chatId);
    const wrap = list.querySelector('.history-row-wrap[data-chat-id="' + chatId + '"]');
    if (!chat || !wrap) return;
    const titleEl = wrap.querySelector('.row-title');
    if (!titleEl) return;
    const input = doc.createElement('input');
    input.type = 'text';
    input.className = 'row-rename-input';
    input.value = chat.title || '';
    input.setAttribute('aria-label', 'Rename chat');
    input.maxLength = 80;
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const commit = async (save) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      if (save && value && value !== chat.title) {
        try {
          await store.renameChat(chatId, value);
          chat.title = value;
          chat.titleManual = true;
          chat.titleSource = 'manual';
          announce('Chat renamed.');
        } catch (_e) {
          showToast('Couldn\'t rename — try again.');
        }
      }
      refreshRowInPlace(chatId);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => commit(true));
  }

  // --- Share / export / duplicate / archive ----------------------------------------
  function chatMarkdown(chatId) {
    const chat = state.chats.find((c) => c.id === chatId);
    if (!chat) return Promise.resolve(null);
    return store.getMessages(chatId).then((messages) => {
      const lines = ['# ' + (chat.title || 'Untitled chat'), ''];
      messages.forEach((m) => {
        lines.push('**' + (m.role === 'user' ? 'You' : 'Hello AI') + ':** ' + (m.content || ''));
        lines.push('');
      });
      return lines.join('\n');
    });
  }

  async function shareChat(chatId) {
    const chat = state.chats.find((c) => c.id === chatId);
    if (!chat) return;
    const text = await chatMarkdown(chatId);
    if (!text) return;
    // Share is explicit per chat, download/clipboard only — never an upload.
    if (navigator.share) {
      try {
        await navigator.share({ title: chat.title || 'Hello AI chat', text });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return; // user cancelled the sheet
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        showToast('Chat copied to clipboard.');
        return;
      } catch (_e) { /* fall through to download */ }
    }
    store.downloadFile('hello-ai-chat-' + new Date().toISOString().slice(0, 10) + '.md',
      'text/markdown', text);
    showToast('Chat downloaded as Markdown.');
  }

  async function exportSingleChat(chatId) {
    if (!store) return;
    const payload = await store.exportChat(chatId, 'json');
    if (!payload) return;
    store.downloadFile(payload.filename, payload.mime, payload.text);
    showToast('Chat exported as JSON.');
  }

  async function duplicateChat(chatId) {
    if (!store) return;
    try {
      const copy = await store.duplicateChat(chatId);
      if (!copy) return;
      const before = captureRects();
      state.chats.unshift(copy);
      state.chats = store.sortChats(state.chats);
      state.highlightId = copy.id;
      state.listChanged = true;
      render();
      flipFrom(before, copy.id);
      announce('Chat duplicated.');
    } catch (_e) {
      showToast('Couldn\'t duplicate — try again.');
    }
  }

  async function archiveChat(chatId) {
    const chat = state.chats.find((c) => c.id === chatId);
    if (!chat || !store) return;
    try {
      await store.setArchived(chatId, !chat.archived);
      chat.archived = !chat.archived;
      state.listChanged = true;
      render();
      announce(chat.archived ? 'Chat archived.' : 'Chat restored from archive.');
    } catch (_e) {
      showToast('Couldn\'t archive — try again.');
    }
  }

  function showChatInfo(chatId) {
    const chat = state.chats.find((c) => c.id === chatId);
    if (!chat) return;
    const created = new Date(chat.createdAt || Date.now()).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
    });
    openModal(chat.title || 'Untitled chat', [
      'Created: ' + created,
      'Messages: ' + (chat.messageCount || 0),
      'Model: Dolphin · Live',
      chat.pinned ? 'Pinned' : 'Not pinned',
      'Stored only on this device.',
    ], []);
  }

  // --- Delete + 5 s undo (anim-06 §7) ----------------------------------------------
  function commitPendingDelete() {
    const pending = state.pendingDelete;
    if (!pending) return;
    state.pendingDelete = null;
    if (pending.toast) pending.toast.dismiss();
    if (store) {
      store.deleteChat(pending.chat.id).catch(() => {
        showToast('Couldn\'t delete that chat — it may still be there.');
      });
    }
    doc.dispatchEvent(new CustomEvent('hello-ai:chat-deleted', { detail: { chatId: pending.chat.id } }));
  }

  function requestDelete(chatId) {
    const index = state.chats.findIndex((c) => c.id === chatId);
    if (index === -1) return;
    commitPendingDelete(); // only one undo window at a time; the first delete becomes final
    const chat = state.chats[index];
    const wrap = list.querySelector('.history-row-wrap[data-chat-id="' + chatId + '"]');
    const finish = () => {
      state.chats.splice(index, 1);
      state.listChanged = true;
      render();
      if (state.currentChatId === chatId) {
        state.currentChatId = null;
        doc.dispatchEvent(new CustomEvent('hello-ai:chat-deleted', { detail: { chatId } }));
      }
      const pending = { chat, index, toast: null };
      pending.toast = showToast('Chat deleted', {
        actionLabel: 'Undo',
        durationMs: UNDO_MS,
        onAction: () => {
          // Undo: restore the row at its original position (anim-06 §7d).
          window.clearTimeout(pending.timer);
          state.pendingDelete = null;
          state.chats.splice(Math.min(pending.index, state.chats.length), 0, pending.chat);
          state.listChanged = true;
          render();
          const restored = list.querySelector(
            '.history-row-wrap[data-chat-id="' + pending.chat.id + '"]'
          );
          if (restored) {
            restored.classList.add('is-restored');
            window.setTimeout(() => restored.classList.remove('is-restored'), 450);
          }
          announce('Chat restored.');
        },
      });
      pending.timer = window.setTimeout(() => {
        // Expiry: the deletion becomes final — transactional in the store.
        state.pendingDelete = null;
        if (store) {
          store.deleteChat(chat.id).catch(() => {
            showToast('Couldn\'t delete that chat — it may still be there.');
          });
        }
        doc.dispatchEvent(new CustomEvent('hello-ai:chat-deleted', { detail: { chatId: chat.id } }));
      }, UNDO_MS);
      state.pendingDelete = pending;
      announce('Chat deleted. Undo available for 5 seconds.');
    };
    if (wrap) {
      // Collapse (anim-06 §7a): slide + fade 200 ms, wrapper collapses 300 ms.
      wrap.classList.add('is-deleting');
      window.setTimeout(finish, 450);
    } else {
      finish();
    }
  }

  // --- Whole-history export / import (drawer footer) ---------------------------------
  async function exportAll() {
    if (!store) return;
    try {
      const payload = await store.exportAll();
      const stamp = new Date().toISOString().slice(0, 10);
      store.downloadFile(
        'hello-ai-chats-' + stamp + '.json',
        'application/json',
        JSON.stringify(payload, null, 2)
      );
      showToast('History exported.');
    } catch (_e) {
      showToast('Export failed — try again.');
    }
  }

  function importAll(file) {
    if (!file || !store) return;
    const reader = new FileReader();
    reader.onload = () => {
      let data = null;
      try {
        data = JSON.parse(String(reader.result));
      } catch (_e) {
        showToast('That file is not a valid history export.');
        return;
      }
      const check = store.validateExportData(data);
      if (!check.ok) { showToast(check.error); return; }
      // Validation passed BEFORE anything is deleted (research §(b.4)).
      openModal('Import chats', [
        'This file has ' + data.chats.length + ' chats and ' + data.messages.length + ' messages.',
        'Replace deletes your current chats first. Merge keeps what you have and adds only new ones.',
      ], [
        {
          label: 'Replace all',
          danger: true,
          onClick: () => doImport(data, 'replace'),
        },
        { label: 'Merge', onClick: () => doImport(data, 'merge') },
      ]);
    };
    reader.onerror = () => showToast('Couldn\'t read that file.');
    reader.readAsText(file);
  }

  async function doImport(data, mode) {
    try {
      const result = await store.importData(data, mode);
      await loadChats();
      showToast('Imported ' + result.importedChats + ' chats.');
    } catch (err) {
      showToast(err && err.message ? err.message : 'Import failed.');
    }
  }

  // --- Drawer swipe-to-dismiss (anim-06 §1d) ------------------------------------------
  function bindDrawerDrag() {
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastT = 0;
    let velocity = 0;
    let dragging = false;
    let pointerId = null;

    drawer.addEventListener('pointerdown', (e) => {
      // Rows, inputs and buttons own their own gestures — the drawer drag
      // only starts from chrome (header, profile, empty state, footer).
      if (e.target.closest('.history-row, .history-search, button, input, .chat-menu, a')) return;
      if (e.button != null && e.button !== 0) return;
      pointerId = e.pointerId;
      startX = lastX = e.clientX;
      startY = e.clientY;
      lastT = e.timeStamp || Date.now();
      velocity = 0;
      dragging = false;
    });
    drawer.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const now = e.timeStamp || Date.now();
      velocity = (e.clientX - lastX) / Math.max(1, now - lastT);
      lastX = e.clientX;
      lastT = now;
      if (!dragging) {
        if (dx < -HOLD.MOVE_CANCEL_PX && Math.abs(dx) > Math.abs(dy)) {
          dragging = true;
          drawer.style.transition = 'none';
        } else if (Math.abs(dy) > HOLD.MOVE_CANCEL_PX || dx > HOLD.MOVE_CANCEL_PX) {
          pointerId = null; // not a dismiss drag
        }
        return;
      }
      const width = drawer.getBoundingClientRect().width;
      drawer.style.transform = 'translateX(' + Math.max(-width, Math.min(0, dx)) + 'px)';
      if (scrim) scrim.style.opacity = String(0.35 * (1 - Math.abs(dx) / width));
    });
    function endDrag(e) {
      if (e.pointerId !== pointerId || !dragging) { pointerId = null; return; }
      pointerId = null;
      dragging = false;
      const dx = e.clientX - startX;
      const width = drawer.getBoundingClientRect().width;
      drawer.style.transition = '';
      if (scrim) scrim.style.opacity = '';
      if (decideDrawerDismiss(dx, width, velocity)) {
        // Finish the dismissal (200 ms ease-in), then let app.js hide it.
        drawer.style.transition = 'transform 200ms var(--ease-in), opacity 200ms var(--ease-in)';
        drawer.style.transform = 'translateX(-100%)';
        drawer.style.opacity = '0.6';
        window.setTimeout(() => {
          drawer.style.transition = '';
          drawer.style.transform = '';
          drawer.style.opacity = '';
          if (root.HelloAI.closeHistory) root.HelloAI.closeHistory();
        }, 200);
      } else {
        drawer.style.transition = 'transform 300ms var(--ease-out-emph)';
        drawer.style.transform = '';
        window.setTimeout(() => { drawer.style.transition = ''; }, 310);
      }
    }
    drawer.addEventListener('pointerup', endDrag);
    drawer.addEventListener('pointercancel', (e) => { pointerId = null; dragging = false; });
  }

  // --- Drawer open/close observation ---------------------------------------------------
  function bindDrawerObserver() {
    const observer = new MutationObserver(() => {
      const isOpen = !drawer.hidden;
      if (isOpen) {
        if (state.listChanged) render();
        // Relative times refresh every 60 s while the drawer is open.
        if (!timeTimer) {
          timeTimer = window.setInterval(() => {
            if (!list) return;
            list.querySelectorAll('.history-row-wrap').forEach((w) => {
              const chat = state.chats.find((c) => c.id === w.dataset.chatId);
              const timeEl = w.querySelector('.row-time');
              if (chat && timeEl) timeEl.textContent = store.relativeTime(chat.updatedAt);
            });
          }, 60000);
        }
      } else {
        if (timeTimer) { window.clearInterval(timeTimer); timeTimer = null; }
        closeMenu();
        closeOpenSwipe();
      }
    });
    observer.observe(drawer, { attributes: true, attributeFilter: ['hidden'] });
  }

  // --- Drawer footer (export / import / archive + privacy copy) -------------------------
  function buildFooter() {
    const footer = make('div', 'drawer-footer');
    footer.appendChild(make(
      'p',
      'drawer-privacy',
      'Your chats stay on this device — they are not uploaded or synced to other devices.'
    ));
    const actions = make('div', 'drawer-footer-actions');
    const exportBtn = make('button', 'drawer-footer-btn pressable', 'Export all chats');
    exportBtn.type = 'button';
    exportBtn.addEventListener('click', exportAll);
    const importBtn = make('button', 'drawer-footer-btn pressable', 'Import chats');
    importBtn.type = 'button';
    const fileInput = doc.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.className = 'visually-hidden';
    fileInput.setAttribute('aria-label', 'Choose a history export file to import');
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files[0]) importAll(fileInput.files[0]);
      fileInput.value = '';
    });
    importBtn.addEventListener('click', () => fileInput.click());
    archivedBtn = make('button', 'drawer-footer-btn pressable', 'Archived chats (0)');
    archivedBtn.type = 'button';
    archivedBtn.addEventListener('click', () => {
      state.showArchived = !state.showArchived;
      state.listChanged = true;
      render();
    });
    actions.appendChild(exportBtn);
    actions.appendChild(importBtn);
    actions.appendChild(archivedBtn);
    footer.appendChild(actions);
    footer.appendChild(fileInput);
    drawer.appendChild(footer);
  }

  // --- Boot ------------------------------------------------------------------------------
  function boot() {
    if (state.booted) return;
    state.booted = true;
    drawer = el('historyDrawer');
    scrim = el('historyScrim');
    list = el('historyList');
    searchInput = el('historySearch');
    emptyState = el('historyEmptyState');
    toastRoot = el('toastRoot');
    if (!drawer || !list) return;

    // "Start a new chat" CTA under the empty state (the shell <p> holds the
    // copy; the button is the action — index.html is owned by foundation).
    emptyCta = make('button', 'empty-cta pressable', 'Start a new chat');
    emptyCta.type = 'button';
    emptyCta.hidden = true;
    emptyCta.addEventListener('click', newChat);
    drawer.insertBefore(emptyCta, emptyState ? emptyState.nextSibling : null);

    buildFooter();
    bindDrawerDrag();
    bindDrawerObserver();

    if (searchInput) {
      searchInput.addEventListener('input', () => {
        state.query = searchInput.value;
        render();
      });
    }
    const newChatBtn = el('newChatBtn');
    if (newChatBtn) newChatBtn.addEventListener('click', newChat);

    doc.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && menuEl) { closeMenu(); }
    });
    doc.addEventListener('hello-ai:storage-full', (e) => {
      const msg = (e.detail && e.detail.message) || 'Storage full.';
      showToast(msg);
    });

    loadChats();
  }

  // --- Public API --------------------------------------------------------------------------
  historyUI.openChat = openChat;
  historyUI.newChat = newChat;
  historyUI.refresh = loadChats;
  historyUI.setCurrentChatId = function (id) { state.currentChatId = id || null; };
  historyUI.getCurrentChatId = function () { return state.currentChatId; };

  /**
   * chat.js calls this after a message is stored (or after the AI title
   * arrives): the row's preview/time/title update in place; if the chat is
   * brand new, it enters with the one-time gold highlight (anim-06 §8).
   */
  historyUI.refreshRow = async function (chatId) {
    if (!store) return;
    try {
      const fresh = await store.getChat(chatId);
      if (!fresh) return;
      const existing = state.chats.find((c) => c.id === chatId);
      if (!existing) {
        state.chats.unshift(fresh);
        state.highlightId = chatId; // new-chat row: highlight once
        state.listChanged = true;
        render();
      } else {
        Object.assign(existing, fresh);
        // Recency changed: re-sort and re-render so the row moves to the top.
        state.chats = store.sortChats(state.chats);
        render();
      }
    } catch (_e) { /* history is best-effort; the chat itself already worked */ }
  };
  historyUI.notifyMessage = historyUI.refreshRow;

  /**
   * Today's chats, for the panel's "Today's recap" (second fallback after
   * store.getChatsForDate). Async — panel.js awaits it via Promise.resolve().
   */
  historyUI.getTodayChats = async function () {
    if (!store || typeof store.getChatsForDate !== 'function') return [];
    return store.getChatsForDate(new Date());
  };

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  return { historyUI, pure: { decideSwipeRelease, decideDrawerDismiss, HOLD, SWIPE } };
});
