/**
 * titles.test.js — unit tests for js/titles.js
 *
 * Plain Node: `node --test js/titles.test.js` (no framework, no network).
 * Spec: PLAN §7.2 + drafts/research-technical-auth-storage-voice.md §(c).
 *   - Instant title = truncated first user message (~40 chars, word
 *     boundary, ellipsis). Never empty; emoji-only/empty falls back to
 *     "New chat — <date>".
 *   - AI title = fire-and-forget Dolphin call, same POST /api/chat endpoint
 *     as the main chat path, 30 s timeout, max ~20 tokens (enforced by the
 *     prompt wording + sanity caps — /api/chat takes no maxTokens field).
 *     Returns the title string or null on ANY failure. Never throws.
 *   - A title is sane when: 2–8 words, ≤ 60 chars, non-empty, not an echo
 *     of the title prompt. Manual renames are never overwritten — callers
 *     check `titleManual` (see build-notes/titles.md); this module only
 *     produces titles, it never writes to the store.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  truncateTitle,
  isSaneTitle,
  buildTitlePrompt,
  requestAiTitle,
  TITLE_MAX_CHARS,
  TITLE_TIMEOUT_MS,
} = require('./titles.js');

// --- truncateTitle ---------------------------------------------------------

test('truncateTitle: short message is returned unchanged', () => {
  assert.equal(truncateTitle('Explain photosynthesis'), 'Explain photosynthesis');
});

test('truncateTitle: newlines and extra whitespace collapse to one line', () => {
  assert.equal(
    truncateTitle('Explain\nphotosynthesis\nplease'),
    'Explain photosynthesis please',
  );
  assert.equal(truncateTitle('  hello\t   world  '), 'hello world');
  assert.ok(!truncateTitle('a\nb\nc').includes('\n'));
});

test('truncateTitle: exactly 40 chars is not cut and gets no ellipsis', () => {
  const forty = '1234567890'.repeat(4);
  assert.equal(forty.length, 40);
  assert.equal(truncateTitle(forty), forty);
});

test('truncateTitle: long message cuts at a word boundary with an ellipsis', () => {
  // First 40 chars end in a space, so the cut is clean.
  assert.equal(
    truncateTitle('Explain photosynthesis in detail for my exam tomorrow please'),
    'Explain photosynthesis in detail for my…',
  );
  // Cut lands mid-word ("resp…") so it backs up to the previous space.
  assert.equal(
    truncateTitle('Explain photosynthesis and cellular respiration in plants today'),
    'Explain photosynthesis and cellular…',
  );
});

test('truncateTitle: a single word longer than the cap is hard-cut at 40 + ellipsis', () => {
  const longWord = 'a'.repeat(54) + ' bbb';
  assert.equal(truncateTitle(longWord), 'a'.repeat(40) + '…');
  assert.equal(truncateTitle('a'.repeat(41)), 'a'.repeat(40) + '…');
});

test('truncateTitle: result never exceeds 41 chars', () => {
  const msg = 'word '.repeat(30).trim();
  assert.ok(truncateTitle(msg).length <= 41);
  assert.ok(truncateTitle(msg).endsWith('…'));
});

test('truncateTitle: empty / whitespace-only / non-string falls back, never throws', () => {
  for (const bad of ['', '   ', '\n\t ', null, undefined, 123, {}, []]) {
    const title = truncateTitle(bad);
    assert.ok(title.startsWith('New chat — '), JSON.stringify(bad));
  }
});

test('truncateTitle: emoji-only message falls back (no letters or digits)', () => {
  assert.ok(truncateTitle('😀🎉🔥').startsWith('New chat — '));
  assert.ok(truncateTitle('👍👍').startsWith('New chat — '));
});

test('truncateTitle: emoji + real text keeps the text', () => {
  assert.equal(truncateTitle('😀 Explain photosynthesis please'), '😀 Explain photosynthesis please');
});

test('truncateTitle: fallback date is a readable local date', () => {
  const fixed = new Date('2026-11-12T10:00:00+05:30');
  assert.equal(truncateTitle('', fixed), 'New chat — 12 Nov 2026');
  // Default (no date passed) still starts with the fallback prefix.
  assert.ok(truncateTitle('').startsWith('New chat — '));
});

test('truncateTitle: Malayalam is preserved exactly', () => {
  assert.equal(truncateTitle('ഫോട്ടോസിന്തസിസ് എന്താണ്'), 'ഫോട്ടോസിന്തസിസ് എന്താണ്');
});

// --- isSaneTitle -----------------------------------------------------------

test('isSaneTitle: 2–8 words, short, plain titles are sane', () => {
  assert.equal(isSaneTitle('Photosynthesis Basics'), true);
  assert.equal(isSaneTitle('How Photosynthesis Works'), true);
  assert.equal(isSaneTitle('One two three four five six seven eight'), true);
  assert.equal(isSaneTitle('മലയാളം പാട്ട്'), true);
});

test('isSaneTitle: empty, one word, and punctuation-only are insane', () => {
  assert.equal(isSaneTitle(''), false);
  assert.equal(isSaneTitle('   '), false);
  assert.equal(isSaneTitle('Hi'), false);
  assert.equal(isSaneTitle('!! ??'), false);
  assert.equal(isSaneTitle(null), false);
  assert.equal(isSaneTitle(undefined), false);
  assert.equal(isSaneTitle(42), false);
});

test('isSaneTitle: more than 8 words is insane', () => {
  assert.equal(isSaneTitle('One two three four five six seven eight nine'), false);
});

test('isSaneTitle: over 60 chars is insane, exactly 60 is sane', () => {
  assert.equal(isSaneTitle('a'.repeat(30) + ' ' + 'b'.repeat(30)), false); // 61 chars
  assert.equal(isSaneTitle('a'.repeat(29) + ' ' + 'b'.repeat(30)), true); // 60 chars
});

test('isSaneTitle: an echo of the title prompt is insane', () => {
  assert.equal(isSaneTitle('Generate a concise title for this conversation'), false);
  assert.equal(isSaneTitle('Generate a concise title, 3–5 words'), false);
  assert.equal(
    isSaneTitle(buildTitlePrompt('Explain photosynthesis', 'Photosynthesis is how plants make food.')),
    false,
  );
  assert.equal(isSaneTitle('Reply with only the title, no quotes'), false);
});

test('isSaneTitle: quoted, punctuated-at-the-end, or multi-line titles are insane', () => {
  assert.equal(isSaneTitle('"Photosynthesis Basics"'), false);
  assert.equal(isSaneTitle('Photosynthesis Basics.'), false);
  assert.equal(isSaneTitle('Photosynthesis Basics!'), false);
  assert.equal(isSaneTitle('Photosynthesis\nBasics'), false);
});

// --- buildTitlePrompt ------------------------------------------------------

test('buildTitlePrompt: exact prompt text (snippet does not change the prompt)', () => {
  assert.equal(
    buildTitlePrompt('Explain photosynthesis', 'Photosynthesis is how plants make food.'),
    "Generate a concise title, 3–5 words, in the same language as the user, " +
      "for a chat that started with: 'Explain photosynthesis'. " +
      'Reply with only the title, no quotes, no punctuation at the end.',
  );
  assert.equal(
    buildTitlePrompt('Explain photosynthesis'),
    "Generate a concise title, 3–5 words, in the same language as the user, " +
      "for a chat that started with: 'Explain photosynthesis'. " +
      'Reply with only the title, no quotes, no punctuation at the end.',
  );
});

test('buildTitlePrompt: newlines in the message are flattened, prompt stays one line', () => {
  const prompt = buildTitlePrompt('line one\nline two', '');
  assert.ok(prompt.includes("'line one line two'"));
  assert.ok(!prompt.includes('\n'));
});

test('buildTitlePrompt: a very long first message is capped so the prompt stays short', () => {
  const long = 'prefix '.repeat(100) + 'TAILMARKER123'; // ~700 chars, marker past the cap
  const prompt = buildTitlePrompt(long, '');
  assert.ok(prompt.length < 700, `prompt was ${prompt.length} chars`);
  assert.ok(prompt.includes('prefix prefix prefix'));
  assert.ok(!prompt.includes('TAILMARKER123'));
});

// --- requestAiTitle --------------------------------------------------------

const BACKEND = 'https://example.ngrok.io';

function okFetch(reply, capture) {
  return async (url, options) => {
    if (capture) capture.url = url, capture.options = options;
    return { ok: true, status: 200, json: async () => ({ reply }) };
  };
}

test('requestAiTitle: success posts the title prompt to /api/chat and returns the title', async () => {
  const capture = {};
  const title = await requestAiTitle(
    BACKEND,
    'Explain photosynthesis',
    'Photosynthesis is how plants make food.',
    okFetch('Photosynthesis Basics', capture),
  );
  assert.equal(title, 'Photosynthesis Basics');
  assert.equal(capture.url, BACKEND + '/api/chat');
  assert.equal(capture.options.method, 'POST');
  assert.equal(capture.options.headers['Content-Type'], 'application/json');
  const body = JSON.parse(capture.options.body);
  assert.deepEqual(Object.keys(body), ['message']);
  assert.equal(
    body.message,
    buildTitlePrompt('Explain photosynthesis', 'Photosynthesis is how plants make food.'),
  );
  assert.ok(capture.options.signal instanceof AbortSignal);
});

test('requestAiTitle: trailing slashes on the backend URL are stripped', async () => {
  const capture = {};
  const title = await requestAiTitle(
    BACKEND + '///',
    'Explain photosynthesis',
    '',
    okFetch('Photosynthesis Basics', capture),
  );
  assert.equal(title, 'Photosynthesis Basics');
  assert.equal(capture.url, BACKEND + '/api/chat');
});

test('requestAiTitle: accepts the reply under alternate field names (like callBackend)', async () => {
  const fetchFn = async () => ({ ok: true, json: async () => ({ response: 'Quantum Basics' }) });
  assert.equal(await requestAiTitle(BACKEND, 'Explain quantum', '', fetchFn), 'Quantum Basics');
});

test('requestAiTitle: cleans quotes, trailing punctuation, and extra lines from the reply', async () => {
  assert.equal(
    await requestAiTitle(BACKEND, 'Explain photosynthesis', '', okFetch('"Photosynthesis Basics"')),
    'Photosynthesis Basics',
  );
  assert.equal(
    await requestAiTitle(BACKEND, 'Explain photosynthesis', '', okFetch('Photosynthesis Basics.')),
    'Photosynthesis Basics',
  );
  assert.equal(
    await requestAiTitle(BACKEND, 'Explain photosynthesis', '', okFetch('Photosynthesis Basics\nSome extra junk here')),
    'Photosynthesis Basics',
  );
});

test('requestAiTitle: offline (fetch rejects) returns null and never throws', async () => {
  const fetchFn = async () => { throw new Error('fetch failed'); };
  assert.equal(await requestAiTitle(BACKEND, 'Explain photosynthesis', '', fetchFn), null);
});

test('requestAiTitle: HTTP error status returns null', async () => {
  const fetchFn = async () => ({ ok: false, status: 500, json: async () => ({}) });
  assert.equal(await requestAiTitle(BACKEND, 'Explain photosynthesis', '', fetchFn), null);
});

test('requestAiTitle: garbage replies return null (empty, echo, too many words)', async () => {
  assert.equal(await requestAiTitle(BACKEND, 'Explain photosynthesis', '', okFetch('')), null);
  assert.equal(await requestAiTitle(BACKEND, 'Explain photosynthesis', '', okFetch('   ')), null);
  assert.equal(
    await requestAiTitle(BACKEND, 'Explain photosynthesis', '', okFetch('Generate a concise title, 3–5 words, in the same language')),
    null,
  );
  assert.equal(
    await requestAiTitle(BACKEND, 'Explain photosynthesis', '', okFetch('one two three four five six seven eight nine ten')),
    null,
  );
  assert.equal(
    await requestAiTitle(BACKEND, 'Explain photosynthesis', '', okFetch('Sorry, I could not generate an answer. Please try again.')),
    null,
  );
});

test('requestAiTitle: timeout aborts the call and returns null (fast, via timeoutMs)', async () => {
  const fetchFn = (_url, options) => new Promise((_resolve, reject) => {
    const signal = options.signal;
    if (signal.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }, { once: true });
    // Never resolves on its own — only the abort can end it.
  });
  const started = Date.now();
  const title = await requestAiTitle(BACKEND, 'Explain photosynthesis', '', fetchFn, { timeoutMs: 50 });
  assert.equal(title, null);
  assert.ok(Date.now() - started < 5000, 'timeout must fire quickly, not hang for 30 s');
});

test('requestAiTitle: missing backend URL or empty first message returns null without calling fetch', async () => {
  let called = 0;
  const fetchFn = async () => { called += 1; return { ok: true, json: async () => ({ reply: 'X Y' }) }; };
  assert.equal(await requestAiTitle('', 'Explain photosynthesis', '', fetchFn), null);
  assert.equal(await requestAiTitle(null, 'Explain photosynthesis', '', fetchFn), null);
  assert.equal(await requestAiTitle(BACKEND, '', '', fetchFn), null);
  assert.equal(await requestAiTitle(BACKEND, '   ', '', fetchFn), null);
  assert.equal(called, 0);
});

test('requestAiTitle: a synchronously-throwing fetch still returns null, never throws', async () => {
  const fetchFn = () => { throw new Error('boom'); };
  assert.equal(await requestAiTitle(BACKEND, 'Explain photosynthesis', '', fetchFn), null);
});

test('requestAiTitle: falls back to the global fetch when no fetchFn is given', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = okFetch('Global Fetch Title');
    const title = await requestAiTitle(BACKEND, 'Explain photosynthesis', '');
    assert.equal(title, 'Global Fetch Title');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('requestAiTitle: default timeout is 30 s', () => {
  assert.equal(TITLE_TIMEOUT_MS, 30000);
  assert.equal(TITLE_MAX_CHARS, 40);
});

// --- browser attach ----------------------------------------------------------

test('module attaches to window.HelloAI (globalThis) as well as module.exports', () => {
  assert.equal(typeof globalThis.HelloAI, 'object');
  assert.equal(typeof globalThis.HelloAI.truncateTitle, 'function');
  assert.equal(typeof globalThis.HelloAI.isSaneTitle, 'function');
  assert.equal(typeof globalThis.HelloAI.buildTitlePrompt, 'function');
  assert.equal(typeof globalThis.HelloAI.requestAiTitle, 'function');
});
