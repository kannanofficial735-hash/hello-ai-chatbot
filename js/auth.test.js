/* auth.test.js — unit tests for the PURE helpers in js/auth.js.
   Run: node --test js/auth.test.js
   Browser wiring (GIS, DOM, localStorage) is NOT covered here — it needs
   a Client ID and a browser; verify it manually per build-notes/panel-login.md.
   Exception: the N-1 regression test below runs auth.js in a vm sandbox
   with a fake window/document, so signOut() IS exercised (it needs no GIS).
   These tests cover the safety-critical logic: token decoding is
   display-only, structural checks reject wrong iss/aud/exp, and an
   expired profile is treated as signed out. */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const auth = require("./auth.js");

const CLIENT_ID = "1234567890-abcdefghijklmnop.apps.googleusercontent.com";
const NOW_MS = Date.UTC(2026, 10, 12, 13, 0, 0); // 2026-11-12 13:00 UTC

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj), "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function makeToken(payload) {
  return b64url({ alg: "RS256", typ: "JWT" }) + "." + b64url(payload) + ".fakesignature";
}

const GOOD_PAYLOAD = {
  iss: "https://accounts.google.com",
  aud: CLIENT_ID,
  sub: "110012345678901234567",
  email: "aadidev@example.com",
  email_verified: true,
  name: "Aadidev",
  given_name: "Aadidev",
  picture: "https://lh3.googleusercontent.com/a/photo",
  iat: Math.floor(NOW_MS / 1000) - 60,
  exp: Math.floor(NOW_MS / 1000) + 3600
};

test("decodeJwtPayload: decodes a well-formed 3-part token", () => {
  const payload = auth.decodeJwtPayload(makeToken(GOOD_PAYLOAD));
  assert.equal(payload.sub, GOOD_PAYLOAD.sub);
  assert.equal(payload.given_name, "Aadidev");
  assert.equal(payload.email, "aadidev@example.com");
});

test("decodeJwtPayload: rejects non-JWT input", () => {
  assert.equal(auth.decodeJwtPayload(null), null);
  assert.equal(auth.decodeJwtPayload(""), null);
  assert.equal(auth.decodeJwtPayload("two.parts"), null);
  assert.equal(auth.decodeJwtPayload("a.b.c.d"), null);
  assert.equal(auth.decodeJwtPayload("x.!!!not-json!!!.y"), null);
});

test("checkPayloadForDisplay: accepts a good payload", () => {
  assert.deepEqual(auth.checkPayloadForDisplay(GOOD_PAYLOAD, CLIENT_ID, NOW_MS), { ok: true });
});

test("checkPayloadForDisplay: rejects wrong issuer", () => {
  const bad = { ...GOOD_PAYLOAD, iss: "https://evil.example.com" };
  assert.equal(auth.checkPayloadForDisplay(bad, CLIENT_ID, NOW_MS).ok, false);
  assert.equal(auth.checkPayloadForDisplay(bad, CLIENT_ID, NOW_MS).reason, "wrong-issuer");
});

test("checkPayloadForDisplay: rejects audience mismatch (token for another app)", () => {
  const bad = { ...GOOD_PAYLOAD, aud: "999-other.apps.googleusercontent.com" };
  const check = auth.checkPayloadForDisplay(bad, CLIENT_ID, NOW_MS);
  assert.equal(check.ok, false);
  assert.equal(check.reason, "wrong-audience");
});

test("checkPayloadForDisplay: rejects expired token", () => {
  const bad = { ...GOOD_PAYLOAD, exp: Math.floor(NOW_MS / 1000) - 3600 };
  const check = auth.checkPayloadForDisplay(bad, CLIENT_ID, NOW_MS);
  assert.equal(check.ok, false);
  assert.equal(check.reason, "expired");
});

test("checkPayloadForDisplay: rejects missing sub", () => {
  const bad = { ...GOOD_PAYLOAD };
  delete bad.sub;
  assert.equal(auth.checkPayloadForDisplay(bad, CLIENT_ID, NOW_MS).reason, "no-subject");
});

