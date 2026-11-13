/**
 * greeting.js — time-based greeting for the Hello AI home page.
 *
 * Pure, unit-testable core (getGreeting / formatGreeting / nextBoundaryMs /
 * resolveDisplayName) plus a thin browser controller (initGreeting) that
 * wires it to the shell. Vanilla JS only, no frameworks.
 *
 * Time bands (PLAN §5.2, adopted decision — local device time):
 *   05:00–12:00  Good morning
 *   12:00–17:00  Good afternoon
 *   17:00–21:00  Good evening
 *   21:00–05:00  Good night
 *
 * Name source: Google profile `given_name` when signed in, else a locally
 * stored name. If no name is known, the user is asked once via a polite
 * inline prompt on first visit. A name is NEVER guessed.
 *
 * Behaviour (PLAN §5.2 + drafts/anim-05-greeting.md §3):
 * - Greeting re-checked every 60 s + on foreground (visibilitychange/focus).
 * - A boundary crossing swaps ONLY the salutation (250 ms out + 350 ms in,
 *   50 ms overlap), layout locked so name/chips/composer never move.
 * - Load reveal: salutation 80 ms, name 180 ms, sub-line 300 ms.
 * - Reduced motion: swaps and reveals happen instantly, no animation.
 * - User content (the name) is only ever inserted via textContent —
 *   never innerHTML.
 */
'use strict';

var BOUNDARY_HOURS = [5, 12, 17, 21];
var SALUTATIONS = ['Good night', 'Good morning', 'Good afternoon', 'Good evening'];
/* Index into SALUTATIONS by band: hour < 5 -> 0 (night), < 12 -> 1 (morning),
   < 17 -> 2 (afternoon), < 21 -> 3 (evening), else 0 (night). */
var RECHECK_MS = 60 * 1000;
var NAME_REVEAL_WAIT_MS = 800; // anim-05 §1: wait for the name, max ~800 ms
var STORAGE_KEY = 'helloai.greetingName';

/**
 * Salutation for a local hour (0–23).
 * @param {number} hour - integer hour, local device time
 * @returns {string} "Good morning" | "Good afternoon" | "Good evening" | "Good night"
 * @throws {RangeError} for non-integer or out-of-range hours
 */
function getGreeting(hour) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new RangeError('getGreeting: hour must be an integer 0–23, got ' + hour);
  }
  if (hour < 5) return 'Good night';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  if (hour < 21) return 'Good evening';
  return 'Good night';
}

/**
 * Full greeting line. Empty/blank/unknown name -> salutation only, no crash.
 * @param {string|null|undefined} name
 * @param {number} hour - integer hour, local device time
 * @returns {string} e.g. "Good morning, Aadidev" or "Good morning"
 */
function formatGreeting(name, hour) {
  var salutation = getGreeting(hour);
  var clean = typeof name === 'string' ? name.trim() : '';
  return clean ? salutation + ', ' + clean : salutation;
}

/**
 * Milliseconds (epoch) of the next band boundary strictly after `now`.
 * Boundaries: 05:00, 12:00, 17:00, 21:00 local time. A `now` exactly on a
 * boundary returns the FOLLOWING boundary.
 * @param {Date|number} now - a Date or epoch-ms timestamp
 * @returns {number} epoch-ms of the next boundary
 */
function nextBoundaryMs(now) {
  var t = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(t)) throw new RangeError('nextBoundaryMs: invalid time');
  var base = new Date(t);
  for (var i = 0; i < BOUNDARY_HOURS.length; i++) {
    var candidate = new Date(base);
    candidate.setHours(BOUNDARY_HOURS[i], 0, 0, 0);
    if (candidate.getTime() > t) return candidate.getTime();
  }
  // All of today's boundaries have passed: first boundary tomorrow.
  var tomorrow = new Date(base);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(BOUNDARY_HOURS[0], 0, 0, 0);
  return tomorrow.getTime();
}

/**
 * Pick the display name. Google profile given_name wins; the locally stored
 * name is the fallback. Returns '' when nothing is known (caller asks once).
 * @param {{profileGivenName?: string, storedName?: string}} [sources]
 * @returns {string}
 */
function resolveDisplayName(sources) {
  var s = sources || {};
  var profile = typeof s.profileGivenName === 'string' ? s.profileGivenName.trim() : '';
  if (profile) return profile;
  var stored = typeof s.storedName === 'string' ? s.storedName.trim() : '';
  return stored;
}

/* ------------------------------------------------------------------ */
/* Storage helpers (localStorage only; injectable for tests)           */
/* ------------------------------------------------------------------ */

function defaultStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch (e) {
    return null; // e.g. storage blocked (private mode)
  }
}

function getStoredName(storage) {
  var store = storage || defaultStorage();
  if (!store) return '';
  try {
    var value = store.getItem(STORAGE_KEY);
    return typeof value === 'string' ? value.trim() : '';
  } catch (e) {
    return '';
  }
}

