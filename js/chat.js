/* ==========================================================================
   Hello AI — js/chat.js (CHAT CORE)
   Send / stream / render, /health status pill (60 s), 240 s timeout,
   cancel, scroll pin, composer morph, chips, new-chat (transient draft).

   Owns: js/chat.js, css/chat.css. Does NOT touch the backend, index.html,
   or files owned by other modules (foundation/app.js, greeting, titles,
   voice, history/store, panel). Frontend only, vanilla JS, no frameworks.

   Live-only: when the backend is down or a request fails, the ONLY text
   shown is config.offlineMessage — no canned answers, ever.
   Rendering safety: ALL user/LLM text goes through textContent only.
   Never innerHTML, never eval(). (security-and-hardening skill: LLM output
   is untrusted input.)

   Backend contract (kept exactly as the live site uses it):
     POST {backendUrl}/api/chat   JSON {message}  (only the current chat's
       message — no history, no other chats' messages)
       header 'ngrok-skip-browser-warning': 'true'
       240 s AbortController timeout (config.chatTimeoutMs)
       reply read from data.reply || data.response || data.answer
         || data.text || data.message (live backend returns {reply})
     GET  {backendUrl}/health     cache: 'no-store', 10 s timeout
       on load + every 60 s (config.healthCheckIntervalMs)

   The backend answers in ONE JSON reply (no SSE). "Streaming" here is the
   render: the full reply is revealed word-by-word (anim-02 §4) with a
   pulsing caret, batched at most 5 words per paint batch.
   ========================================================================== */
