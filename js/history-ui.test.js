/**
 * history-ui.test.js — unit tests for the pure gesture/search helpers in
 * js/history-ui.js (anim-06 thresholds).
 *
 * Plain Node: `node --test js/history-ui.test.js` (no framework).
 * DOM behaviour (drawer, rows, menu, FLIP) needs a browser and is covered
 * by the manual smoke checklist in build-notes/history.md.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decideSwipeRelease,
  decideDrawerDismiss,
  HOLD,
  SWIPE,
} = require('./history-ui.js');

// --- decideSwipeRelease (anim-06 §5b) --------------------------------------

test('decideSwipeRelease: short slow drag snaps closed', () => {
  assert.equal(decideSwipeRelease(-40, -0.1), 'close');
  assert.equal(decideSwipeRelease(0, 0), 'close');
});

test('decideSwipeRelease: >= 80 px snaps open', () => {
  assert.equal(decideSwipeRelease(-80, -0.1), 'open');
  assert.equal(decideSwipeRelease(-120, -0.1), 'open');
});

test('decideSwipeRelease: fast flick opens even under 80 px', () => {
  assert.equal(decideSwipeRelease(-50, -0.4), 'open');
});

test('decideSwipeRelease: full-swipe delete needs BOTH >= 140 px AND fast velocity', () => {
  assert.equal(decideSwipeRelease(-160, -0.6), 'delete');
  assert.equal(decideSwipeRelease(-160, -0.3), 'open'); // distance alone is not enough
  assert.equal(decideSwipeRelease(-100, -0.9), 'open'); // velocity alone is not enough
});

test('decideSwipeRelease: rightward drag never opens or deletes', () => {
  assert.equal(decideSwipeRelease(100, 0.5), 'close');
});

// --- decideDrawerDismiss (anim-06 §1d) -------------------------------------

test('decideDrawerDismiss: > 35% of width dismisses', () => {
  assert.equal(decideDrawerDismiss(-200, 400, -0.1), true); // 50% of 400
  assert.equal(decideDrawerDismiss(-140, 400, -0.1), false); // exactly 35%: not over
  assert.equal(decideDrawerDismiss(-141, 400, -0.1), true);
});

test('decideDrawerDismiss: fast left flick dismisses even under 35%', () => {
  assert.equal(decideDrawerDismiss(-50, 400, -0.5), true);
  assert.equal(decideDrawerDismiss(-50, 400, -0.4), false);
});

test('decideDrawerDismiss: rightward drag never dismisses', () => {
  assert.equal(decideDrawerDismiss(100, 400, 0.5), false);
});

// --- Threshold constants match the spec -------------------------------------

test('HOLD thresholds match anim-06 §2a', () => {
  assert.equal(HOLD.TAP_MAX_MS, 200);
  assert.equal(HOLD.RING_START_MS, 250);
  assert.equal(HOLD.PIN_TRIGGER_MS, 500);
  assert.equal(HOLD.MOVE_CANCEL_PX, 10);
});

test('SWIPE thresholds match anim-06 §5', () => {
  assert.equal(SWIPE.MAX_PX, 160);
  assert.equal(SWIPE.OPEN_PX, 80);
  assert.equal(SWIPE.DELETE_PX, 140);
  assert.equal(SWIPE.OPEN_VELOCITY_PX_MS, -0.4);
  assert.equal(SWIPE.DELETE_VELOCITY_PX_MS, -0.6);
});
