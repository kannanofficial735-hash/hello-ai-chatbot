/* ==========================================================================
   Hello AI — panel.js (login + account panel: panel half)
   Curved bottom panel + account sheet + the 7 studio buttons (PLAN §8).

   Ownership (foundation.md): app.js binds the panel open/close triggers
   (avatar button, #historyProfile, scrim click, Esc) and exposes
   window.HelloAI.openPanel / closePanel. This file OWNS:
   - the studio actions and sign-out wiring,
   - the panel's slide / scrim / swipe-down-dismiss animation (app.js
     only toggles `hidden`; the animation classes live here),
   - the "Manage account" button (foundation's shell has no such button
     in the markup, so it is created here at runtime — foundation should
     add it statically to index.html; see build-notes/panel-login.md),
   - a keyboard-accessible Close button (the drag gesture alone is not
     enough — WCAG 2.2 2.5.7 dragging movements need a single-pointer
     alternative; scrim tap + Esc + this button are the alternatives).

   Panel counts as navigation: the 7 studio buttons are a 2-row grid of
   ACTIONS inside one panel, not 7 nav destinations. The actual bottom
   navigation stays ≤ 5 (Home / New chat / History / Voice / Account).

   Studio wiring is DEFENSIVE: chat.js / store.js / history-ui.js have
   not landed yet, so every action first tries the real module API
   (window.HelloAI.chat / .store / .history / .voice), and only then
   falls back to something honest — filling the composer, focusing the
   history search, or saying plainly that the action needs the missing
   module. A studio button NEVER pretends to have worked when it did
   not, and NEVER sends a prompt Dolphin cannot answer from real data
   (Today's recap is not sent blind when there is no local history to
   summarise — it would hallucinate).

   Malayalam mode: a per-device toggle stored in localStorage
   (helloai.malayalamMode = "1"/"0"). panel.js owns the toggle state
   and announces it; chat.js owns prefixing replies in Malayalam and
   must read window.HelloAI.panel.isMalayalamMode() / the
   "hello-ai:malayalam-mode" event. Voice language (ml-IN) is owned by
   voice.js; this file does not change it.

   Vanilla JS only. Backend untouched. No innerHTML anywhere.
   ========================================================================== */
