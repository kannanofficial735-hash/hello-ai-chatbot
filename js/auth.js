/* ==========================================================================
   Hello AI — auth.js (login + account panel: auth half)
   Google Identity Services (GIS) integration — UX / personalisation gate
   ONLY, never a security boundary (PLAN §2.4, §4).

   Rules this file enforces (research-technical-auth-storage-voice.md §(a)):
   - Sign in ONLY via "Continue with Google" (the GIS-rendered button).
     No email field, no password field, no other provider, no custom fake
     Google button. Scopes: openid email profile only (GIS defaults).
   - The Google ID token lives IN MEMORY ONLY. It is never stored, never
     put in a URL, never sent to the Colab backend, never logged.
   - Only the decoded DISPLAY profile { sub, name, given_name, email,
     picture, exp } is stored, in localStorage["hello-ai-profile"], via
     window.HelloAI.saveProfile / readProfile (foundation owns the key).
   - There is NO client secret in this flow. None is created, asked for,
     or stored anywhere. The Client ID is public by design.
   - Never sign the Kannan account out of Google itself. "Sign out" here
     means: clear this app's profile + google.accounts.id.disableAutoSelect()
     only. It does NOT sign the user out of Google in the browser.
   - Client-side decode is a STRUCTURAL check for display only
     (3 parts, iss, aud, exp). Decoding is NOT verification — anyone can
     forge an unsigned JWT. Nothing sensitive ever depends on it.

   Client ID gating (PLAN §4.3 / A-1 — BLOCKING):
   - If window.HELLO_AI_CONFIG.clientId is EMPTY, GIS is NOT initialised,
     NOT rendered, and One Tap is NOT prompted. The login screen shows an
     honest note in #loginError instead (never a silent spinner), and the
     foundation dev-skip button (#devSkipLogin) stays visible.
   - The day Aadidev pastes his Client ID into js/config.js, this file
     just works: it loads the GIS library, renders the button, and
     prompts One Tap on the login screen only.

   NOTE on the static GIS <script> tag in index.html: foundation loads
   https://accounts.google.com/gsi/client in <head> unconditionally, so
   the library code is fetched even while clientId is empty. This file
   does NOT initialise or use it until a Client ID exists (no account
   data is sent), but the fetch itself contradicts "do not load GIS at
   all". Foundation should remove that static tag and let initAuth()
   inject the script only when clientId is present (it already handles
   both cases below). See build-notes/panel-login.md.

   GIS flag decisions (checked 2026-11-12 against Google's FedCM
   migration guide, developers.google.com/identity/gsi/web/guides/migration):
   - use_fedcm_for_button: true — KEPT. Still documented for the FedCM
     button flow in the GIS IdConfiguration.
   - use_fedcm_for_prompt: DROPPED. The current GIS reference marks it
     deprecated and says it will be ignored if used: FedCM is now how
     One Tap presents in browsers that support it, by default. Passing a
     dead flag would be cargo-cult config, so it is not passed.
   - auto_select: false — kept. No automatic sign-in; the user always
     taps the button or the One Tap prompt.
   - No nonce is passed: a client-generated nonce is weak replay
     protection on a static site with no server to check it, and must
     never be presented as server-grade protection.

   Failure handling (security_check_sign_in skill):
   - A failed/blocked sign-in leaves the EXACT error wording visible in
     #loginError with a clear next step ("Try again" / "Use a different
     Google account"), never a generic spinner.
   - After the SECOND identical failure on the same route, this file
     stops: it shows the stop message and does not re-initialise GIS
     automatically. The user can still tap the GIS button again by hand.
   - If Google shows a captcha / security check, the UI says so plainly:
     Luna cannot solve it; the user solves it in the browser.

   Vanilla JS only. Backend untouched.
   ========================================================================== */
"use strict";

/* ------------------------------------------------------------------ */
/* Pure helpers — no DOM, no GIS. Exported for node tests (see bottom). */
/* ------------------------------------------------------------------ */

var GIS_ISSUER = "https://accounts.google.com";
var GIS_SCRIPT_URL = "https://accounts.google.com/gsi/client";
var PROFILE_KEY = "hello-ai-profile";

/** Decode base64url (JWT segment) to a UTF-8 string. Throws on bad input. */
function base64UrlDecode(segment) {
  if (typeof segment !== "string" || !segment) throw new Error("empty JWT segment");
  var base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) base64 += "=";
  if (typeof atob === "function") {
    // atob returns a binary string; convert code units to UTF-8 text.
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    if (typeof TextDecoder !== "undefined") return new TextDecoder("utf-8").decode(bytes);
    var out = "";
    for (var j = 0; j < bytes.length; j++) out += String.fromCharCode(bytes[j]);
    return out;
  }
  // Node (tests only): Buffer is available there, never in the browser path.
  return Buffer.from(base64, "base64").toString("utf-8");
}