(function () {
  "use strict";

  var config = window.HELLO_AI_CONFIG || {};
  var BACKEND_URL = typeof config.backendUrl === "string"
    ? config.backendUrl.replace(/\/+$/, "")
    : "";
  var CHAT_TIMEOUT_MS = config.chatTimeoutMs || 240000;
  var HEALTH_INTERVAL_MS = config.healthCheckIntervalMs || 60000;
  var OFFLINE_MESSAGE = config.offlineMessage ||
    "Backend offline — Live AI is starting, please wait a moment and try again.";
  var MAX_MESSAGE_CHARS = 4000; // matches the backend's own cap (app.py)

  /* --- Long-wait escalation (anim-02 §6): labels at 8/15/30/60/120 s. --- */
  var ESCALATION_STEPS = [
    { at: 8000,   label: "Still thinking…",                          breatheMs: 3200 },
    { at: 15000,  label: "Thinking hard on this one…",              breatheMs: 3200 },
    { at: 30000,  label: "Still working — this can take a minute…", breatheMs: 3200, showCancel: true },
    { at: 60000,  label: "Still going — the AI is thinking through a long reply…", breatheMs: 4000 },
    { at: 120000, label: "Taking longer than usual — still trying…", breatheMs: 4000 }
  ];
  var PIN_ZONE_PX = 64; // scroll pin zone (anim-03 §2.4)
  var DONE_HOLD_MS = 480; // "Done ✓" held before the pill returns to Live

  var reducedMotion = typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* --- State --- */
  var online = null;          // null = unknown/checking, true = live, false = offline
  var activity = "idle";      // idle | thinking | generating | done | error
  var streaming = false;      // a reply request is in flight
  var currentController = null;
  var currentChat = null;     // transient draft until store.js lands (see below)
  var messages = [];          // in-memory transcript of the CURRENT chat only
  var runSender = null;       // last bubble sender, for follow-up grouping
  var runCount = 0;           // bubbles in the current same-sender run
  var lastRunAt = 0;
  var newSinceScrolledUp = 0; // unseen messages, for the jump pill badge
  var userPinned = true;      // scroll position is inside the 64 px pin zone
  var scrollRafPending = false;
  var escalationTimers = [];
  var pendingBreatheMs = 0;   // applied at the next orb loop boundary
  var doneTimer = null;
  var healthTimer = null;
  var healthController = null;
  var pillSwapToken = 0;
  var voicePromise = null;    // lazy voice.js import, created once
  var titleRequestedFor = null;
  var MALAYALAM_KEY = "helloai.malayalamMode"; // flag owned by panel.js
  var MALAYALAM_INSTRUCTION = "Please reply in Malayalam.";
  var malayalamMode = false;  // refreshed from the flag on every send

  /* --- DOM --- */
  var chatList, chatEmptyState, jumpBtn, chatTitleEl, chatComposer,
      composerMount, voiceDisclosure, chipsRow, livePolite;

  function $(id) { return document.getElementById(id); }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function announce(text) {
    if (livePolite) livePolite.textContent = text;
  }

  /* --- Malayalam mode (panel.js owns the toggle + the persisted flag;
         chat.js owns making the reply actually come back in Malayalam).
         The instruction is prepended to the text SENT to the backend
         only — the user's visible bubble always shows exactly what they
         typed. The flag is re-read on every send (and on the
         hello-ai:malayalam-mode event), so the toggle works no matter
         which module initialised first. --- */
  function isMalayalamMode() {
    try {
      if (window.HelloAI && window.HelloAI.panel &&
          typeof window.HelloAI.panel.isMalayalamMode === "function") {
        return !!window.HelloAI.panel.isMalayalamMode();
      }
    } catch (e) { /* fall through to the stored flag */ }
    try { return window.localStorage.getItem(MALAYALAM_KEY) === "1"; }
    catch (e) { return false; }
  }

  function toast(text) {
    var root = $("toastRoot");
    if (!root) return;
    var t = el("div", "toast is-entering", text);
    root.textContent = "";
    root.appendChild(t);
    window.setTimeout(function () {
      t.classList.remove("is-entering");
      t.classList.add("is-exiting");
      window.setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 220);
    }, 2500);
  }

  /* ========================================================================
     Status pill — ALL [data-status-pill] instances, together.
     There is no single #statusPill any more (foundation contract).
     States: checking (amber) / live (green "Live AI") / offline (red)
     / thinking (amber, breathing) / generating (teal, pulsing)
     / done (green "Done ✓", check pop, held 480 ms) / error (red).
     Colour is never the only signal: dot + label text change together.
     ======================================================================== */
  function setPill(state, label) {
    activity = state;
    var pills = document.querySelectorAll("[data-status-pill]");
    var swapId = ++pillSwapToken;
    pills.forEach(function (pill) {
      var dot = pill.querySelector("[data-status-dot]");
      var textEl = pill.querySelector("[data-status-text]");
      if (!dot || !textEl) return;
      var dotClass = "dot status-dot";
      // Idle is not one colour: it reflects health — green when live,
      // red when offline, amber while still checking.
      if (state === "live" || state === "done" ||
          (state === "idle" && online === true)) dotClass += " green";
      else if (state === "thinking") dotClass += " amber";
      else if (state === "generating") dotClass += " teal";
      else if (state === "offline" || state === "error" ||
          (state === "idle" && online === false)) dotClass += " red";
      else dotClass += " amber"; // checking
      dot.className = dotClass;
      dot.textContent = state === "done" ? "✓" : "";
      dot.classList.toggle("dot--check", state === "done");
      // Label crossfade (250 ms, anim-02 §5): out 120 ms, in starts at 80 ms.
      if (reducedMotion || textEl.textContent === label) {
        textEl.textContent = label;
        return;
      }
      textEl.classList.add("pill-label--out");
      window.setTimeout(function () {
        if (swapId !== pillSwapToken) return; // a newer state won
        textEl.textContent = label;
        textEl.classList.remove("pill-label--out");
        textEl.classList.add("pill-label--in");
        window.setTimeout(function () { textEl.classList.remove("pill-label--in"); }, 260);
      }, 120);
    });
    updateSendState();
  }

  function renderPill() {
    if (activity === "thinking") { setPill("thinking", currentThinkingLabel()); return; }
    if (activity === "generating") { setPill("generating", "Generating…"); return; }
    if (activity === "done") { setPill("done", "Done ✓"); return; }
    if (activity === "error") { setPill("error", online === false ? "Offline" : "Error"); return; }
    if (online === false) { setPill("idle", "Offline"); return; }
    if (online === true) { setPill("idle", "Live AI"); return; }
    setPill("idle", "Checking backend…");
  }

  /* ========================================================================
     /health — on load + every 60 s. Never blocks the chat.
     A 2xx is "live". A JSON {status:"degraded"} still means reachable:
     live, with the pill showing "Starting…" until the next check says ok.
     Any network/HTTP failure is offline: send is disabled.
     ======================================================================== */
  function checkHealth() {
    if (!BACKEND_URL) { setOnline(false); return Promise.resolve(false); }
    if (healthController) { try { healthController.abort(); } catch (e) { /* already done */ } }
    healthController = new AbortController();
    var timer = window.setTimeout(function () {
      try { healthController.abort(); } catch (e) { /* ignore */ }
    }, 10000);
    return fetch(BACKEND_URL + "/health", {
      method: "GET",
      cache: "no-store",
      signal: healthController.signal
    }).then(function (res) {
      window.clearTimeout(timer);
      if (!res || !res.ok) { setOnline(false); return false; }
      return res.json().catch(function () { return null; }).then(function (data) {
        if (data && data.status === "degraded") { setOnline(true, true); return true; }
        setOnline(true, false);
        return true;
      });
    }).catch(function () {
      window.clearTimeout(timer);
      setOnline(false);
      return false;
    });
  }

  function setOnline(value, degraded) {
    var changed = online !== value;
    online = value;
    if (value === true && activity === "error") {
      // Recovered after an error: the pill goes back to Live, not stuck
      // on "Offline"/"Error" until the next send.
      activity = "idle";
      setPill("idle", degraded ? "Starting…" : "Live AI");
    } else if (activity === "idle") {
      if (value === false) setPill("idle", "Offline");
      else if (degraded) setPill("idle", "Starting…");
      else setPill("idle", "Live AI");
    }
    if (changed && value === false) {
      // Backend just went down mid-session: the send button disables now;
      // the honest offline message appears only if a send is attempted.
      updateSendState();
    }
    updateSendState();
  }

  function startHealthLoop() {
    checkHealth();
    if (healthTimer) window.clearInterval(healthTimer);
    healthTimer = window.setInterval(checkHealth, HEALTH_INTERVAL_MS);
  }

  /* ========================================================================
     Composer morph — ONE morphing composer (decision, see build-notes/chat.md).
     #chatComposer is the only composer. On home it lives in #composerMount;
     on chat it docks back in #chatScreen before #voiceDisclosure. The static
     home form from the shell is removed at boot; text, focus, disabled
     state and the voice wiring travel with the one element, so nothing can
     desync between two instances. FLIP glide (450 ms, --ease-drawer) on
     screen change; instant when reduced motion is on.
     ======================================================================== */
  function placeComposer(screenId, animate) {
    if (!chatComposer) return;
    var target, anchor = null;
    if (screenId === "homeScreen") {
      target = composerMount;
      chatComposer.classList.add("composer--home");
      setComposerPlaceholder("Ask anything…");
    } else if (screenId === "chatScreen") {
      var chatScreen = $("chatScreen");
      target = chatScreen;
      anchor = voiceDisclosure; // dock directly above the voice disclosure
      chatComposer.classList.remove("composer--home");
      setComposerPlaceholder("Type a message…");
    } else {
      return; // login: leave the composer where it is (hidden with chat)
    }
    if (!target || chatComposer.parentNode === target &&
        (!anchor || chatComposer.nextSibling === anchor)) return;
    var fromRect = null;
    if (animate && !reducedMotion && chatComposer.getBoundingClientRect) {
      fromRect = chatComposer.getBoundingClientRect();
    }
    if (anchor) target.insertBefore(chatComposer, anchor);
    else target.appendChild(chatComposer);
    if (fromRect) {
      var toRect = chatComposer.getBoundingClientRect();
      var dx = fromRect.left - toRect.left;
      var dy = fromRect.top - toRect.top;
      if (dx !== 0 || dy !== 0) {
        chatComposer.classList.add("composer--moving");
        chatComposer.style.transform =
          "translate(" + dx + "px," + dy + "px)";
        void chatComposer.offsetWidth; // reflow so the transition runs
        chatComposer.style.transform = "";
        window.setTimeout(function () {
          chatComposer.classList.remove("composer--moving");
        }, 480);
      }
    }
  }

  function setComposerPlaceholder(text) {
    var input = composerInput();
    if (input) input.setAttribute("placeholder", text);
  }

  function composerInput() {
    return chatComposer ? chatComposer.querySelector(".composer-input") : null;
  }

  function composerSendBtn() {
    return chatComposer ? chatComposer.querySelector(".composer-send") : null;
  }

  function composerMicBtn() {
    return chatComposer ? chatComposer.querySelector(".composer-mic") : null;
  }

  /* --- Auto-grow + send-button visibility (send appears only with text). --- */
  function autoGrow(input) {
    if (!input) return;
    input.style.height = "auto";
    var max = 140; // ~5 lines; beyond that the field scrolls internally
    input.style.height = Math.min(input.scrollHeight, max) + "px";
  }

  function refreshComposerState() {
    var input = composerInput();
    if (!input || !chatComposer) return;
    var hasText = input.value.trim().length > 0;
    chatComposer.classList.toggle("has-text", hasText);
    autoGrow(input);
    updateSendState();
  }

  function updateSendState() {
    var btn = composerSendBtn();
    if (!btn) return;
    var input = composerInput();
    var empty = !input || input.value.trim().length === 0;
    // Disabled while a reply streams AND while offline (PLAN §6.2) —
    // but NEVER via the `disabled` attribute: a disabled button cannot
    // be tapped, so an offline tap gave no feedback at all (QA req #5).
    // aria-disabled + .is-disabled keep it visibly disabled, and the
    // click handler in bindComposer surfaces the offline message.
    // Empty is handled by hiding the button (CSS .has-text), not by
    // disabling it, so the wake-pop edge stays observable.
    btn.disabled = false;
    var unavailable = streaming || online === false;
    btn.setAttribute("aria-disabled", unavailable ? "true" : "false");
    btn.classList.toggle("is-disabled", unavailable);
    btn.classList.toggle("is-sending", streaming);
    btn.setAttribute("aria-label",
      streaming ? "Sending…" : (online === false ? "Send message (backend offline)" : "Send message"));
    if (chatComposer) chatComposer.classList.toggle("is-offline", online === false);
    void empty;
  }

  /* Shrink the composer back to one line after send (anim-01 §5 — the sole
     layout exception, 220 ms). Focus is never moved; the keyboard stays open. */
  function shrinkComposer() {
    var input = composerInput();
    if (!input) return;
    if (reducedMotion) { input.style.height = ""; return; }
    var h0 = input.offsetHeight;
    input.value = "";
    var h1 = input.scrollHeight; // single-line height once cleared
    input.style.height = h0 + "px";
    void input.offsetHeight;
    input.classList.add("is-animating-height");
    input.style.height = h1 + "px";
    window.setTimeout(function () {
      input.classList.remove("is-animating-height");
      input.style.height = "";
    }, 240);
  }

  /* ========================================================================
     Scroll — pin zone 64 px (anim-03 §2.4). Auto-scroll only when pinned,
     never when scrolled up. A new user message ALWAYS scrolls to bottom.
     Scroll corrections during streaming: at most one per rAF.
     ======================================================================== */
  function isPinned() {
    if (!chatList) return true;
    return chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight <= PIN_ZONE_PX;
  }

  function scrollToBottom(smooth) {
    if (!chatList) return;
    chatList.scrollTo({
      top: chatList.scrollHeight,
      behavior: (smooth && !reducedMotion) ? "smooth" : "auto"
    });
    newSinceScrolledUp = 0;
    hideJumpPill();
  }

  function maybeScrollToBottom() {
    if (!userPinned) return;
    if (scrollRafPending) return;
    scrollRafPending = true;
    window.requestAnimationFrame(function () {
      scrollRafPending = false;
      if (userPinned && chatList) {
        chatList.scrollTop = chatList.scrollHeight - chatList.clientHeight;
      }
    });
  }

  function onChatScroll() {
    userPinned = isPinned();
    if (userPinned) {
      newSinceScrolledUp = 0;
      hideJumpPill();
    } else if (newSinceScrolledUp > 0) {
      showJumpPill();
    }
  }

  function showJumpPill() {
    if (!jumpBtn) return;
    jumpBtn.hidden = false;
    jumpBtn.textContent = newSinceScrolledUp >= 2
      ? "↓ " + newSinceScrolledUp + " new"
      : "↓ Jump to latest";
    jumpBtn.classList.remove("is-exiting");
    jumpBtn.classList.add("is-entering");
  }

  function hideJumpPill() {
    if (!jumpBtn || jumpBtn.hidden) return;
    jumpBtn.classList.remove("is-entering");
    jumpBtn.classList.add("is-exiting");
    window.setTimeout(function () {
      jumpBtn.hidden = true;
      jumpBtn.classList.remove("is-exiting");
    }, reducedMotion ? 0 : 130);
  }

  function noteNewContent() {
    if (!userPinned) {
      newSinceScrolledUp += 1;
      showJumpPill();
    }
  }

  /* ========================================================================
     Bubbles — textContent only, never innerHTML (anim-03 entrances).
     Follow-ups: 2nd/3rd same-sender bubble 180 ms / 6 px rise, 60 ms
     stagger; 4th+ opacity-only 120 ms (burst cap 300 ms).
     ======================================================================== */
  function bubbleClassFor(role) {
    var now = Date.now();
    var isFollow = role === runSender && (now - lastRunAt) < 60000;
    runCount = isFollow ? runCount + 1 : 1;
    runSender = role;
    lastRunAt = now;
    if (runCount === 1) return role === "user" ? "msg--user" : "msg--ai";
    if (runCount <= 3) return (role === "user" ? "msg--user" : "msg--ai") + " msg--follow";
    return (role === "user" ? "msg--user" : "msg--ai") + " msg--burst";
  }

  function createBubble(role, text, opts) {
    opts = opts || {};
    var bubble = el("div", "msg " + bubbleClassFor(role));
    bubble.setAttribute("role", "listitem");
    // data-role is the hook panel.js's DOM fallback reads for the last AI
    // answer / current chat text ([data-role="assistant"]).
    bubble.setAttribute("data-role", role);
    if (opts.error) bubble.classList.add("msg--error");
    var body = el("div", "msg__text", text); // textContent only
    bubble.appendChild(body);
    if (role === "assistant" && !opts.error) {
      // Source label, kept on every AI reply (PLAN §6.1: "Dolphin · Live").
      bubble.appendChild(el("div", "msg__source", "Dolphin · Live"));
    }
    if (opts.error) {
      var retry = el("button", "msg__retry pressable", "Try again");
      retry.type = "button";
      retry.addEventListener("click", function () {
        if (opts.onRetry) opts.onRetry();
      });
      bubble.appendChild(retry);
    }
    if (opts.staggerMs) bubble.style.animationDelay = opts.staggerMs + "ms";
    bubble.addEventListener("animationend", function onEnd() {
      bubble.removeEventListener("animationend", onEnd);
      bubble.style.willChange = "";
      bubble.style.animationDelay = "";
    });
    bubble.style.willChange = "transform, opacity";
    return bubble;
  }

  function appendBubble(bubble) {
    if (chatEmptyState) chatEmptyState.hidden = true;
    chatList.appendChild(bubble);
    noteNewContent();
    return bubble;
  }

  function hideEmptyState() {
    if (chatEmptyState) chatEmptyState.hidden = true;
  }

  /* --- Send ghost (anim-01 §3): the text flies composer → bubble, 260 ms,
         arc up-right, capped at 1/3 of the screen height. Never created
         under reduced motion. The real textarea is cleared in the same
         frame; the ghost IS the text now. --- */
  function flyGhost(text, bubble) {
    if (reducedMotion) return;
    var input = composerInput();
    if (!input || !bubble) return;
    var from = input.getBoundingClientRect();
    var to = bubble.getBoundingClientRect();
    var dx = (to.right - 12) - from.left;
    var dy = (to.bottom - 8) - from.top;
    var cap = window.innerHeight / 3;
    if (Math.abs(dy) > cap) {
      var scale = cap / Math.abs(dy);
      dy *= scale; dx *= scale;
    }
    var ghost = el("div", "send-ghost", text.length > 120 ? text.slice(0, 120) + "…" : text);
    ghost.setAttribute("aria-hidden", "true");
    ghost.style.left = from.left + "px";
    ghost.style.top = from.top + "px";
    ghost.style.maxWidth = Math.max(120, from.width) + "px";
    document.body.appendChild(ghost);
    var anim = ghost.animate([
      { transform: "translate(0, 0) scale(1)", opacity: 1 },
      { transform: "translate(" + (dx * 0.55) + "px," + (dy * 0.55 - 10) + "px) scale(0.98)", opacity: 1, offset: 0.45 },
      { transform: "translate(" + (dx * 0.9) + "px," + (dy * 0.9) + "px) scale(0.96)", opacity: 0.9, offset: 0.7 },
      { transform: "translate(" + dx + "px," + dy + "px) scale(0.94)", opacity: 0 }
    ], { duration: 260, delay: 80, easing: "cubic-bezier(0.32, 0.72, 0, 1)", fill: "forwards" });
    anim.onfinish = function () { if (ghost.parentNode) ghost.parentNode.removeChild(ghost); };
    window.setTimeout(function () { if (ghost.parentNode) ghost.parentNode.removeChild(ghost); }, 600);
  }

  /* ========================================================================
     Thinking indicator — breathing liquid orb, 28 px, 2400 ms breathe
     (anim-02 §2). NOT three dots. Capsule entrance 350 ms; the label
     shimmers; the orb's breathe slows at escalation steps (applied at a
     loop boundary so the breath never jumps mid-cycle).
     ======================================================================== */
  var thinkingEl = null, thinkingLabelEl = null, thinkingOrbEl = null,
      cancelBtnEl = null, thinkingLabel = "Thinking…";

  function currentThinkingLabel() { return thinkingLabel; }

  function showThinking() {
    hideThinking();
    thinkingLabel = "Thinking…";
    thinkingEl = el("div", "msg thinking");
    thinkingEl.setAttribute("role", "status");
    thinkingEl.setAttribute("aria-live", "polite");
    var glow = el("span", "thinking__glow", "");
    glow.setAttribute("aria-hidden", "true");
    thinkingOrbEl = el("span", "thinking-orb thinking__orb", "");
    thinkingOrbEl.setAttribute("aria-hidden", "true");
    thinkingLabelEl = el("span", "thinking__label", "Thinking…");
    cancelBtnEl = el("button", "chat-cancel", "Cancel");
    cancelBtnEl.type = "button";
    cancelBtnEl.setAttribute("aria-label", "Cancel the current reply");
    cancelBtnEl.addEventListener("click", function () { cancelCurrent("user"); });
    thinkingEl.appendChild(glow);
    thinkingEl.appendChild(thinkingOrbEl);
    thinkingEl.appendChild(thinkingLabelEl);
    thinkingEl.appendChild(cancelBtnEl);
    thinkingEl.addEventListener("animationiteration", function (e) {
      if (e.target === thinkingOrbEl && pendingBreatheMs > 0) {
        thinkingOrbEl.style.animationDuration = pendingBreatheMs + "ms";
        pendingBreatheMs = 0;
      }
    });
    appendBubble(thinkingEl);
    maybeScrollToBottom();
    announce("AI is thinking");
    startEscalation();
  }

  function hideThinking() {
    clearEscalation();
    pendingBreatheMs = 0;
    if (thinkingEl && thinkingEl.parentNode) thinkingEl.parentNode.removeChild(thinkingEl);
    thinkingEl = null; thinkingLabelEl = null; thinkingOrbEl = null; cancelBtnEl = null;
  }

  function setThinkingLabel(label) {
    thinkingLabel = label;
    if (!thinkingLabelEl) return;
    if (reducedMotion) { thinkingLabelEl.textContent = label; return; }
    thinkingLabelEl.classList.add("thinking__label--out");
    window.setTimeout(function () {
      if (!thinkingLabelEl) return;
      thinkingLabelEl.textContent = label;
      thinkingLabelEl.classList.remove("thinking__label--out");
    }, 120);
  }

  function startEscalation() {
    clearEscalation();
    var startedAt = Date.now();
    ESCALATION_STEPS.forEach(function (step) {
      escalationTimers.push(window.setTimeout(function () {
        if (!thinkingEl) return;
        setThinkingLabel(step.label);
        // The pill stays "Thinking…" — the capsule carries the escalated
        // detail. Only at 120 s does the pill gain the elapsed hint
        // (anim-02 §6): "Thinking… · 2m", updated once, never ticking.
        if (step.at === 120000) setPill("thinking", "Thinking… · 2m");
        if (step.breatheMs && thinkingOrbEl) pendingBreatheMs = step.breatheMs;
        if (step.showCancel && cancelBtnEl) cancelBtnEl.classList.add("is-visible");
        if (thinkingEl) thinkingEl.classList.add("thinking--deep");
      }, step.at));
    });
    void startedAt;
  }

  function clearEscalation() {
    escalationTimers.forEach(function (t) { window.clearTimeout(t); });
    escalationTimers = [];
  }

  /* ========================================================================
     Streaming reveal — word-by-word fade-up (anim-02 §4): 160 ms, 4 px rise,
     24 ms stagger, max 5 words per paint batch, one batch per rAF.
     Caret: 2 px teal bar, 1060 ms soft pulse, opacity only.
     ======================================================================== */
  function revealWords(bubble, text, onDone) {
    var body = bubble.querySelector(".msg__text");
    var caret = el("span", "stream-caret", "");
    caret.setAttribute("aria-hidden", "true");
    if (reducedMotion) {
      body.textContent = text;
      onDone();
      return;
    }
    var words = text.split(/(\s+)/); // keep whitespace as separate tokens
    var i = 0;
    function batch() {
      if (!bubble.isConnected) { onDone(); return; }
      var count = 0;
      while (i < words.length && count < 5) {
        var token = words[i++];
        if (token === "") continue;
        if (/^\s+$/.test(token)) {
          body.appendChild(document.createTextNode(token));
          continue;
        }
        var w = el("span", "stream-word", token);
        w.style.animationDelay = (count * 24) + "ms";
        body.appendChild(w);
        count++;
      }
      if (caret.parentNode !== body) body.appendChild(caret);
      else body.appendChild(caret); // keep the caret at the very end
      maybeScrollToBottom();
      if (i < words.length) {
        window.requestAnimationFrame(batch);
      } else {
        if (caret.parentNode) caret.parentNode.removeChild(caret);
        onDone();
      }
    }
    window.requestAnimationFrame(batch);
  }

  function settleCaret(bubble) {
    var caret = bubble.querySelector(".stream-caret");
    if (caret && caret.parentNode) caret.parentNode.removeChild(caret);
  }

  /* ========================================================================
     Chat record — a chat row is created in the store ONLY when the first
     user message is sent (PLAN §7.2). Before that there is no row, no
     title, no history entry — the home screen is just a draft composer.
     Store contract (window.HelloAI.store; window.HelloAIStore is kept as
     a legacy fallback alias): createChat({id, title, titleSource,
     titleManual, preview}) -> Promise<{id}> | {id} | id,
     addMessage(chatId, role, content), updateChat(chatId, patch),
     getChat(chatId) -> Promise<chat> | chat. All store methods are
     async (Dexie); every call is guarded and fire-and-forget, so a
     store failure never breaks the chat. The draft id is passed to
     createChat so the store row keeps the same id the chat already has.
     ======================================================================== */
  function store() {
    if (window.HelloAI && window.HelloAI.store) return window.HelloAI.store;
    return window.HelloAIStore || null;
  }

  /* Adopt a store id that arrives asynchronously (createChat/getChat
     return promises): only adopt it while this chat is still current,
     and only when it is a real id — never a Promise object. */
  function adoptStoreId(chat, created) {
    if (!created || currentChat !== chat) return;
    var id = typeof created === "string" ? created : created.id;
    if (typeof id === "string" && id) chat.id = id;
  }

  function ensureChat(firstMessage) {
    if (currentChat) return currentChat;
    var title = "New chat";
    if (window.HelloAI && typeof window.HelloAI.truncateTitle === "function") {
      title = window.HelloAI.truncateTitle(firstMessage);
    } else if (typeof firstMessage === "string" && firstMessage.trim()) {
      title = firstMessage.trim().slice(0, 40);
    }
    currentChat = {
      id: "draft-" + Date.now(),
      title: title,
      titleSource: "truncated",
      titleManual: false,
      firstUserMessage: firstMessage,
      firstAssistantSnippet: "",
      firstReplyDone: false,
      createdAt: Date.now()
    };
    var s = store();
    if (s && typeof s.createChat === "function") {
      try {
        var created = s.createChat({
          id: currentChat.id,
          title: title,
          titleSource: "truncated",
          titleManual: false,
          preview: firstMessage.slice(0, 120)
        });
        if (created) {
          if (typeof created.then === "function") {
            created.then(function (c) { adoptStoreId(currentChat, c); })
              .catch(function () { /* store failure must never break the chat */ });
          } else {
            adoptStoreId(currentChat, created);
          }
        }
      } catch (e) { /* store failure must never break the chat */ }
    }
    if (chatTitleEl) chatTitleEl.textContent = title;
    dispatchChatEvent("chat-created", { chatId: currentChat.id, title: title });
    return currentChat;
  }

  function storeMessage(role, content) {
    messages.push({ role: role, content: content });
    var s = store();
    if (s && currentChat && typeof s.addMessage === "function") {
      try { s.addMessage(currentChat.id, role, content); } catch (e) { /* ignore */ }
    }
    if (s && currentChat && typeof s.updateChat === "function") {
      try {
        s.updateChat(currentChat.id, {
          preview: content.slice(0, 120),
          updatedAt: Date.now()
        });
      } catch (e) { /* ignore */ }
    }
  }

  function dispatchChatEvent(type, detail) {
    try {
      document.dispatchEvent(new CustomEvent("hello-ai:chat", {
        detail: Object.assign({ type: type }, detail || {})
      }));
    } catch (e) { /* old browsers: event is best-effort */ }
    if (window.HelloAI && typeof window.HelloAI.refreshHistoryRow === "function" &&
        detail && detail.chatId) {
      try { window.HelloAI.refreshHistoryRow(detail.chatId); } catch (e) { /* ignore */ }
    }
  }

  /* ========================================================================
     Send — the whole flow (anim-01 timeline):
       t=0    send squash (CSS :active) + button disabled, spinner on
       t=80   ghost launches, composer clears + shrinks to one line
       t=180  user bubble blooms (250 ms), list glides to bottom
       t=500  thinking capsule glides in (skipped if the reply is already here)
     Only the current chat's message is sent, as JSON {message}.
     ======================================================================== */
  function sendMessage(text, opts) {
    opts = opts || {};
    var input = composerInput();
    var raw = typeof text === "string" ? text : (input ? input.value : "");
    var message = raw.replace(/\s+$/g, "").replace(/^\s+/, "");
    if (!message) {
      // Empty send (Enter on an empty field): shake + placeholder hint,
      // no toast — the shake IS the feedback (anim-08 §7.2).
      if (chatComposer) {
        chatComposer.classList.remove("shake");
        void chatComposer.offsetWidth;
        chatComposer.classList.add("shake");
      }
      if (input) {
        input.setAttribute("placeholder", "Type a message first");
        window.setTimeout(function () {
          if (input && !input.value) setComposerPlaceholder(
            chatComposer && chatComposer.classList.contains("composer--home")
              ? "Ask anything…" : "Type a message…");
        }, 1500);
      }
      return false;
    }
    if (message.length > MAX_MESSAGE_CHARS) message = message.slice(0, MAX_MESSAGE_CHARS);
    if (streaming) return false; // send disabled while a reply streams

    // C-2 fix: a send from Home must take the user to Chat. The bubbles
    // render in #chatScreen, so sending without navigating left the user
    // staring at Home while the reply landed invisibly. This also covers
    // panel studio actions that send (Explain simply, Today's recap),
    // which route through here — only chip taps navigated before.
    if (window.HelloAI && typeof window.HelloAI.showChat === "function") {
      try { window.HelloAI.showChat(); } catch (e) { /* router is best-effort */ }
    }

    // Malayalam mode (req #4): re-read the flag on every send and prepend
    // the instruction to the BACKEND text only — the visible bubble below
    // keeps the user's original text, word for word.
    malayalamMode = isMalayalamMode();
    var backendMessage = malayalamMode
      ? MALAYALAM_INSTRUCTION + "\n\n" + message
      : message;

    if (online === false && !opts.retry) {
      // Offline: no queueing in v1 — the honest offline message, only.
      showOfflineError(message, true);
      return false;
    }

    var isFirstMessage = !currentChat;
    var chat = ensureChat(message);
    var userBubble = null;

    if (!opts.retry) {
      // Bubble first (settled by ~430 ms), thinking after (500–700 ms).
      userBubble = createBubble("user", message);
      appendBubble(userBubble);
      flyGhost(message, userBubble);
      scrollToBottom(true);
      storeMessage("user", message);
      if (isFirstMessage) unhideChips();
      dispatchChatEvent("message-sent", { chatId: chat.id });
    }

    // Composer clears + shrinks in the same frame the ghost launches.
    if (input) {
      shrinkComposer();
      input.focus({ preventScroll: true });
    }
    refreshComposerState();

    streaming = true;
    updateSendState();
    setPill("thinking", "Thinking…");
    announce("Sending message");

    var thinkingTimer = window.setTimeout(showThinking, 500);
    var controller = new AbortController();
    currentController = controller;
    var timeoutTimer = window.setTimeout(function () {
      try { controller.abort(); } catch (e) { /* already settled */ }
    }, CHAT_TIMEOUT_MS);
    var sentAt = Date.now();
    // Cancel path: cancelCurrent() sets this flag before aborting, so the
    // catch below can tell a user cancel apart from the 240 s timeout.
    var cancelledByUser = false;
    controller.signal.addEventListener("abort", function () {
      cancelledByUser = cancelWasUser;
    });
    var cancelWasUser = false;
    currentCancelFlag = function (v) { cancelWasUser = v; };

    fetch(BACKEND_URL + "/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "true"
      },
      body: JSON.stringify({ message: backendMessage }),
      signal: controller.signal
    }).then(function (res) {
      window.clearTimeout(timeoutTimer);
      window.clearTimeout(thinkingTimer);
      if (!res || !res.ok) throw new Error("backend HTTP " + (res ? res.status : "no-response"));
      return res.json().catch(function () { throw new Error("bad JSON"); });
    }).then(function (data) {
      var reply = data && (
        data.reply || data.response || data.answer || data.text || data.message
      );
      if (typeof reply !== "string" || !reply.trim()) throw new Error("empty reply");
      // First token: handover in place (anim-02 §3, 280 ms). If the reply
      // arrived before the capsule even entered (< 350 ms), skip it.
      var fast = Date.now() - sentAt < 350;
      hideThinking();
      var aiBubble = createBubble("assistant", "", { staggerMs: 0 });
      // The bubble starts empty; words stream into its .msg__text.
      aiBubble.querySelector(".msg__text").textContent = "";
      appendBubble(aiBubble);
      if (!fast) aiBubble.classList.add("msg--handover");
      setPill("generating", "Generating…");
      activity = "generating";
      storeMessage("assistant", reply);
      revealWords(aiBubble, reply, function () {
        settleCaret(aiBubble);
        finishReply(chat, reply);
      });
    }).catch(function (err) {
      window.clearTimeout(timeoutTimer);
      window.clearTimeout(thinkingTimer);
      var aborted = controller.signal.aborted;
      hideThinking();
      if (aborted && cancelledByUser) {
        // User-cancelled: no error bubble, no error text — just stop.
        streaming = false;
        currentController = null;
        updateSendState();
        renderPill();
        announce("Reply cancelled");
        dispatchChatEvent("cancelled", { chatId: chat.id });
        return;
      }
      // Timeout / network / HTTP / empty reply: the ONLY text shown is
      // the offline message. No error details, no stack, no canned answer.
      streaming = false;
      currentController = null;
      setOnline(false);
      checkHealth(); // re-probe: the backend may already be back
      showOfflineError(message, false);
      dispatchChatEvent("error", { chatId: chat.id });
    });

    // Cancel path needs to know it was the user, not the timeout.
    // (Flag + abort listener are registered above, before fetch().)
    return true;
  }

  var currentCancelFlag = null;

  function cancelCurrent(origin) {
    if (!streaming || !currentController) return false;
    if (currentCancelFlag) currentCancelFlag(true);
    try { currentController.abort(); } catch (e) { /* already settled */ }
    void origin;
    return true;
  }

  function finishReply(chat, reply) {
    streaming = false;
    currentController = null;
    updateSendState();
    setPill("done", "Done ✓");
    if (doneTimer) window.clearTimeout(doneTimer);
    doneTimer = window.setTimeout(function () {
      if (activity === "done") { activity = "idle"; renderPill(); }
    }, DONE_HOLD_MS);
    announce("Reply received");
    dispatchChatEvent("reply", { chatId: chat.id });
    maybeScrollToBottom();
    if (chat && !chat.firstReplyDone) {
      chat.firstReplyDone = true;
      chat.firstAssistantSnippet = reply.slice(0, 200);
      requestTitle(chat);
    }
  }

  /* --- AI title, fire-and-forget, once per chat (titles.js contract). --- */
  function requestTitle(chat) {
    if (!window.HelloAI || typeof window.HelloAI.requestAiTitle !== "function") return;
    if (titleRequestedFor === chat.id) return;
    titleRequestedFor = chat.id;
    window.HelloAI.requestAiTitle(BACKEND_URL, chat.firstUserMessage, chat.firstAssistantSnippet)
      .then(function (aiTitle) {
        if (!aiTitle) return; // silent fallback: keep the truncation
        // Re-read the chat at APPLY time: the user may have renamed it
        // while the title call was in flight. getChat is async (Dexie) —
        // reading .titleManual off the returned promise itself would
        // always be undefined and the guard would never fire.
        var s = store();
        var guard = Promise.resolve(null);
        if (s && typeof s.getChat === "function") {
          try { guard = Promise.resolve(s.getChat(chat.id)); } catch (e) { /* fall through */ }
        }
        return guard.then(function (fresh) {
          if (fresh && fresh.titleManual) return; // never overwrite a rename
          if (chat.titleManual) return;
          chat.title = aiTitle;
          chat.titleSource = "llm";
          if (chatTitleEl && currentChat === chat) chatTitleEl.textContent = aiTitle;
          if (s && typeof s.updateChat === "function") {
            try { s.updateChat(chat.id, { title: aiTitle, titleSource: "llm" }); } catch (e) { /* ignore */ }
          }
          dispatchChatEvent("title-updated", { chatId: chat.id, title: aiTitle });
        });
      });
  }

  /* --- Offline / error bubble: the offline message ONLY, plus Try again. --- */
  function showOfflineError(lastMessage, wasPreSend) {
    hideThinking();
    var bubble = createBubble("assistant", OFFLINE_MESSAGE, {
      error: true,
      onRetry: function () {
        if (bubble.parentNode) bubble.parentNode.removeChild(bubble);
        // Re-check health first: a retry against a dead backend just
        // shows the same message again.
        checkHealth().then(function () {
          sendMessage(lastMessage, { retry: true });
        });
      }
    });
    appendBubble(bubble);
    scrollToBottom(true);
    setPill("error", "Offline");
    updateSendState();
    announce(OFFLINE_MESSAGE);
    void wasPreSend;
  }

  /* --- New chat: clear the transcript; the store (when it lands) owns the
         row. Without store.js this clears the transcript only (noted in
         build-notes/chat.md). The old clear-chat button behaviour is gone. --- */
  function newChat() {
    if (streaming) cancelCurrent("new-chat");
    hideThinking();
    messages = [];
    currentChat = null;
    titleRequestedFor = null;
    runSender = null; runCount = 0; lastRunAt = 0;
    newSinceScrolledUp = 0;
    if (chatList) {
      var nodes = chatList.querySelectorAll(".msg");
      nodes.forEach(function (n) { n.parentNode.removeChild(n); });
    }
    if (chatEmptyState) chatEmptyState.hidden = false;
    if (chatTitleEl) chatTitleEl.textContent = "New chat";
    hideJumpPill();
    var s = store();
    if (s && typeof s.newChat === "function") {
      try { s.newChat(); } catch (e) { /* ignore */ }
    }
    dispatchChatEvent("new-chat", {});
    var input = composerInput();
    if (input) input.focus({ preventScroll: true });
    refreshComposerState();
  }

  /* --- Chips (max 4): tapping one sends its text. Unhidden after the
         first chat / on return visits (Gemini pattern, PLAN §5.1). --- */
  function unhideChips() {
    if (!chipsRow || !chipsRow.hidden) return;
    chipsRow.hidden = false;
    var chips = chipsRow.querySelectorAll(".chip");
    chips.forEach(function (chip, i) {
      chip.style.setProperty("--i", String(Math.min(i, 3)));
    });
  }

  function bindChips() {
    if (!chipsRow) return;
    chipsRow.addEventListener("click", function (e) {
      var chip = e.target.closest ? e.target.closest(".chip") : null;
      if (!chip || !chipsRow.contains(chip)) return;
      var text = chip.textContent.trim();
      if (!text) return;
      if (window.HelloAI && typeof window.HelloAI.showChat === "function") {
        window.HelloAI.showChat();
      }
      sendMessage(text);
    });
  }

  /* --- Voice mic: lazy-load voice.js on FIRST mic tap only (PLAN §10.1).
         voice.js is an ES module; chat.js is a classic script, so the
         import is dynamic. Dynamic import() from a classic script resolves
         against the DOCUMENT base URL, not this file — so the path is
         "./js/voice.js" ("./voice.js" would 404 at the site root). One
         voice instance, bound to the one morphing composer — its mic button
         travels with it. --- */
  function bindMic() {
    var mic = composerMicBtn();
    if (!mic) return;
    mic.addEventListener("click", function onFirstMicTap() {
      if (voicePromise) return; // voice.js already loading/loaded; its own listener runs
      voicePromise = import("./js/voice.js").then(function (mod) {
        var create = mod.createVoiceMic || mod.default;
        if (typeof create !== "function") return null;
        return create({
          micButton: composerMicBtn(),
          composer: composerInput()
        });
      }).catch(function () {
        // Voice unavailable: leave the mic as-is; typing still works.
        voicePromise = null;
        return null;
      });
    });
  }

  /* --- Composer wiring (both behaviours live on the ONE composer). --- */
  function bindComposer() {
    if (!chatComposer) return;
    var input = composerInput();
    var sendBtn = composerSendBtn();
    var plusBtn = chatComposer.querySelector(".composer-plus");

    // Restructure the send button for the arrow → spinner swap (anim-08 §1):
    // markup ships the sprite arrow already; if it does not (older shell),
    // build the same internals here from assets/icons/sprite.svg.
    // chat.js owns the composer, so it may rebuild the button's internals.
    if (sendBtn && !sendBtn.querySelector(".composer-send__icon")) {
      var icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.setAttribute("class", "icon composer-send__icon");
      icon.setAttribute("aria-hidden", "true");
      var use = document.createElementNS("http://www.w3.org/2000/svg", "use");
      use.setAttribute("href", "assets/icons/sprite.svg#icon-send");
      icon.appendChild(use);
      var spinner = el("span", "composer-send__spinner", "");
      spinner.setAttribute("aria-hidden", "true");
      sendBtn.textContent = "";
      sendBtn.appendChild(icon);
      sendBtn.appendChild(spinner);
    }

    if (input) {
      input.setAttribute("maxlength", String(MAX_MESSAGE_CHARS));
      input.addEventListener("input", refreshComposerState);
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          sendMessage();
        }
      });
    }
    chatComposer.addEventListener("submit", function (e) {
      e.preventDefault();
      sendMessage();
    });
    if (sendBtn) {
      // Tapping the visibly-disabled send button must explain itself
      // (QA req #5): route the tap through sendMessage(), which shows
      // the exact offline message — the same text as the Enter path.
      // preventDefault stops the form submit; sendMessage() does the
      // work (offline bubble / empty shake / nothing while streaming).
      // When the button is available this handler returns early and the
      // normal submit sends exactly once.
      sendBtn.addEventListener("click", function (e) {
        if (sendBtn.getAttribute("aria-disabled") !== "true") return;
        e.preventDefault();
        sendMessage();
      });
    }
    if (plusBtn) {
      plusBtn.addEventListener("click", function () { newChat(); });
    }
    var newChatBtn = $("newChatBtn");
    if (newChatBtn) newChatBtn.addEventListener("click", function () { newChat(); });
    bindMic();
    refreshComposerState();
  }

  /* --- Screen changes: move the single composer; hide the jump pill when
         leaving chat. app.js fires hello-ai:screen on every change. --- */
  function bindScreenEvents() {
    document.addEventListener("hello-ai:screen", function (e) {
      var screen = e && e.detail ? e.detail.screen : null;
      if (!screen) return;
      placeComposer(screen, true);
      if (screen !== "chatScreen") hideJumpPill();
      if (screen === "chatScreen") {
        userPinned = isPinned();
        maybeScrollToBottom();
      }
    });
  }

  /* --- Boot --- */
  function init() {
    chatList = $("chatList");
    chatEmptyState = $("chatEmptyState");
    jumpBtn = $("jumpToLatestBtn");
    chatTitleEl = $("chatTitle");
    chatComposer = $("chatComposer");
    composerMount = $("composerMount");
    voiceDisclosure = $("voiceDisclosure");
    chipsRow = $("chipsRow");
    livePolite = $("livePolite");
    if (!chatList || !chatComposer) return; // shell missing: nothing to wire

    // The static home composer from the shell is removed: ONE morphing
    // composer (see placeComposer). Its classes are the contract, so the
    // home form's removal changes no wiring — only the node moves.
    var homeForm = composerMount ? composerMount.querySelector("form.composer") : null;
    if (homeForm && homeForm !== chatComposer && homeForm.parentNode) {
      homeForm.parentNode.removeChild(homeForm);
    }

    if (chatList) {
      chatList.addEventListener("scroll", onChatScroll, { passive: true });
    }
    if (jumpBtn) {
      jumpBtn.addEventListener("click", function () { scrollToBottom(true); });
    }
    // Keyboard resize re-pin (anim-03 §2.4 rule 5): if pinned before the
    // resize, re-pin after it settles (debounce 100 ms).
    var resizeTimer = null;
    window.addEventListener("resize", function () {
      if (resizeTimer) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(function () {
        if (userPinned) scrollToBottom(false);
      }, 100);
    });

    bindComposer();
    bindChips();
    bindScreenEvents();

    // Malayalam mode: keep the cached flag fresh when panel.js toggles
    // it (the flag itself is also re-read on every send).
    document.addEventListener("hello-ai:malayalam-mode", function (e) {
      malayalamMode = e && e.detail ? !!e.detail.enabled : isMalayalamMode();
    });
    malayalamMode = isMalayalamMode();

    // Initial placement: app.js may already have shown a screen.
    var active = document.querySelector(".screen.is-active");
    if (active) placeComposer(active.id, false);

    setPill("idle", "Checking backend…");
    startHealthLoop();

    /* --- Panel helpers: read-only views over the in-memory transcript. --- */
    function getLastAssistantMessage() {
      for (var i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "assistant" && messages[i].content) return messages[i].content;
      }
      return null;
    }

    function getCurrentChatText() {
      if (!messages.length) return "";
      return messages.map(function (m) {
        return (m.role === "assistant" ? "AI: " : "You: ") + m.content;
      }).join("\n\n");
    }

    // Public API for app.js / panel.js / history-ui.js / voice.js.
    // One namespace, window.HelloAI.chat, is the canonical surface (see
    // build-notes/api-surface.md); the flat names are thin aliases kept
    // so older call sites keep working.
    var chatApi = {
      sendMessage: sendMessage,
      newChat: newChat,
      cancelChat: cancelCurrent,
      checkHealth: checkHealth,
      isBackendOnline: function () { return online === true; },
      isStreaming: function () { return streaming; },
      getCurrentChat: function () { return currentChat; },
      getMessages: function () { return messages.slice(); },
      getLastAssistantMessage: getLastAssistantMessage,
      getCurrentChatText: getCurrentChatText
    };
    window.HelloAI = window.HelloAI || {};
    window.HelloAI.chat = chatApi;
    window.HelloAI.sendMessage = sendMessage;
    window.HelloAI.sendChatMessage = sendMessage; // alias panel.js also tries
    window.HelloAI.newChat = newChat;
    window.HelloAI.cancelChat = cancelCurrent;
    window.HelloAI.checkHealth = checkHealth;
    window.HelloAI.isBackendOnline = chatApi.isBackendOnline;
    window.HelloAI.isStreaming = chatApi.isStreaming;
    window.HelloAI.getCurrentChat = chatApi.getCurrentChat;
    window.HelloAI.getMessages = chatApi.getMessages;
    window.HelloAI.getLastAssistantMessage = getLastAssistantMessage;
    window.HelloAI.getCurrentChatText = getCurrentChatText;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