function setStoredName(name, storage) {
  var store = storage || defaultStorage();
  if (!store) return false;
  var clean = typeof name === 'string' ? name.trim() : '';
  if (!clean) return false;
  try {
    store.setItem(STORAGE_KEY, clean);
    return true;
  } catch (e) {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Browser controller — wires the pure core to the shell.              */
/* Only runs in a browser (guarded by typeof document / window).       */
/* ------------------------------------------------------------------ */

function prefersReducedMotion() {
  try {
    return typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) {
    return false;
  }
}

/**
 * Swap only the salutation text inside an element, with the anim-05 §3
 * choreography (250 ms out + 350 ms in, 50 ms overlap). With reduced motion
 * the text swaps instantly. Layout is locked by CSS (.home-hero__salutation
 * has a fixed min-height), so nothing below the salutation moves.
 * @param {HTMLElement} el - element holding the salutation (textContent only)
 * @param {string} newText - new salutation, e.g. "Good afternoon"
 */
function swapSalutation(el, newText) {
  if (!el) return;
  if (el.textContent === newText) return;
  if (prefersReducedMotion()) {
    el.textContent = newText;
    return;
  }
  el.classList.add('greeting-swap-out');
  window.setTimeout(function () {
    el.textContent = newText;
    el.classList.remove('greeting-swap-out');
    el.classList.add('greeting-swap-in');
    window.setTimeout(function () {
      el.classList.remove('greeting-swap-in');
    }, 350);
  }, 200); // 50 ms overlap with the 250 ms out-phase
}

/**
 * Build the polite inline name prompt ("What should I call you?") and
 * insert it after `anchorEl`. All user content goes in via textContent /
 * input values — never innerHTML. The prompt asks ONCE: it is only shown
 * when no name is known, and saving stores the name locally.
 * @param {HTMLElement} anchorEl - element to insert the prompt after
 * @param {(name: string) => void} onSave - called with the trimmed name
 * @returns {HTMLElement|null} the prompt element, or null if not in a browser
 */
function createNamePrompt(anchorEl, onSave) {
  if (typeof document === 'undefined' || !anchorEl || !anchorEl.parentNode) return null;
  var prompt = document.createElement('form');
  prompt.className = 'name-prompt';
  prompt.setAttribute('aria-label', 'Choose the name Hello AI calls you');

  var label = document.createElement('label');
  label.className = 'name-prompt__label';
  label.textContent = 'What should I call you?';
  label.setAttribute('for', 'namePromptInput');

  var input = document.createElement('input');
  input.className = 'name-prompt__input';
  input.id = 'namePromptInput';
  input.type = 'text';
  input.setAttribute('autocomplete', 'given-name');
  input.setAttribute('maxlength', '40');
  input.setAttribute('placeholder', 'Your first name');

  var save = document.createElement('button');
  save.className = 'name-prompt__save';
  save.type = 'submit';
  save.textContent = 'Save';

  var skip = document.createElement('button');
  skip.className = 'name-prompt__skip';
  skip.type = 'button';
  skip.textContent = 'Not now';
  skip.setAttribute('aria-label', 'Skip choosing a name for now');

  prompt.appendChild(label);
  prompt.appendChild(input);
  prompt.appendChild(save);
  prompt.appendChild(skip);

  prompt.addEventListener('submit', function (event) {
    event.preventDefault();
    var name = input.value.trim();
    if (!name) {
      input.focus();
      return;
    }
    if (onSave) onSave(name);
    prompt.remove();
  });
  skip.addEventListener('click', function () {
    // Asked once: dismissing records that we asked, so it does not nag.
    try { sessionStorage.setItem('helloai.namePromptDismissed', '1'); } catch (e) {}
    prompt.remove();
  });

  anchorEl.parentNode.insertBefore(prompt, anchorEl.nextSibling);
  return prompt;
}

function namePromptWasDismissed() {
  try {
    return typeof sessionStorage !== 'undefined' &&
      sessionStorage.getItem('helloai.namePromptDismissed') === '1';
  } catch (e) {
    return false;
  }
}

/**
 * Initialise the home greeting. Expected shell (see build-notes/greeting.md):
 *   #greetingText — salutation line (textContent set here)
 *   #greetingName — name line (textContent set here; hidden when no name)
 *   #greetingSub  — sub-line, static copy owned by the shell
 *   #chipsRow     — suggestion chips row (reveal timing only)
 *   .home-hero    — hero card; gets .home-hero--reveal for the load reveal
 *
 * @param {Object} [options]
 * @param {() => string} [options.getProfileGivenName] - Google profile
 *   given_name when signed in (panel/auth module supplies this); '' otherwise
 * @param {string} [options.subLine] - sub-line copy (default in the shell)
 * @returns {{stop: () => void, refresh: () => void}|null} controller handle
 */
function initGreeting(options) {
  if (typeof document === 'undefined') return null;
  var opts = options || {};

  var hero = document.querySelector('.home-hero');
  var salutationEl = document.getElementById('greetingText');
  var nameEl = document.getElementById('greetingName');
  var subEl = document.getElementById('greetingSub');
  if (!salutationEl) return null; // shell not ready; app.js retries after mount

  var currentSalutation = '';
  var displayName = '';
  var timerId = null;
  var stopped = false;
  var promptEl = null; // the inline name prompt, if one is currently shown

  // Re-read the name from its sources (Google profile first, then local
  // storage) and update displayName. Returns true when the name changed.
  function resolveName() {
    var profileName = '';
    try {
      profileName = typeof opts.getProfileGivenName === 'function'
        ? (opts.getProfileGivenName() || '')
        : '';
    } catch (e) {
      profileName = '';
    }
    var next = resolveDisplayName({
      profileGivenName: profileName,
      storedName: getStoredName(),
    });
    var changed = next !== displayName;
    displayName = next;
    return changed;
  }

  function renderName() {
    if (!nameEl) return;
    if (displayName) {
      nameEl.textContent = displayName;
      nameEl.hidden = false;
    } else {
      nameEl.textContent = '';
      nameEl.hidden = true; // salutation-only greeting, no placeholder name
    }
  }

  function renderSalutation(animate) {
    var next = getGreeting(new Date().getHours());
    if (next === currentSalutation) return;
    if (animate && currentSalutation) {
      swapSalutation(salutationEl, next);
    } else {
      salutationEl.textContent = next;
    }
    currentSalutation = next;
  }

  // Re-check: every 60 s + on foreground. If the page was hidden across
  // two boundaries, jump straight to the current greeting — never replay
  // two swaps in a row (anim-05 §3).
  // C-1 fix: also re-resolve the display name on EVERY refresh. The
  // profile only exists after sign-in, which happens after boot, so a
  // name resolved once at init stays '' forever on a first sign-in.
  // app.js calls refresh() from showHome() after sign-in, so re-reading
  // here fills #greetingName and drops the name prompt.
  function refresh() {
    resolveName();
    renderName();
    if (displayName && promptEl) {
      promptEl.remove();
      promptEl = null;
    }
    renderSalutation(true);
  }

  function onForeground() {
    if (!stopped) refresh();
  }

  function startWatcher() {
    if (timerId !== null) return;
    timerId = window.setInterval(function () {
      if (!stopped) refresh();
    }, RECHECK_MS);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) onForeground();
    });
    window.addEventListener('focus', onForeground);
  }

  function stop() {
    stopped = true;
    if (timerId !== null) {
      window.clearInterval(timerId);
      timerId = null;
    }
    window.removeEventListener('focus', onForeground);
  }

  // Resolve the name: Google profile first, then local storage.
  // Wait for the profile name up to NAME_REVEAL_WAIT_MS (anim-05 §1) so we
  // never animate a placeholder name and then swap it.
  resolveName();

  function reveal() {
    renderName();
    renderSalutation(false);
    if (subEl) subEl.hidden = false;
    // Load reveal (anim-05 §1): salutation 80 ms, name 180 ms, sub 300 ms.
    // The class only ADDS the animation; without it the text is visible
    // in its final state, so a JS failure never hides the greeting.
    if (hero && !prefersReducedMotion()) {
      hero.classList.add('home-hero--reveal');
    }
    startWatcher();
    maybeAskName();
  }

  function maybeAskName() {
    // Check the profile FIRST, every time: the prompt must NEVER appear
    // when a profile with a given_name exists (C-1 — the first-sign-in
    // prompt asked for a name Google had already given).
    resolveName();
    if (displayName) {
      renderName();
      return;
    }
    // Ask once, politely, only when no name is known anywhere.
    if (namePromptWasDismissed()) return;
    var prompt = createNamePrompt(salutationEl.closest('.home-hero') || salutationEl,
      function (name) {
        setStoredName(name);
        displayName = name;
        promptEl = null;
        renderName();
      });
    promptEl = prompt;
    if (prompt) {
      var input = prompt.querySelector('.name-prompt__input');
      // Don't steal focus on load; the user can tap the field when ready.
      if (input) input.value = '';
    }
  }

  if (displayName) {
    reveal();
  } else {
    // Name may still arrive from auth (GIS callback); give it a beat,
    // then reveal with salutation only and fade the name in when it lands.
    window.setTimeout(function () {
      if (stopped) return;
      if (!displayName) resolveName(); // profile may have landed meanwhile
      reveal();
    }, NAME_REVEAL_WAIT_MS);
    // Render the salutation immediately so the hero is never blank.
    renderSalutation(false);
  }

  return { stop: stop, refresh: refresh };
}

/* ------------------------------------------------------------------ */
/* Exports: Node test use AND browser global.                          */
/* ------------------------------------------------------------------ */

var api = {
  BOUNDARY_HOURS: BOUNDARY_HOURS,
  SALUTATIONS: SALUTATIONS,
  RECHECK_MS: RECHECK_MS,
  STORAGE_KEY: STORAGE_KEY,
  getGreeting: getGreeting,
  formatGreeting: formatGreeting,
  nextBoundaryMs: nextBoundaryMs,
  resolveDisplayName: resolveDisplayName,
  getStoredName: getStoredName,
  setStoredName: setStoredName,
  swapSalutation: swapSalutation,
  createNamePrompt: createNamePrompt,
  prefersReducedMotion: prefersReducedMotion,
  initGreeting: initGreeting,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.HelloAI = window.HelloAI || {};
  window.HelloAI.greeting = api;
}
