/**
 * greeting.test.js — unit tests for js/greeting.js
 *
 * Plain Node: `node --test js/greeting.test.js` (no framework).
 * Time bands (PLAN §5.2, adopted decision):
 *   05:00–12:00 Good morning · 12:00–17:00 Good afternoon
 *   17:00–21:00 Good evening · 21:00–05:00 Good night (local device time)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getGreeting,
  formatGreeting,
  nextBoundaryMs,
  resolveDisplayName,
  BOUNDARY_HOURS,
} = require('./greeting.js');

// --- getGreeting: every band -----------------------------------------------

test('getGreeting: 05:00–11:59 is Good morning', () => {
  assert.equal(getGreeting(5), 'Good morning');
  assert.equal(getGreeting(8), 'Good morning');
  assert.equal(getGreeting(11), 'Good morning');
});

test('getGreeting: 12:00–16:59 is Good afternoon', () => {
  assert.equal(getGreeting(12), 'Good afternoon');
  assert.equal(getGreeting(14), 'Good afternoon');
  assert.equal(getGreeting(16), 'Good afternoon');
});

test('getGreeting: 17:00–20:59 is Good evening', () => {
  assert.equal(getGreeting(17), 'Good evening');
  assert.equal(getGreeting(19), 'Good evening');
  assert.equal(getGreeting(20), 'Good evening');
});

test('getGreeting: 21:00–04:59 is Good night', () => {
  assert.equal(getGreeting(21), 'Good night');
  assert.equal(getGreeting(23), 'Good night');
  assert.equal(getGreeting(0), 'Good night');
  assert.equal(getGreeting(2), 'Good night');
  assert.equal(getGreeting(4), 'Good night');
});

test('getGreeting: rejects out-of-range / non-integer hours', () => {
  assert.throws(() => getGreeting(-1), RangeError);
  assert.throws(() => getGreeting(24), RangeError);
  assert.throws(() => getGreeting(5.5), RangeError);
  assert.throws(() => getGreeting(Number.NaN), RangeError);
});

// --- formatGreeting: name insertion + empty-name fallback ------------------

test('formatGreeting: inserts the name after the salutation', () => {
  assert.equal(formatGreeting('Aadidev', 9), 'Good morning, Aadidev');
  assert.equal(formatGreeting('Aadidev', 13), 'Good afternoon, Aadidev');
  assert.equal(formatGreeting('Aadidev', 18), 'Good evening, Aadidev');
  assert.equal(formatGreeting('Aadidev', 22), 'Good night, Aadidev');
});

test('formatGreeting: empty name falls back to salutation only, no crash', () => {
  assert.equal(formatGreeting('', 9), 'Good morning');
  assert.equal(formatGreeting('   ', 13), 'Good afternoon');
  assert.equal(formatGreeting(null, 18), 'Good evening');
  assert.equal(formatGreeting(undefined, 22), 'Good night');
});

test('formatGreeting: trims surrounding whitespace from the name', () => {
  assert.equal(formatGreeting('  Aadidev  ', 9), 'Good morning, Aadidev');
});

// --- nextBoundaryMs: every boundary minute ---------------------------------
// Local-time dates, so the test is timezone-independent.

function localDate(hours, minutes) {
  const d = new Date();
  d.setHours(hours, minutes, 0, 0);
  return d;
}

function assertNextBoundary(fromH, fromM, toH, toM, nextDay) {
  const from = localDate(fromH, fromM);
  const got = new Date(nextBoundaryMs(from));
  const want = localDate(toH, toM);
  if (nextDay) want.setDate(want.getDate() + 1);
  assert.equal(got.getTime(), want.getTime(),
    `from ${fromH}:${String(fromM).padStart(2, '0')} expected ${toH}:${String(toM).padStart(2, '0')}${nextDay ? ' next day' : ''}, got ${got.toLocaleTimeString()}`);
}

test('nextBoundaryMs: 04:59 -> 05:00 same day', () => {
  assertNextBoundary(4, 59, 5, 0, false);
});

test('nextBoundaryMs: exactly 05:00 -> 12:00 (boundary itself is past)', () => {
  assertNextBoundary(5, 0, 12, 0, false);
});

test('nextBoundaryMs: 11:59 -> 12:00 same day', () => {
  assertNextBoundary(11, 59, 12, 0, false);
});

test('nextBoundaryMs: exactly 12:00 -> 17:00', () => {
  assertNextBoundary(12, 0, 17, 0, false);
});

test('nextBoundaryMs: 16:59 -> 17:00 same day', () => {
  assertNextBoundary(16, 59, 17, 0, false);
});

test('nextBoundaryMs: exactly 17:00 -> 21:00', () => {
  assertNextBoundary(17, 0, 21, 0, false);
});

test('nextBoundaryMs: 20:59 -> 21:00 same day', () => {
  assertNextBoundary(20, 59, 21, 0, false);
});

test('nextBoundaryMs: exactly 21:00 -> 05:00 next day', () => {
  assertNextBoundary(21, 0, 5, 0, true);
});

test('nextBoundaryMs: 23:30 -> 05:00 next day', () => {
  assertNextBoundary(23, 30, 5, 0, true);
});

test('nextBoundaryMs: accepts a numeric timestamp as well as a Date', () => {
  const from = localDate(4, 59);
  const want = localDate(5, 0);
  assert.equal(nextBoundaryMs(from.getTime()), want.getTime());
});

test('nextBoundaryMs: result is always strictly in the future', () => {
  for (const [h, m] of [[0, 0], [5, 0], [12, 0], [17, 0], [21, 0], [23, 59]]) {
    const from = localDate(h, m);
    assert.ok(nextBoundaryMs(from) > from.getTime(), `not future from ${h}:${m}`);
  }
});

// --- resolveDisplayName: name source priority -------------------------------

test('resolveDisplayName: Google given_name wins over a stored name', () => {
  assert.equal(
    resolveDisplayName({ profileGivenName: 'Aadidev', storedName: 'Kannan' }),
    'Aadidev');
});

test('resolveDisplayName: stored name is used when there is no profile name', () => {
  assert.equal(
    resolveDisplayName({ profileGivenName: '', storedName: 'Aadidev' }),
    'Aadidev');
});

test('resolveDisplayName: empty string when no name is known anywhere', () => {
  assert.equal(resolveDisplayName({ profileGivenName: '', storedName: '' }), '');
  assert.equal(resolveDisplayName({}), '');
});

test('resolveDisplayName: trims whitespace', () => {
  assert.equal(
    resolveDisplayName({ profileGivenName: '  Aadidev ', storedName: '' }),
    'Aadidev');
});

// --- constants ---------------------------------------------------------------

test('BOUNDARY_HOURS lists the four band starts in order', () => {
  assert.deepEqual(BOUNDARY_HOURS, [5, 12, 17, 21]);
});

// --- initGreeting: name arriving after init (QA C-1) -----------------------
// Minimal DOM stub: just enough for initGreeting + createNamePrompt.

class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.textContent = '';
    this.hidden = false;
    this.value = '';
    this.style = {};
    this._classSet = new Set();
    this._attrs = {};
    this._listeners = {};
    this._closest = null;
  }
  get className() { return [...this._classSet].join(' '); }
  set className(v) { this._classSet = new Set(String(v || '').split(/\s+/).filter(Boolean)); }
  get classList() {
    const set = this._classSet;
    return {
      add: (...c) => c.forEach((x) => set.add(x)),
      remove: (...c) => c.forEach((x) => set.delete(x)),
      toggle: (c, f) => {
        if (f === undefined) f = !set.has(c);
        if (f) set.add(c); else set.delete(c);
        return f;
      },
      contains: (c) => set.has(c),
    };
  }
  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { return this._attrs[k]; }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  removeEventListener() {}
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  insertBefore(child, ref) {
    child.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i === -1) this.children.push(child); else this.children.splice(i, 0, child);
    return child;
  }
  remove() {
    if (!this.parentNode) return;
    const i = this.parentNode.children.indexOf(this);
    if (i !== -1) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
  }
  get nextSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.children.indexOf(this);
    return this.parentNode.children[i + 1] || null;
  }
  closest() { return this._closest; }
  querySelector(sel) {
    const cls = sel.startsWith('.') ? sel.slice(1) : null;
    const walk = (node) => {
      for (const ch of node.children) {
        if (cls && ch._classSet.has(cls)) return ch;
        const found = walk(ch);
        if (found) return found;
      }
      return null;
    };
    return walk(this);
  }
}

function makeStore() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

// Installs the stub globals and returns the shell elements + a supplier
// whose returned name the test can change at any time.
function installGreetingDom(initialName) {
  const heroEl = new FakeEl('div');
  const salutationEl = new FakeEl('div');
  const nameEl = new FakeEl('div');
  const subEl = new FakeEl('div');
  const container = new FakeEl('div');
  container.appendChild(heroEl);
  heroEl.appendChild(salutationEl);
  salutationEl._closest = heroEl;
  const supplier = { name: initialName || '' };
  global.document = {
    getElementById: (id) => (
      { greetingText: salutationEl, greetingName: nameEl, greetingSub: subEl }[id] || null),
    querySelector: (sel) => (sel === '.home-hero' ? heroEl : null),
    createElement: (tag) => new FakeEl(tag),
    addEventListener: () => {},
    hidden: false,
  };
  global.window = {
    setTimeout, setInterval, clearTimeout, clearInterval,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  global.localStorage = makeStore();
  global.sessionStorage = makeStore();
  return {
    heroEl, salutationEl, nameEl, subEl, container, supplier,
    getProfileGivenName: () => supplier.name,
    hasNamePrompt: () => container.children.some((c) => c._classSet.has('name-prompt')),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('initGreeting: name arriving after init appears on refresh, prompt removed (C-1)', async () => {
  const { initGreeting } = require('./greeting.js');
  const dom = installGreetingDom(''); // no profile yet at boot (first sign-in)
  const ctl = initGreeting({ getProfileGivenName: dom.getProfileGivenName });
  assert.ok(ctl, 'initGreeting should return a controller');
  try {
    await sleep(950); // past the 800 ms name-reveal wait: prompt is now shown
    assert.equal(dom.nameEl.textContent, '');
    assert.equal(dom.hasNamePrompt(), true, 'prompt shows while no name is known');
    // The profile arrives (dev-skip / GIS sign-in) and Home re-renders.
    dom.supplier.name = 'Aadidev';
    ctl.refresh();
    assert.equal(dom.nameEl.textContent, 'Aadidev');
    assert.equal(dom.nameEl.hidden, false);
    assert.equal(dom.hasNamePrompt(), false, 'prompt must go once the profile name exists');
  } finally {
    ctl.stop(); // clear the 60 s re-check interval
  }
});

test('initGreeting: profile name present at init renders it with no prompt', () => {
  const { initGreeting } = require('./greeting.js');
  const dom = installGreetingDom('Aadidev'); // return visit: profile already stored
  const ctl = initGreeting({ getProfileGivenName: dom.getProfileGivenName });
  assert.ok(ctl, 'initGreeting should return a controller');
  try {
    assert.equal(dom.nameEl.textContent, 'Aadidev');
    assert.equal(dom.nameEl.hidden, false);
    assert.equal(dom.hasNamePrompt(), false, 'no name prompt when the profile has a name');
  } finally {
    ctl.stop();
  }
});

test('initGreeting: refresh() without a profile never invents a name', async () => {
  const { initGreeting } = require('./greeting.js');
  const dom = installGreetingDom('');
  const ctl = initGreeting({ getProfileGivenName: dom.getProfileGivenName });
  assert.ok(ctl, 'initGreeting should return a controller');
  try {
    ctl.refresh();
    assert.equal(dom.nameEl.textContent, '');
    assert.equal(dom.nameEl.hidden, true);
  } finally {
    ctl.stop();
  }
});