/**
 * Decode a Google ID token's payload for DISPLAY ONLY.
 * Returns the payload object, or null if the token is not a 3-part JWT
 * with a JSON payload. This proves nothing about authenticity.
 */
function decodeJwtPayload(token) {
  if (typeof token !== "string") return null;
  var parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    var payload = JSON.parse(base64UrlDecode(parts[1]));
    return payload && typeof payload === "object" ? payload : null;
  } catch (e) {
    return null;
  }
}

/**
 * Structural check of a decoded payload for display use.
 * Returns { ok: true } or { ok: false, reason } — reason is a short,
 * user-facing-safe code (the exact wording is composed by the caller).
 * Checks: iss, aud === clientId, sub present, exp in the future.
 * This is NOT signature verification and must never be described as such.
 */
function checkPayloadForDisplay(payload, clientId, nowMs) {
  var now = typeof nowMs === "number" ? nowMs : Date.now();
  if (!payload || typeof payload !== "object") return { ok: false, reason: "unreadable" };
  if (payload.iss !== GIS_ISSUER) return { ok: false, reason: "wrong-issuer" };
  if (!clientId || payload.aud !== clientId) return { ok: false, reason: "wrong-audience" };
  if (typeof payload.sub !== "string" || !payload.sub) return { ok: false, reason: "no-subject" };
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true };
}

/** Pick only the display fields out of a decoded payload. Nothing else. */
function profileFromPayload(payload) {
  return {
    sub: payload.sub,
    name: typeof payload.name === "string" ? payload.name : "",
    given_name: typeof payload.given_name === "string" ? payload.given_name : "",
    email: typeof payload.email === "string" ? payload.email : "",
    picture: typeof payload.picture === "string" ? payload.picture : "",
    exp: typeof payload.exp === "number" ? payload.exp : 0
  };
}

/** True when a stored profile's exp has passed (dev profiles have no exp). */
function isProfileExpired(profile, nowMs) {
  if (!profile || typeof profile !== "object") return true;
  if (profile.dev) return false; // dev-skip profile: no token, no expiry
  if (typeof profile.exp !== "number" || !profile.exp) return true;
  var now = typeof nowMs === "number" ? nowMs : Date.now();
  // Strict: no grace period past exp. A token even 1 s past expiry is
  // signed out (One Tap / the button can silently re-sign the user in).
  return profile.exp * 1000 <= now;
}

