/* ==========================================================================
   Hello AI — app.js (foundation)
   Boot + screen router (login / home / chat), aurora mount-once guard,
   dev-skip-login handling. Screen transitions per anim-07: CSS classes
   only (.is-entering / .is-exiting, see css/animations.css).
   Live-only: no canned answers anywhere in this shell.
   Other modules (auth, greeting, chat, history-ui, panel, voice) own their
   screens; this file only routes and wires the dev login. It must keep
   working when those modules have not landed yet — hence the guards.
   ========================================================================== */
(function () {
  "use strict";

  var config = window.HELLO_AI_CONFIG || {};
  var PROFILE_KEY = "hello-ai-profile";

  /* --- Aurora mount-once: the layer is static markup in index.html.
     Never recreate it, never restart it on navigation (PLAN §4.1/§5.1). --- */
  function assertAurora() {
    var layers = document.querySelectorAll(".aurora");
    if (layers.length !== 1) {
      console.warn("[app] expected exactly one .aurora layer, found " + layers.length);
    }
  }

  /* --- Screen router --- */
  var SCREENS = ["loginScreen", "homeScreen", "chatScreen"];
  var currentScreen = null;

  function showScreen(id) {
    if (SCREENS.indexOf(id) === -1) return;
    var next = document.getElementById(id);
    if (!next) return;
    // C-3 fix: deactivate ALL screens except the target, not just the
    // tracked previous one. currentScreen starts null on boot and the
    // login screen ships with a static is-active class, so going
    // straight to Home on a return visit used to leave the login card
    // rendered above Home.
    SCREENS.forEach(function (screenId) {
      if (screenId === id) return;
      var other = document.getElementById(screenId);
      if (!other) return;
      other.classList.remove("is-active", "is-entering");
      other.classList.add("is-exiting");
      other.hidden = true;
      other.classList.remove("is-exiting");
    });
    next.hidden = false;
    next.classList.add("is-active", "is-entering");
    // Drop the entrance class after the animation so re-entry replays it.
    window.setTimeout(function () { next.classList.remove("is-entering"); }, 350);
    currentScreen = id;
    document.dispatchEvent(new CustomEvent("hello-ai:screen", { detail: { screen: id } }));
  }

  function showHome() {
    showScreen("homeScreen");
    // A time-band boundary may have passed while chatting — re-check the
    // greeting silently on return home (greeting.js refresh()).
    if (greetingCtl && typeof greetingCtl.refresh === "function") {
      try { greetingCtl.refresh(); } catch (e) { /* greeting is best-effort */ }
    }
  }
  function showChat() { showScreen("chatScreen"); }
  function showLogin() { showScreen("loginScreen"); }

  /* --- Profile (local only; token is never stored — PLAN §2.4) --- */
  function readProfile() {
    try {
      var raw = window.localStorage.getItem(PROFILE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function saveProfile(profile) {
    try { window.localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch (e) { /* storage full/blocked: stay signed out */ }
  }

  /* Fill every profile surface with textContent only (never innerHTML). */
  function applyProfile(profile) {
    var name = (profile && profile.name) || "Aadidev";
    var email = (profile && profile.email) || "";
    var picture = (profile && profile.picture) || "";
    var nameTargets = ["historyProfileName", "panelAccountName"];
    var emailTargets = ["historyProfileEmail", "panelAccountEmail"];
    nameTargets.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.textContent = name;
    });
    emailTargets.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.textContent = email;
    });
    // Avatar images: set src only when a real picture URL exists; the
    // fallback glyph stays visible otherwise. Avatar <img> alt is empty
    // (decorative — the name next to it carries the meaning).
    ["historyAvatar", "panelAvatar", "chatAvatarImg"].forEach(function (id) {
      var img = document.getElementById(id);
      if (!img) return;
      if (picture) { img.src = picture; img.hidden = false; }
      else { img.removeAttribute("src"); img.hidden = true; }
    });
    // Greeting name: greeting.js owns the time-band text; only fall back
    // to a plain greeting here when the greeting module never initialised,
    // so home never renders blank. (The old guard checked a global
    // window.HelloAIGreeting that greeting.js never defined, so this
    // fallback used to clobber the time-band greeting on every sign-in.)
    var greetingText = document.getElementById("greetingText");
    if (greetingText && !greetingReady) {
      greetingText.textContent = "Hello, " + name;
    }
  }

  /* --- Greeting (greeting.js owns the time bands + name; app.js only
     wires it up). initGreeting is called once at boot with the Google
     profile given_name as the name supplier (auth.js). It returns null
     when the shell is not ready — home then keeps its static fallback. --- */
  var greetingCtl = null;
  var greetingReady = false;

  function initGreeting() {
    var g = window.HelloAI && window.HelloAI.greeting;
    if (!g || typeof g.initGreeting !== "function") return;
    try {
      greetingCtl = g.initGreeting({
        getProfileGivenName: function () {
          var auth = window.HelloAI && window.HelloAI.auth;
          return auth && typeof auth.getProfileGivenName === "function"
            ? auth.getProfileGivenName() : "";
        }
      });
      greetingReady = !!greetingCtl;
    } catch (e) { greetingCtl = null; greetingReady = false; }
  }

  /* --- Dev skip login (DEV ONLY) ---
     While HELLO_AI_CONFIG.clientId is empty and devSkipLogin is true, the
     login screen offers #devSkipLogin. It enters the app with a local dev
     profile named "Aadidev" — no Google token, no account, clearly dev-only.
     Remove this path (and the button) once the real Client ID lands. --- */
  function bindDevSkipLogin() {
    var btn = document.getElementById("devSkipLogin");
    if (!btn) return;
    if (!config.devSkipLogin || config.clientId) {
      btn.hidden = true;
      return;
    }
    btn.addEventListener("click", function () {
      var profile = { name: "Aadidev", given_name: "Aadidev", email: "", sub: "dev-local", dev: true };
      saveProfile(profile);
      applyProfile(profile);
      showHome();
    });
  }

  /* --- History drawer open/close (foundation wiring; history-ui.js owns
     rows, pin, swipe, search once it lands) --- */
  function bindDrawerBasics() {
    var drawer = document.getElementById("historyDrawer");
    var scrim = document.getElementById("historyScrim");
    if (!drawer) return;
    function open() {
      drawer.hidden = false;
      if (scrim) scrim.hidden = false;
      ["historyBtn", "chatHistoryBtn"].forEach(function (id) {
        var b = document.getElementById(id);
        if (b) b.setAttribute("aria-expanded", "true");
      });
    }
    function close() {
      drawer.hidden = true;
      if (scrim) scrim.hidden = true;
      ["historyBtn", "chatHistoryBtn"].forEach(function (id) {
        var b = document.getElementById(id);
        if (b) b.setAttribute("aria-expanded", "false");
      });
    }
    ["historyBtn", "chatHistoryBtn"].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) b.addEventListener("click", open);
    });
    var closeBtn = document.getElementById("historyCloseBtn");
    if (closeBtn) closeBtn.addEventListener("click", close);
    if (scrim) scrim.addEventListener("click", close);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !drawer.hidden) close();
    });
    // Expose for history-ui.js / panel.js to reuse instead of re-binding.
    window.HelloAI = window.HelloAI || {};
    window.HelloAI.openHistory = open;
    window.HelloAI.closeHistory = close;
  }

  /* --- Bottom panel open/close (foundation wiring; panel.js owns studio) --- */
  function bindPanelBasics() {
    var panel = document.getElementById("bottomPanel");
    var scrim = document.getElementById("panelScrim");
    if (!panel) return;
    function open() {
      panel.hidden = false;
      if (scrim) scrim.hidden = false;
      var b = document.getElementById("chatAvatarBtn");
      if (b) b.setAttribute("aria-expanded", "true");
    }
    function close() {
      panel.hidden = true;
      if (scrim) scrim.hidden = true;
      var b = document.getElementById("chatAvatarBtn");
      if (b) b.setAttribute("aria-expanded", "false");
    }
    ["chatAvatarBtn", "historyProfile"].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) b.addEventListener("click", open);
    });
    if (scrim) scrim.addEventListener("click", close);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !panel.hidden) close();
    });
    window.HelloAI = window.HelloAI || {};
    window.HelloAI.openPanel = open;
    window.HelloAI.closePanel = close;
  }

  /* --- Boot-time mic support check (voice.js §1): the lazy voice module
     cannot hide the mic before its first tap, so hide it here on browsers
     without the Web Speech API. Never show a dead mic button. --- */
  function hideMicIfUnsupported() {
    if (!("SpeechRecognition" in window || "webkitSpeechRecognition" in window)) {
      var mic = document.getElementById("micBtn");
      if (mic) mic.setAttribute("hidden", "");
    }
  }

  /* --- Boot --- */
  function boot() {
    assertAurora();
    bindDevSkipLogin();
    bindDrawerBasics();
    bindPanelBasics();
    hideMicIfUnsupported();
    initGreeting();
    // C-3: initialise the tracked screen from the one actually active in
    // the static markup, so the first showScreen() knows what it replaces
    // (first boot, return visit, and sign-out -> login all go through it).
    var initiallyActive = document.querySelector(".screen.is-active");
    if (initiallyActive && SCREENS.indexOf(initiallyActive.id) !== -1) {
      currentScreen = initiallyActive.id;
    }
    var profile = readProfile();
    if (profile) {
      applyProfile(profile);
      showHome();
    } else {
      showLogin();
    }
    window.HelloAI = window.HelloAI || {};
    window.HelloAI.showScreen = showScreen;
    window.HelloAI.showHome = showHome;
    window.HelloAI.showChat = showChat;
    window.HelloAI.showLogin = showLogin;
    window.HelloAI.applyProfile = applyProfile;
    window.HelloAI.readProfile = readProfile;
    window.HelloAI.saveProfile = saveProfile;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