test("profileFromPayload: keeps only display fields, never the token", () => {
  const profile = auth.profileFromPayload(GOOD_PAYLOAD);
  assert.deepEqual(Object.keys(profile).sort(),
    ["email", "exp", "given_name", "name", "picture", "sub"]);
  assert.equal(profile.sub, GOOD_PAYLOAD.sub);
  assert.equal("credential" in profile, false);
});

test("isProfileExpired: expired profile is signed out", () => {
  assert.equal(auth.isProfileExpired({ exp: Math.floor(NOW_MS / 1000) - 10 }, NOW_MS), true);
  assert.equal(auth.isProfileExpired({ exp: Math.floor(NOW_MS / 1000) + 3600 }, NOW_MS), false);
  assert.equal(auth.isProfileExpired(null, NOW_MS), true);
  assert.equal(auth.isProfileExpired({}, NOW_MS), true);
});

test("isProfileExpired: dev profile (no token) never expires", () => {
  assert.equal(auth.isProfileExpired({ dev: true, name: "Aadidev" }, NOW_MS), false);
});

/* ------------------------------------------------------------------ */
/* N-1 regression (QA Round 2): signOut() must resolve window.HelloAI */
/* FRESH at call time. auth.js loads before any module creates the    */
/* namespace, so a load-time capture is a dead empty object and       */
/* showLogin/showHome/applyProfile silently no-op. This test loads    */
/* auth.js in a vm sandbox with NO window.HelloAI present, then       */
/* attaches the app API afterwards (as app.js does in the browser)    */
/* and asserts signOut() still reaches it. With the old stale capture */
/* this test fails: showLogin is never called.                        */
/* ------------------------------------------------------------------ */

function makeStubElement() {
  return {
    textContent: "",
    hidden: false,
    className: "",
    offsetWidth: 0,
    parentNode: null,
    children: [],
    classList: { add() {}, remove() {} },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i !== -1) this.children.splice(i, 1);
      child.parentNode = null;
      return child;
    }
  };
}

function loadAuthInSandbox() {
  const store = new Map();
  const elements = new Map();
  const fakeWindow = {
    HELLO_AI_CONFIG: { clientId: "" }, // no Client ID: GIS never touched
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    },
    setTimeout: () => 0, // never fire: toast timers stay pending, as in a test
    google: undefined
  };
  const fakeDocument = {
    readyState: "complete", // initAuth runs synchronously at load
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, makeStubElement());
      return elements.get(id);
    },
    createElement: () => makeStubElement(),
    head: { appendChild() {} },
    addEventListener() {}
  };
  const sandbox = {
    window: fakeWindow,
    document: fakeDocument,
    module: { exports: {} },
    Buffer,
    TextDecoder,
    atob
  };
  sandbox.window.window = fakeWindow; // window.window === window, as in a browser
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "auth.js"), "utf-8"), sandbox, { filename: "auth.js" });
  return { fakeWindow, fakeDocument, elements, store };
}

test("N-1: signOut() reaches showLogin/applyProfile attached AFTER auth.js loaded", () => {
  const { fakeWindow, elements, store } = loadAuthInSandbox();
  // app.js (and the other modules) build the real API only AFTER auth.js
  // has already evaluated — attach it now, the way the browser does.
  const calls = [];
  fakeWindow.HelloAI.showLogin = () => calls.push("showLogin");
  fakeWindow.HelloAI.showHome = () => calls.push("showHome");
  fakeWindow.HelloAI.applyProfile = (p) => calls.push(["applyProfile", p]);
  fakeWindow.HelloAI.saveProfile = (p) => fakeWindow.localStorage.setItem("hello-ai-profile", JSON.stringify(p));
  fakeWindow.HelloAI.readProfile = () => JSON.parse(fakeWindow.localStorage.getItem("hello-ai-profile"));

  store.set("hello-ai-profile", JSON.stringify({ dev: true, name: "Aadidev", given_name: "Aadidev" }));
  fakeWindow.HelloAI.auth.signOut();

  assert.deepEqual(calls, [["applyProfile", null], "showLogin"]);
  assert.equal(store.has("hello-ai-profile"), false);
  const toastRoot = elements.get("toastRoot");
  assert.ok(toastRoot && toastRoot.children.some((n) => n.textContent === "Signed out"),
    "expected a 'Signed out' toast");
});