(function () {
  "use strict";

  var PANEL_CLOSE_MS = 350; // anim-07 §5.5/§5.6: sheet out 350 ms
  var PANEL_OPEN_MS = 500;  // anim-07 §5.5/§5.6: sheet in 500 ms
  var SWIPE_DISMISS_FRACTION = 0.30; // release past 30% of panel height
  var SWIPE_FLING_PX_PER_MS = 0.5;   // ...or a fast downward flick
  var MALAYALAM_KEY = "helloai.malayalamMode";
  var PROFILE_KEY = "hello-ai-profile"; // same key as auth.js / app.js — the sign-out fallback below removes it
  var MANAGE_ACCOUNT_URL = "https://myaccount.google.com/";

  var panel = null;
  var scrim = null;
  var closeTimer = null;
  var drag = null; // { pointerId, startY, startTime, dy } | null
  var voiceInstance = null; // createVoiceMic() instance, once loaded

  function $(id) { return document.getElementById(id); }

  function toast(message) {
    var root = $("toastRoot");
    if (!root) return;
    var node = document.createElement("div");
    node.className = "toast is-entering";
    node.textContent = message;
    root.appendChild(node);
    window.setTimeout(function () {
      node.classList.remove("is-entering");
      node.classList.add("is-exiting");
      window.setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 200);
    }, 4000);
  }

  function announce(message, assertive) {
    var el = $(assertive ? "liveAssertive" : "livePolite");
    if (el) el.textContent = message;
  }

  function helloAI() { return window.HelloAI || {}; }

  /* ------------------------------------------------------------------ */
  /* Chat send path — the one route every AI studio action uses.        */
  /* chat.js exposes window.HelloAI.chat.sendMessage(text) (canonical)  */
  /* and window.HelloAI.sendChatMessage(text) (alias); either is tried. */
  /* If neither exists, the text is placed in the visible composer      */
  /* (editable, never auto-sent) and the user is told to tap Send.     */
  /* ------------------------------------------------------------------ */
  function chatApi() {
    var api = helloAI();
    if (api.chat && typeof api.chat.sendMessage === "function") return api.chat.sendMessage;
    if (typeof api.sendChatMessage === "function") return api.sendChatMessage;
    return null;
  }

  function visibleComposer() {
    // Chat screen composer wins when visible; otherwise the home one.
    var chat = $("messageInput");
    var chatScreen = $("chatScreen");
    if (chat && chatScreen && !chatScreen.hidden) return chat;
    var home = $("homeComposerInput");
    if (home) return home;
    return document.querySelector(".composer-input");
  }

  function sendViaChat(text) {
    var send = chatApi();
    if (send) {
      try {
        send(text);
        return true;
      } catch (e) { /* fall through to the composer fallback */ }
    }
    var input = visibleComposer();
    if (input) {
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      if (helloAI().showChat) helloAI().showChat();
      input.focus({ preventScroll: true });
      toast("Ready in the composer — tap Send to ask Dolphin");
      return true;
    }
    toast("Chat is not ready yet — try again in a moment");
    return false;
  }

  /** Last AI answer, for "Explain simply". Tries chat API, then the DOM. */
  function getLastAiAnswer() {
    var api = helloAI();
    if (api.chat && typeof api.chat.getLastAssistantMessage === "function") {
      try {
        var msg = api.chat.getLastAssistantMessage();
        if (msg && String(msg).trim()) return String(msg);
      } catch (e) { /* fall through */ }
    }
    var list = $("chatList");
    if (list) {
      var nodes = list.querySelectorAll('[data-role="assistant"], .ai-message, .message-ai');
      for (var i = nodes.length - 1; i >= 0; i--) {
        var text = (nodes[i].textContent || "").trim();
        if (text) return text;
      }
    }
    return null;
  }

  /** Today's local chats, for "Today's recap". Returns a Promise (the
      store is async) or null when no history API exists — the caller
      awaits it and must NOT send a blind recap when it is null. */
  function getTodayChats() {
    var api = helloAI();
    if (api.store && typeof api.store.getChatsForDate === "function") {
      try { return api.store.getChatsForDate(new Date()) || []; } catch (e) { return []; }
    }
    if (api.history && typeof api.history.getTodayChats === "function") {
      try { return api.history.getTodayChats() || []; } catch (e) { return []; }
    }
    return null; // no history API yet — caller must NOT invent a recap
  }

  /* ------------------------------------------------------------------ */
  /* Panel open / close with animation.                                 */
  /* app.js toggles `hidden` instantly; this file adds the slide and   */
  /* the scrim fade, and delays the actual hide by the 350 ms exit so  */
  /* the sheet never vanishes mid-motion (anim-07 §5.5 E, §5.6).       */
  /* ------------------------------------------------------------------ */
  function cancelCloseTimer() {
    if (closeTimer) { window.clearTimeout(closeTimer); closeTimer = null; }
  }

  function openPanelAnimated() {
    if (!panel) return;
    cancelCloseTimer();
    panel.hidden = false;
    if (scrim) scrim.hidden = false;
    // Force reflow so the entrance animation runs from its start state.
    void panel.offsetWidth;
    panel.classList.remove("bottom-panel--closing", "bottom-panel--dragging");
    panel.classList.add("bottom-panel--open");
    if (scrim) scrim.classList.add("panel-scrim--visible");
    var avatarBtn = $("chatAvatarBtn");
    if (avatarBtn) avatarBtn.setAttribute("aria-expanded", "true");
    refreshAccountSection();
    window.setTimeout(function () { panel.classList.remove("bottom-panel--open"); }, PANEL_OPEN_MS);
  }

  function closePanelAnimated() {
    if (!panel || panel.hidden) return;
    cancelCloseTimer();
    panel.classList.remove("bottom-panel--open", "bottom-panel--dragging");
    panel.classList.add("bottom-panel--closing");
    if (scrim) scrim.classList.remove("panel-scrim--visible");
    var avatarBtn = $("chatAvatarBtn");
    if (avatarBtn) avatarBtn.setAttribute("aria-expanded", "false");
    closeTimer = window.setTimeout(function () {
      closeTimer = null;
      panel.classList.remove("bottom-panel--closing");
      panel.hidden = true;
      if (scrim) scrim.hidden = true;
      panel.style.transform = "";
      panel.style.opacity = "";
    }, PANEL_CLOSE_MS);
  }

  /* Re-fill the account section from the stored profile (app.js's
     applyProfile already does this at boot; refresh on open in case the
     profile changed since, e.g. after a fresh sign-in). */
  function refreshAccountSection() {
    var api = helloAI();
    if (api.applyProfile && api.readProfile) {
      try { api.applyProfile(api.readProfile()); } catch (e) { /* keep old text */ }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Swipe-down dismiss: panel follows the finger 1:1 (transform only; */
  /* scrim opacity follows proportionally). Release past 30% of panel  */
  /* height, or a fast downward flick, dismisses in 250 ms; otherwise  */
  /* it springs back in 300 ms (anim-07 §7, sheet dismiss).            */
  /* ------------------------------------------------------------------ */
  function onPanelPointerDown(event) {
    if (!panel || panel.hidden) return;
    if (event.target.closest("button, a, input, select, textarea, label")) return;
    if (drag) return; // ignore extra touch points mid-drag
    try { panel.setPointerCapture(event.pointerId); } catch (e) { /* no capture: still track */ }
    drag = { pointerId: event.pointerId, startY: event.clientY, startTime: performance.now(), dy: 0 };
    panel.classList.add("bottom-panel--dragging");
  }

  function onPanelPointerMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.dy = Math.max(0, event.clientY - drag.startY); // downward only
    panel.style.transform = "translateY(" + drag.dy + "px)";
    var height = panel.offsetHeight || 1;
    var progress = Math.min(1, drag.dy / height);
    panel.style.opacity = String(1 - progress * 0.45);
    if (scrim) scrim.style.opacity = String(0.4 * (1 - progress));
  }

  function onPanelPointerUp(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    var dy = drag.dy;
    var dt = Math.max(1, performance.now() - drag.startTime);
    var velocity = dy / dt;
    var height = panel.offsetHeight || 1;
    drag = null;
    panel.classList.remove("bottom-panel--dragging");
    panel.style.transform = "";
    panel.style.opacity = "";
    if (scrim) scrim.style.opacity = "";
    if (dy >= height * SWIPE_DISMISS_FRACTION || velocity >= SWIPE_FLING_PX_PER_MS) {
      closePanelAnimated();
    }
    // Below threshold: the panel simply stays (CSS transition eases it
    // back; reduced-motion: no spring, it just stays).
  }

  /* ------------------------------------------------------------------ */
  /* The 7 studio actions (PLAN §8.2). Each is wired to real behaviour */
  /* where its dependency exists, and says so where it does not.        */
  /* ------------------------------------------------------------------ */
  function actionNewChat() {
    closePanelAnimated();
    var api = helloAI();
    if (api.chat && typeof api.chat.newChat === "function") { api.chat.newChat(); return; }
    if (typeof api.newChat === "function") { api.newChat(); return; }
    var btn = $("newChatBtn");
    if (btn) { btn.click(); return; } // history/chat owner handles it
    if (api.showHome) api.showHome();
    document.dispatchEvent(new CustomEvent("hello-ai:new-chat"));
    toast("New chat — ask your first question");
  }

  function actionVoiceTalk() {
    closePanelAnimated();
    var api = helloAI();
    if (api.showChat) api.showChat();
    // Prefer the voice module's own API (js/voice.js, ES module, lazy).
    // It needs a mic button + composer; the chat composer has both.
    importVoiceAndStart().then(function (started) {
      if (started) return;
      // Fallback: tap the visible composer mic — chat.js / voice.js may
      // own it once they land. If nothing owns it, say so plainly.
      var mic = document.querySelector("#chatScreen .composer-mic") ||
        document.querySelector(".composer-mic");
      if (mic && !mic.hidden) { mic.click(); return; }
      toast("Voice talk is not ready yet — type instead for now");
    });
  }

  function importVoiceAndStart() {
    // Dynamic import() from a classic script resolves against the
    // DOCUMENT base URL, not this file — so resolve voice.js against
    // panel.js's own URL (captured from its <script> tag).
    var voiceUrl = voiceModuleUrl();
    if (!voiceUrl) return Promise.resolve(false);
    // Dynamic import() works from a classic script in modern browsers.
    // voice.js is an ES module; if the import fails (older WebView),
    // resolve false and let the caller fall back.
    return import(voiceUrl).then(function (mod) {
      var create = mod.createVoiceMic || mod.default;
      if (typeof create !== "function") return false;
      var micBtn = document.querySelector("#chatScreen .composer-mic");
      var composer = $("messageInput") || visibleComposer();
      if (!voiceInstance) {
        voiceInstance = create({ micButton: micBtn, composer: composer });
      }
      if (!voiceInstance || !voiceInstance.isSupported) return false;
      voiceInstance.start();
      return true;
    }).catch(function () { return false; });
  }

  /** Absolute URL of js/voice.js, resolved against this file's URL. */
  function voiceModuleUrl() {
    try {
      var scripts = document.querySelectorAll('script[src*="panel.js"]');
      var src = scripts.length ? scripts[scripts.length - 1].src : null;
      if (src) return new URL("./voice.js", src).href;
    } catch (e) { /* fall through */ }
    return null;
  }

  function actionSearchChats() {
    closePanelAnimated();
    var api = helloAI();
    if (api.openHistory) api.openHistory();
    else {
      var drawer = $("historyDrawer");
      if (drawer) drawer.hidden = false;
      var drawerScrim = $("historyScrim");
      if (drawerScrim) drawerScrim.hidden = false;
    }
    var search = $("historySearch");
    if (search) {
      // The drawer opens instantly (foundation); focus after a tick so
      // the input is visible when the keyboard opens.
      window.setTimeout(function () { search.focus({ preventScroll: true }); }, 60);
    }
  }

  function actionShareExport() {
    closePanelAnimated();
    var text = currentChatText();
    if (!text) {
      toast("Nothing to share yet — ask something first");
      return;
    }
    var title = "Hello AI chat";
    if (navigator.share) {
      navigator.share({ title: title, text: text }).catch(function () {
        // User cancelled the share sheet, or share failed: fall back
        // to clipboard so the action still does something useful.
        copyChatText(text);
      });
      return;
    }
    copyChatText(text);
  }

  function currentChatText() {
    var api = helloAI();
    if (api.chat && typeof api.chat.getCurrentChatText === "function") {
      try {
        var t = api.chat.getCurrentChatText();
        if (t && String(t).trim()) return String(t);
      } catch (e) { /* fall through to the DOM */ }
    }
    var list = $("chatList");
    if (list) {
      var text = (list.innerText || list.textContent || "").trim();
      // The empty state is not a chat.
      if (text && text !== "No chats yet — ask your first question.") return text;
    }
    return null;
  }

  function copyChatText(text) {
    var done = function () { toast("Chat copied — paste it anywhere to share"); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { downloadChatText(text); });
    } else {
      downloadChatText(text);
    }
  }

  function downloadChatText(text) {
    // Last resort, and the export path: a local file download, never
    // an upload anywhere.
    try {
      var blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "hello-ai-chat-" + new Date().toISOString().slice(0, 10) + ".md";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      toast("Chat downloaded as a file");
    } catch (e) {
      toast("Sharing is not available in this browser");
    }
  }

  function actionExplainSimply() {
    closePanelAnimated();
    var last = getLastAiAnswer();
    if (last) {
      var capped = last.length > 2000 ? last.slice(0, 2000) + "…" : last;
      sendViaChat("Please explain this simply, like I'm 15:\n\n" + capped);
      return;
    }
    // No AI answer yet in this chat: do NOT invent one. Put the prefix
    // in the composer so the NEXT question is explained simply.
    var input = visibleComposer();
    if (input) {
      input.value = "Explain simply, like I'm 15: ";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      if (helloAI().showChat) helloAI().showChat();
      input.focus({ preventScroll: true });
      toast("Type your question after the prefix, then send");
      return;
    }
    toast("Explain simply needs a chat open first");
  }

  function isMalayalamMode() {
    try { return window.localStorage.getItem(MALAYALAM_KEY) === "1"; }
    catch (e) { return false; }
  }

  function setMalayalamMode(enabled) {
    try { window.localStorage.setItem(MALAYALAM_KEY, enabled ? "1" : "0"); } catch (e) { /* non-fatal */ }
    var btn = $("studioMalayalam");
    if (btn) {
      btn.setAttribute("aria-pressed", enabled ? "true" : "false");
      btn.classList.toggle("studio-btn--active", enabled);
    }
    document.dispatchEvent(new CustomEvent("hello-ai:malayalam-mode", {
      detail: { enabled: enabled }
    }));
    toast(enabled ? "മലയാളം mode on — replies in Malayalam" : "മലയാളം mode off — replies in English");
    announce(enabled ? "Malayalam mode on." : "Malayalam mode off.", false);
  }

  function actionMalayalamMode() {
    // The panel stays open for this one: it is a toggle, and the user
    // should see its state change. (Other actions close the panel first.)
    setMalayalamMode(!isMalayalamMode());
  }

  function actionTodaysRecap() {
    closePanelAnimated();
    var chats = getTodayChats();
    if (chats === null) {
      // store.js has not landed: there is no local history to summarise,
      // and Dolphin cannot see it. Sending a blind "summarise today"
      // prompt would make Dolphin invent chats. Say so, do not send.
      toast("Today's recap needs history — it will work once history lands");
      announce("Today's recap is not available yet: history has not landed.", true);
      return;
    }
    // getChatsForDate / getTodayChats are async (Dexie) — await the
    // promise before touching .length, or a Promise object would read as
    // "no chats today" every time.
    Promise.resolve(chats).then(function (list) {
      list = list || [];
      if (!list.length) {
        toast("No chats today yet — ask something first");
        return;
      }
      var lines = list.slice(0, 20).map(function (c) {
        var title = c.title || c.preview || "Untitled chat";
        return "- " + String(title).slice(0, 120);
      }).join("\n");
      sendViaChat(
        "Summarise today's chats in 3–4 lines, using ONLY these chats (do not invent anything):\n" + lines
      );
    }).catch(function () {
      toast("Today's recap needs history — it will work once history lands");
    });
  }

  var STUDIO_ACTIONS = {
    "new-chat": actionNewChat,
    "voice-talk": actionVoiceTalk,
    "search-chats": actionSearchChats,
    "share-export": actionShareExport,
    "explain-simply": actionExplainSimply,
    "malayalam-mode": actionMalayalamMode,
    "todays-recap": actionTodaysRecap
  };

  /* ------------------------------------------------------------------ */
  /* Account section: Sign out + Manage account (+ Close, for a11y).    */
  /* ------------------------------------------------------------------ */
  function bindAccountSection() {
    var signOutBtn = $("panelSignOutBtn");
    if (signOutBtn && !signOutBtn.dataset.panelBound) {
      signOutBtn.dataset.panelBound = "1";
      signOutBtn.addEventListener("click", function () {
        closePanelAnimated();
        var api = helloAI();
        if (api.auth && typeof api.auth.signOut === "function") api.auth.signOut();
        else {
          // auth.js not landed yet: local clear + disableAutoSelect.
          try { window.localStorage.removeItem(PROFILE_KEY); } catch (e) { /* ignore */ }
          try {
            if (window.google && window.google.accounts && window.google.accounts.id) {
              window.google.accounts.id.disableAutoSelect();
            }
          } catch (e) { /* ignore */ }
          if (api.showLogin) api.showLogin();
        }
      });
    }

    // "Manage account" — opens the Google account in the browser,
    // view-only. The shell now ships the button statically
    // (#panelManageAccountBtn); create it only if the shell ever loses it.
    // The click binding runs either way, so a static button is never dead.
    var account = $("panelAccount");
    var manageBtn = $("panelManageAccountBtn");
    if (account && !manageBtn) {
      manageBtn = document.createElement("button");
      manageBtn.type = "button";
      manageBtn.id = "panelManageAccountBtn";
      manageBtn.className = "panel-manage pressable";
      manageBtn.textContent = "Manage account";
      manageBtn.setAttribute("aria-label", "Manage Google account (opens in browser)");
      account.appendChild(manageBtn);
    }
    if (manageBtn && !manageBtn.dataset.panelBound) {
      manageBtn.dataset.panelBound = "1";
      manageBtn.addEventListener("click", function () {
        var api = helloAI();
        if (api.auth && typeof api.auth.openManageAccount === "function") {
          api.auth.openManageAccount();
        } else {
          window.open(MANAGE_ACCOUNT_URL, "_blank", "noopener");
        }
      });
    }

    // Keyboard / single-pointer close alternative to the swipe gesture.
    if (panel && !$("panelCloseBtn")) {
      var closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.id = "panelCloseBtn";
      closeBtn.className = "panel-close pressable";
      closeBtn.setAttribute("aria-label", "Close panel");
      closeBtn.textContent = "✕";
      closeBtn.addEventListener("click", closePanelAnimated);
      panel.insertBefore(closeBtn, panel.firstChild);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Studio grid wiring (one listener, data-studio-action).              */
  /* ------------------------------------------------------------------ */
  function bindStudioGrid() {
    var grid = $("studioGrid");
    if (!grid || grid.dataset.panelBound) return;
    grid.dataset.panelBound = "1";
    grid.addEventListener("click", function (event) {
      var btn = event.target.closest("[data-studio-action]");
      if (!btn) return;
      var action = STUDIO_ACTIONS[btn.getAttribute("data-studio-action")];
      if (action) action();
    });
    // Restore the Malayalam toggle state on load.
    var malayalamBtn = $("studioMalayalam");
    if (malayalamBtn) {
      malayalamBtn.setAttribute("aria-pressed", isMalayalamMode() ? "true" : "false");
      malayalamBtn.classList.toggle("studio-btn--active", isMalayalamMode());
    }
  }

  /* ------------------------------------------------------------------ */
  /* Intercept the foundation close triggers so the 350 ms exit can    */
  /* play. These listeners are registered at script-execution time —    */
  /* BEFORE app.js registers its own (inside its DOMContentLoaded      */
  /* boot) — so they run first and stopImmediatePropagation() keeps    */
  /* the instant-hide handlers from firing. Open needs no intercept:   */
  /* the entrance animation runs from the `hidden` removal itself.     */
  /* ------------------------------------------------------------------ */
  function bindCloseIntercepts() {
    if (scrim) {
      scrim.addEventListener("click", function (event) {
        event.stopImmediatePropagation();
        closePanelAnimated();
      });
    }
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && panel && !panel.hidden) {
        event.stopImmediatePropagation();
        closePanelAnimated();
      }
    });
    if (panel) {
      panel.addEventListener("pointerdown", onPanelPointerDown);
      panel.addEventListener("pointermove", onPanelPointerMove);
      panel.addEventListener("pointerup", onPanelPointerUp);
      panel.addEventListener("pointercancel", onPanelPointerUp);
    }
  }

  /* Wrap window.HelloAI.openPanel / closePanel AFTER app.js boot has
     set them (deferred one tick past DOMContentLoaded, so app.js's
     boot listener — registered after this script — has already run).
     Callers of HelloAI.openPanel/closePanel then get the animation too. */
  function wrapHelloAIPanel() {
    var api = helloAI();
    if (typeof api.openPanel === "function" && !api.openPanel.__panelWrapped) {
      var origOpen = api.openPanel;
      var wrappedOpen = function () {
        origOpen();
        openPanelAnimated();
      };
      wrappedOpen.__panelWrapped = true;
      api.openPanel = wrappedOpen;
    }
    if (typeof api.closePanel === "function" && !api.closePanel.__panelWrapped) {
      var origClose = api.closePanel;
      var wrappedClose = function () {
        // Animate, then let the original hide it (the timer in
        // closePanelAnimated does the hiding; the original is only a
        // fallback in case the timer was cancelled).
        closePanelAnimated();
        window.setTimeout(function () { if (panel && panel.hidden) origClose(); }, PANEL_CLOSE_MS + 50);
      };
      wrappedClose.__panelWrapped = true;
      api.closePanel = wrappedClose;
    }
  }

  /* Watch the scrim's `hidden` attribute: foundation (app.js) can open
     the panel directly (avatar tap) without going through panel.js, so
     the scrim fade is applied here whenever it becomes visible, whoever
     opened it. Close always goes through closePanelAnimated (the
     interceptors above), so the fade-out is handled there. */
  function observeScrim() {
    if (!scrim || typeof MutationObserver === "undefined") return;
    var observer = new MutationObserver(function () {
      if (scrim.hidden) {
        scrim.classList.remove("panel-scrim--visible");
      } else {
        window.requestAnimationFrame(function () {
          scrim.classList.add("panel-scrim--visible");
        });
      }
    });
    observer.observe(scrim, { attributes: true, attributeFilter: ["hidden"] });
  }

  /* ------------------------------------------------------------------ */
  /* Boot.                                                               */
  /* ------------------------------------------------------------------ */
  function initPanel() {
    panel = $("bottomPanel");
    scrim = $("panelScrim");
    if (!panel) return;
    bindAccountSection();
    bindStudioGrid();
    bindCloseIntercepts();
    observeScrim();
    // Defer the HelloAI wrap until after app.js boot.
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () {
        window.setTimeout(wrapHelloAIPanel, 0);
      });
    } else {
      window.setTimeout(wrapHelloAIPanel, 0);
    }
  }

  window.HelloAI = window.HelloAI || {};
  window.HelloAI.panel = {
    open: openPanelAnimated,
    close: closePanelAnimated,
    isMalayalamMode: isMalayalamMode,
    setMalayalamMode: setMalayalamMode,
    runStudioAction: function (name) {
      var action = STUDIO_ACTIONS[name];
      if (action) { action(); return true; }
      return false;
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initPanel);
  } else {
    initPanel();
  }
})();
