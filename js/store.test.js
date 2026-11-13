/**
 * store.test.js — unit tests for js/store.js (history + storage module)
 *
 * Plain Node: `node --test js/store.test.js` (no framework).
 * Only the pure helpers are tested here; the Dexie/IndexedDB paths need a
 * browser and are covered by the smoke check in history.md instead.
 * PLAN §7.5, research-technical-auth-storage-voice.md §(b).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  groupChats,
  relativeTime,
  truncatePreview,
  sortChats,
  pickChatsToPrune,
  validateExportData,
  buildExportPayload,
  chatToMarkdown,
  isQuotaError,
  matchesQuery,
  MAX_CHATS,
  MAX_MESSAGES_PER_CHAT,
  EXPORT_VERSION,
  PREVIEW_MAX_CHARS,
} = require('./store.js');

const NOW = new Date('2026-11-12T18:00:00+05:30').getTime();
const HOUR = 3600_000;
const DAY = 24 * HOUR;

function chat(overrides) {
  return Object.assign(
    {
      id: 'c1',
      userSub: 'sub-1',
      title: 'Test chat',
      titleSource: 'truncated',
      titleManual: false,
      preview: 'hello world',
      previewAt: NOW,
      previewRole: 'user',
      messageCount: 1,
      pinned: false,
      pinnedAt: null,
      archived: false,
      createdAt: NOW - HOUR,
      updatedAt: NOW - HOUR,
    },
    overrides
  );
}

// --- groupChats -------------------------------------------------------------

test('groupChats: pinned chats always land in the Pinned group first', () => {
  const groups = groupChats(
    [chat({ id: 'p1', pinned: true, pinnedAt: NOW, updatedAt: NOW - 30 * DAY })],
    NOW
  );
  assert.equal(groups.pinned.length, 1);
  assert.equal(groups.today.length, 0);
  assert.equal(groups.older.length, 0);
});

test('groupChats: today / yesterday / last 7 / last 30 / older buckets', () => {
  const groups = groupChats(
    [
      chat({ id: 't', updatedAt: NOW - HOUR }),
      chat({ id: 'y', updatedAt: NOW - DAY - HOUR }),
      chat({ id: 'w', updatedAt: NOW - 4 * DAY }),
      chat({ id: 'm', updatedAt: NOW - 20 * DAY }),
      chat({ id: 'o', updatedAt: NOW - 90 * DAY }),
    ],
    NOW
  );
  assert.deepEqual(groups.today.map((c) => c.id), ['t']);
  assert.deepEqual(groups.yesterday.map((c) => c.id), ['y']);
  assert.deepEqual(groups.last7.map((c) => c.id), ['w']);
  assert.deepEqual(groups.last30.map((c) => c.id), ['m']);
  assert.deepEqual(groups.older.map((c) => c.id), ['o']);
});

test('groupChats: archived chats are excluded unless requested', () => {
  const groups = groupChats([chat({ id: 'a', archived: true })], NOW);
  assert.equal(groups.today.length, 0);
  const withArchived = groupChats([chat({ id: 'a', archived: true })], NOW, {
    includeArchived: true,
  });
  assert.equal(withArchived.today.length, 1);
});

// --- relativeTime -----------------------------------------------------------

test('relativeTime: just now / minutes / hours / yesterday / days / date', () => {
  assert.equal(relativeTime(NOW - 30_000, NOW), 'Just now');
  assert.equal(relativeTime(NOW - 60_000, NOW), '1 min ago');
  assert.equal(relativeTime(NOW - 5 * 60_000, NOW), '5 min ago');
  assert.equal(relativeTime(NOW - 2 * HOUR, NOW), '2 h ago');
  assert.equal(relativeTime(NOW - DAY - HOUR, NOW), 'Yesterday');
  assert.equal(relativeTime(NOW - 3 * DAY, NOW), '3 d ago');
  assert.match(relativeTime(NOW - 40 * DAY, NOW), /^\d{1,2} [A-Z][a-z]{2} \d{4}$/);
});

test('relativeTime: future timestamps never say "ago"', () => {
  assert.equal(relativeTime(NOW + HOUR, NOW), 'Just now');
});

// --- truncatePreview --------------------------------------------------------

test('truncatePreview: one line, collapses whitespace, caps at word boundary', () => {
  assert.equal(truncatePreview('hello\n\nworld   again'), 'hello world again');
  const long = 'word '.repeat(40).trim();
  const out = truncatePreview(long);
  assert.ok(out.length <= PREVIEW_MAX_CHARS + 1);
  assert.ok(out.endsWith('…'));
  assert.equal(truncatePreview(''), '');
  assert.equal(truncatePreview(null), '');
});

// --- sortChats --------------------------------------------------------------

test('sortChats: pinned first by pinnedAt desc, then updatedAt desc', () => {
  const sorted = sortChats([
    chat({ id: 'old', updatedAt: NOW - 5 * DAY }),
    chat({ id: 'p2', pinned: true, pinnedAt: NOW - HOUR, updatedAt: NOW - 9 * DAY }),
    chat({ id: 'p1', pinned: true, pinnedAt: NOW, updatedAt: NOW - 9 * DAY }),
    chat({ id: 'new', updatedAt: NOW }),
  ]);
  assert.deepEqual(sorted.map((c) => c.id), ['p1', 'p2', 'new', 'old']);
});

// --- pickChatsToPrune -------------------------------------------------------

test('pickChatsToPrune: oldest unpinned first, never pinned, caps at MAX_CHATS', () => {
  assert.equal(MAX_CHATS, 200);
  assert.equal(MAX_MESSAGES_PER_CHAT, 500);
  const many = [];
  for (let i = 0; i < 202; i++) {
    many.push(chat({ id: 'c' + i, updatedAt: NOW - i * HOUR }));
  }
  many[0].pinned = true;
  many[0].pinnedAt = NOW;
  const pruned = pickChatsToPrune(many, MAX_CHATS);
  assert.equal(pruned.length, 2);
  assert.ok(!pruned.includes('c0')); // pinned is never pruned
  assert.ok(pruned.includes('c201')); // oldest unpinned goes first
  assert.ok(pruned.includes('c200'));
});

test('pickChatsToPrune: under the cap nothing is pruned', () => {
  assert.deepEqual(pickChatsToPrune([chat({ id: 'a' })], MAX_CHATS), []);
});

test('pickChatsToPrune: all-pinned over-cap list prunes nothing (never pinned)', () => {
  const all = [
    chat({ id: 'a', pinned: true, pinnedAt: NOW }),
    chat({ id: 'b', pinned: true, pinnedAt: NOW }),
  ];
  assert.deepEqual(pickChatsToPrune(all, 1), []);
});

// --- validateExportData -----------------------------------------------------

test('validateExportData: accepts a well-formed v1 export', () => {
  const data = buildExportPayload([chat()], [{ id: 'm1', chatId: 'c1' }], 'sub-1', NOW);
  assert.equal(validateExportData(data).ok, true);
});

test('validateExportData: rejects wrong version, missing fields, bad rows', () => {
  assert.equal(validateExportData(null).ok, false);
  assert.equal(validateExportData({ version: 2, chats: [], messages: [] }).ok, false);
  assert.equal(validateExportData({ version: 1, chats: 'nope', messages: [] }).ok, false);
  assert.equal(
    validateExportData({ version: 1, chats: [{ title: 'no id' }], messages: [] }).ok,
    false
  );
  assert.equal(
    validateExportData({ version: 1, chats: [], messages: [{ id: 'm' }] }).ok,
    false
  );
});

test('buildExportPayload: versioned envelope, EXPORT_VERSION is 1', () => {
  assert.equal(EXPORT_VERSION, 1);
  const payload = buildExportPayload([], [], 'sub-9', NOW);
  assert.equal(payload.version, 1);
  assert.equal(payload.userSub, 'sub-9');
  assert.equal(payload.exportedAt, NOW);
});

// --- chatToMarkdown ---------------------------------------------------------

test('chatToMarkdown: title heading + labelled turns, no HTML', () => {
  const md = chatToMarkdown(
    chat({ title: 'Photosynthesis basics', createdAt: NOW }),
    [
      { role: 'user', content: 'Explain photosynthesis', createdAt: NOW },
      { role: 'assistant', content: 'Plants use sunlight.', createdAt: NOW + 1000 },
    ]
  );
  assert.ok(md.startsWith('# Photosynthesis basics'));
  assert.ok(md.includes('**You:** Explain photosynthesis'));
  assert.ok(md.includes('**Hello AI:** Plants use sunlight.'));
  assert.ok(!md.includes('<'));
});

// --- isQuotaError -----------------------------------------------------------

test('isQuotaError: QuotaExceededError by name or DOMException code 22', () => {
  const byName = new Error('full');
  byName.name = 'QuotaExceededError';
  assert.equal(isQuotaError(byName), true);
  const byCode = new Error('full');
  byCode.code = 22;
  assert.equal(isQuotaError(byCode), true);
  assert.equal(isQuotaError(new Error('other')), false);
  assert.equal(isQuotaError(null), false);
});

// --- matchesQuery -----------------------------------------------------------

test('matchesQuery: title + preview, case-insensitive, empty query matches all', () => {
  const c = chat({ title: 'Photosynthesis', preview: 'Explain quantum stuff' });
  assert.equal(matchesQuery(c, ''), true);
  assert.equal(matchesQuery(c, 'photo'), true);
  assert.equal(matchesQuery(c, 'QUANTUM'), true);
  assert.equal(matchesQuery(c, 'banana'), false);
});