/* ------------------------------------------------------------------ */
/* Browser wiring — runs only in the browser, never at require() time. */
/* ------------------------------------------------------------------ */
(function () {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  var config = window.HELLO_AI_CONFIG || {};
  // N-1 fix (QA Round 2): NEVER capture window.HelloAI at load time.
  // auth.js loads 2nd, before anything creates window.HelloAI, so a
  // load-time capture is a dead empty object while later modules build
  // the real API on a different object — signOut() / handleCredential-
  // Response then silently no-op on showLogin/showHome/applyProfile.
  // Read the namespace FRESH at call time via api() instead.
  function api() { return window.HelloAI || {}; }

  /* --- In-memory only: the ID token. Never stored, never sent anywhere. --- */
  var idToken = null;

  /* --- Failure counting (security_check_sign_in: stop after 2nd identical) --- */
  var lastFailureKey = null;
  var lastFailureCount = 0;
  var stoppedRoute = null; // set after the 2nd identical failure
  var gisReady = false;
  var gisLoadPromise = null;

  /* --- Small DOM helpers (textContent only, never innerHTML) --- */
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

  /* --- Login error area: exact wording + next step, never a spinner --- */
  function showLoginError(message, opts) {
    var errorEl = $("loginError");
    var btnWrap = $("googleSigninBtn");
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.hidden = false;
    }
    if (btnWrap) {
      btnWrap.classList.remove("google-signin--error");
      void btnWrap.offsetWidth; // restart the shake animation
      btnWrap.classList.add("google-signin--error");
    }
    announce(message, true);
    if (opts && opts.shakeCard) {
      var card = $("loginCard");
      if (card) {
        card.classList.remove("login-card--error");
        void card.offsetWidth;
        card.classList.add("login-card--error");
      }
    }
  }

  function clearLoginError() {
    var errorEl = $("loginError");
    if (errorEl) {
      errorEl.textContent = "";
      errorEl.hidden = true;
      errorEl.classList.remove("login-error--info");
    }
    var btnWrap = $("googleSigninBtn");
    if (btnWrap) btnWrap.classList.remove("google-signin--error");
  }

  /**
   * Record a sign-in failure. Returns true when this is the SECOND
   * identical failure — the caller must then stop that route.
   * The exact wording is kept (shown to the user), only the count is new.
   */
  function recordFailure(key, exactWording, nextStep) {
    if (key === lastFailureKey) lastFailureCount += 1;
    else { lastFailureKey = key; lastFailureCount = 1; }
    if (lastFailureCount >= 2) {
      stoppedRoute = key;
      showLoginError(
        "Sign-in stopped after 2 identical failures — " + exactWording +
        " " + nextStep +
        " Luna cannot fix this from here; please try the step above, or take the browser and try again later.",
        { shakeCard: true }
      );
      return true;
    }
    showLoginError(exactWording + " " + nextStep, { shakeCard: true });
    return false;
  }

  function failureKeyFor(message) {
    var m = String(message || "").toLowerCase();
    if (m.indexOf("captcha") !== -1 || m.indexOf("security check") !== -1) return "captcha";
    if (m.indexOf("not allowed for the given client id") !== -1 || m.indexOf("origin") !== -1) return "origin-not-allowed";
    if (m.indexOf("popup") !== -1 && m.indexOf("closed") !== -1) return "popup-closed";
    if (m.indexOf("access_denied") !== -1 || m.indexOf("access denied") !== -1) return "access-denied";
    if (m.indexOf("unverified") !== -1) return "unverified-app";
    return "gis-error:" + String(message || "unknown").slice(0, 80);
  }

  function nextStepFor(key) {
    switch (key) {
      case "captcha":
        return "Google is showing a captcha / security check. Luna cannot solve it — please solve it in the browser yourself, then try again.";
      case "origin-not-allowed":
        return "Try again after checking the Client ID: in Google Cloud Console → Credentials, the Authorized JavaScript origin must be exactly https://hello-ai-chatbot.netlify.app (no path, no trailing slash).";
      case "popup-closed":
        return "Try again — and keep the Google sign-in popup open until it finishes.";
      case "access-denied":
        return "Try again with a different Google account, or ask Luna to add this account as a test user (the app is in Testing mode).";
      case "unverified-app":
        return "Try again — on the warning screen, tap Advanced, then continue. Or use a different Google account.";
      default:
        return "Try again, or use a different Google account.";
    }
  }

  /* --- GIS loading: only when a Client ID exists --- */
  function loadGis() {
    if (gisLoadPromise) return gisLoadPromise;
    gisLoadPromise = new Promise(function (resolve, reject) {
      if (window.google && window.google.accounts && window.google.accounts.id) {
        gisReady = true;
        resolve();
        return;
      }
      var script = document.createElement("script");
      script.src = GIS_SCRIPT_URL;
      script.async = true;
      script.defer = true;
      script.onload = function () {
        if (window.google && window.google.accounts && window.google.accounts.id) {
          gisReady = true;
          resolve();
        } else {
          reject(new Error("Google sign-in library loaded but did not initialise."));
        }
      };
      script.onerror = function () {
        reject(new Error("Google sign-in library could not be loaded — check your connection and try again."));
      };
      document.head.appendChild(script);
      // The library should arrive in seconds; if it never does, say so
      // instead of leaving a spinner. (Timeout is a fallback, not a retry.)
      window.setTimeout(function () {
        if (!gisReady) reject(new Error("Google sign-in library took too long to load — check your connection and try again."));
      }, 15000);
    });
    return gisLoadPromise;
  }

  /* --- Credential callback: decode for DISPLAY ONLY, store profile --- */
  function handleCredentialResponse(response) {
    if (stoppedRoute) return; // stopped after 2 identical failures: do not re-run
    var clientId = config.clientId || "";
    var credential = response && response.credential;
    if (typeof credential !== "string" || !credential) {
      recordFailure("no-credential",
        "Google did not return a sign-in credential.",
        "Try again, or use a different Google account.");
      return;
    }
    var payload = decodeJwtPayload(credential);
    var check = checkPayloadForDisplay(payload, clientId);
    if (!check.ok) {
      var wording = check.reason === "expired"
        ? "Google returned an expired sign-in — please try again."
        : check.reason === "wrong-audience"
          ? "Google returned a sign-in for a different app (audience mismatch) — the Client ID in js/config.js does not match the one in Google Cloud Console."
          : "Google returned a sign-in that could not be read (" + check.reason + ").";
      recordFailure("bad-credential:" + check.reason, wording, "Try again, or use a different Google account.");
      return;
    }
    // Structural check passed — for DISPLAY ONLY. This is not verification.
    idToken = credential; // memory only; never stored, never sent anywhere
    var profile = profileFromPayload(payload);
    try {
      if (api().saveProfile) api().saveProfile(profile);
      else window.localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    } catch (e) { /* storage blocked: stay on the login screen, say so */ }
    var stored = null;
    try { stored = api().readProfile ? api().readProfile() : JSON.parse(window.localStorage.getItem(PROFILE_KEY)); } catch (e) { stored = profile; }
    if (!stored) {
      showLoginError("Signed in, but this browser would not save your profile — sign-in cannot continue. Try again, or allow site data for this site in your browser settings.");
      idToken = null;
      return;
    }
    lastFailureKey = null; lastFailureCount = 0; stoppedRoute = null;
    clearLoginError();
    if (api().applyProfile) api().applyProfile(profile);
    var card = $("loginCard");
    if (card) card.classList.add("login-card--signed-in");
    toast("Signed in as " + (profile.given_name || profile.name || "you"));
    announce("Signed in. Welcome to Hello AI.", false);
    if (api().showHome) api().showHome();
    else if (api().showScreen) api().showScreen("homeScreen");
  }

  /* --- GIS error callback (button / One Tap errors surface here) --- */
  function handleGisError(message) {
    var key = failureKeyFor(message);
    recordFailure(key, String(message || "Google sign-in failed."), nextStepFor(key));
  }

  /* --- Initialise GIS + render button + One Tap (login screen only) --- */
  function initGis() {
    var clientId = (config.clientId || "").trim();
    if (!clientId) return Promise.resolve(false);
    return loadGis().then(function () {
      var id = window.google.accounts.id;
      id.initialize({
        client_id: clientId,
        callback: handleCredentialResponse,
        auto_select: false,
        // FedCM button flow. use_fedcm_for_prompt is deliberately NOT
        // passed: current GIS reference marks it deprecated/ignored —
        // FedCM is now the default One Tap presentation.
        use_fedcm_for_button: true
      });
      var mount = $("googleSigninBtn");
      if (mount) {
        mount.textContent = ""; // clear any honest-note placeholder
        var width = Math.min(400, Math.max(240, mount.clientWidth || 320));
        id.renderButton(mount, {
          theme: "outline",
          size: "large",
          type: "standard",
          text: "signin_with",
          width: width
        });
      }
      // One Tap: login screen only, never on home/chat. Under FedCM the
      // prompt callback no longer returns display-moment details, so no
      // callback is passed. If the user opted out of third-party sign-in
      // in the browser, One Tap is unavailable and the button remains
      // the fallback — never a One-Tap-only login screen.
      var loginScreen = $("loginScreen");
      if (loginScreen && !loginScreen.hidden && loginScreen.classList.contains("is-active")) {
        try { id.prompt(); } catch (e) { /* One Tap unavailable: button stays */ }
      }
      return true;
    }).catch(function (err) {
      handleGisError(err && err.message ? err.message : "Google sign-in failed to load.");
      return false;
    });
  }

  /* --- Honest no-Client-ID state (clientId empty: GIS never touched) --- */
  function showNoClientIdNote() {
    var mount = $("googleSigninBtn");
    if (mount) {
      mount.textContent = ""; // keep the mount empty — no fake button
      mount.classList.add("google-signin--unavailable");
    }
    var errorEl = $("loginError");
    if (errorEl) {
      // Shown as information, not an error: plain text, no shake.
      errorEl.textContent = "Google sign-in needs a Client ID — ask Luna for the setup steps.";
      errorEl.hidden = false;
      errorEl.classList.add("login-error--info");
    }
    // The foundation dev-skip button stays visible (app.js owns it).
    var devBtn = $("devSkipLogin");
    if (devBtn) devBtn.hidden = false;
  }

  /* --- Expiry on load: expired profile = signed out (before app boot) --- */
  function purgeExpiredProfile() {
    var profile = null;
    try { profile = api().readProfile ? api().readProfile() : JSON.parse(window.localStorage.getItem(PROFILE_KEY)); } catch (e) { profile = null; }
    if (profile && isProfileExpired(profile)) {
      try { window.localStorage.removeItem(PROFILE_KEY); } catch (e) { /* ignore */ }
      return true;
    }
    return false;
  }

  /* --- Sign-out: app only. Never signs the user out of Google itself. --- */
  function signOut() {
    idToken = null;
    try { window.localStorage.removeItem(PROFILE_KEY); } catch (e) { /* ignore */ }
    try {
      if (gisReady && window.google && window.google.accounts && window.google.accounts.id) {
        window.google.accounts.id.disableAutoSelect();
      }
    } catch (e) { /* GIS unavailable: profile is already cleared locally */ }
    if (api().applyProfile) api().applyProfile(null);
    clearLoginError();
    toast("Signed out");
    announce("Signed out of Hello AI.", false);
    if (api().showLogin) api().showLogin();
    else if (api().showScreen) api().showScreen("loginScreen");
    // If GIS is available, re-render the button for the next sign-in.
    if ((config.clientId || "").trim()) initGis();
    else showNoClientIdNote();
  }

  /**
   * Revoke Google access (Settings action — NOT everyday sign-out).
   * google.accounts.id.revoke(hint, callback): withdraws consent to share
   * the profile; the next sign-in shows the consent screen again.
   * hint is the user's email (or sub). After revoke, also sign out locally.
   */
  function revokeGoogleAccess(callback) {
    var done = function () {
      signOut();
      toast("Google access removed — sign in again to reconnect");
      if (typeof callback === "function") callback();
    };
    var profile = null;
    try { profile = api().readProfile ? api().readProfile() : JSON.parse(window.localStorage.getItem(PROFILE_KEY)); } catch (e) { profile = null; }
    var hint = (profile && (profile.email || profile.sub)) || "";
    if (!hint) { done(); return; }
    if (!gisReady || !window.google || !window.google.accounts || !window.google.accounts.id) {
      // GIS not loaded (e.g. no Client ID yet): nothing to revoke at
      // Google; local sign-out is the honest action.
      done();
      return;
    }
    try {
      window.google.accounts.id.revoke(hint, done);
    } catch (e) {
      done();
    }
  }

  /** Open the user's Google account page in the browser (view-only). */
  function openManageAccount() {
    window.open("https://myaccount.google.com/", "_blank", "noopener");
  }

  function getProfile() {
    try { return api().readProfile ? api().readProfile() : JSON.parse(window.localStorage.getItem(PROFILE_KEY)); }
    catch (e) { return null; }
  }

  function getProfileGivenName() {
    var p = getProfile();
    return p && p.given_name ? p.given_name : (p && p.name ? p.name : "");
  }

  function isSignedIn() {
    var p = getProfile();
    return Boolean(p && !isProfileExpired(p));
  }

  /* --- Boot: purge expiry FIRST (before app.js boot reads the profile),
     then either show the honest note or initialise GIS. --- */
  function initAuth() {
    var expired = purgeExpiredProfile();
    if (expired) announce("Your sign-in had expired — please sign in again.", true);
    var clientId = (config.clientId || "").trim();
    if (!clientId) {
      showNoClientIdNote();
      return;
    }
    // Client ID present: hide the dev-skip path (app.js also hides it)
    // and bring up real Google sign-in.
    var devBtn = $("devSkipLogin");
    if (devBtn) devBtn.hidden = true;
    initGis();
  }

  /* --- Public API (greeting.js reads getProfileGivenName; panel.js
     calls signOut / revokeGoogleAccess / openManageAccount) --- */
  window.HelloAI = window.HelloAI || {};
  window.HelloAI.auth = {
    initAuth: initAuth,
    signOut: signOut,
    revokeGoogleAccess: revokeGoogleAccess,
    openManageAccount: openManageAccount,
    getProfile: getProfile,
    getProfileGivenName: getProfileGivenName,
    isSignedIn: isSignedIn,
    // Test/debug only: confirms the token is memory-only. Never logs it.
    hasTokenInMemory: function () { return idToken !== null; }
  };
  // Also surface the failure handler so a future GIS error callback
  // (e.g. from a prompt notification) can report exact wording.
  window.HelloAI.auth.reportError = handleGisError;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAuth);
  } else {
    initAuth();
  }
})();

/* Node test export (tests only — the browser path never sees `module`). */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    decodeJwtPayload: decodeJwtPayload,
    checkPayloadForDisplay: checkPayloadForDisplay,
    profileFromPayload: profileFromPayload,
    isProfileExpired: isProfileExpired,
    base64UrlDecode: base64UrlDecode,
    GIS_ISSUER: GIS_ISSUER
  };
}
