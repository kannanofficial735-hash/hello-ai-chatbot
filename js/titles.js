/**
 * titles.js — chat auto-titles (PLAN §7.2, research-technical-auth-storage-voice.md §(c))
 *
 * Hybrid auto-titles, frontend only:
 *   1. Instant title: truncateTitle(firstUserMessage) — shown immediately,
 *      works offline, preserves the user's own words/language (Malayalam
 *      included). titleSource: "truncated".
 *   2. AI title: requestAiTitle(...) — one fire-and-forget Dolphin call on
 *      the SAME POST /api/chat endpoint as the main chat path (240 s timeout
 *      there; 30 s here — a title is not worth a 240 s wait). On success it
 *      replaces the truncated title; on ANY failure it returns null and the
 *      caller silently keeps the truncation. Never throws, never blocks.
 *      titleSource: "llm".
 *   3. Manual rename: this module never writes to the store. Callers MUST
 *      check `titleManual` before applying an AI title (see
 *      build-notes/titles.md) — a rename sets titleManual: true and
 *      titleSource: "manual", and auto-titling must never overwrite it.
 *
 * Pure functions, vanilla JS only, no frameworks, no dependencies.
 * Works in the browser (attaches to window.HelloAI) and in Node
 * (module.exports) so the same code is unit-tested with `node --test`.
 *
 * Security notes (security-and-hardening skill):
 *   - LLM output is UNTRUSTED input: it is validated by isSaneTitle(),
 *     stripped of quotes/trailing punctuation/newlines, and returned as a
 *     plain string. It must be rendered with textContent, never innerHTML.
 *   - The first user message is embedded in the title prompt; it is capped
 *     (500 chars) so a huge message cannot inflate the prompt/token cost.
 *   - No secrets, no tokens, no PII beyond the chat's own first message
 *     (which is already being sent to the same backend for the reply).
 *   - No error details are ever surfaced: every failure path returns null.
 */
'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.HelloAI = root.HelloAI || {};
  Object.assign(root.HelloAI, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // --- Limits (PLAN §7.2 / research §(c)) ---------------------------------
  const TITLE_MAX_CHARS = 40; // instant truncated title, ~40 chars
  const TITLE_MAX_LENGTH = 60; // AI title sanity cap
  const TITLE_MIN_WORDS = 2;
  const TITLE_MAX_WORDS = 8;
  const TITLE_TIMEOUT_MS = 30000; // AI title call: 30 s, never the 240 s chat timeout
  const TITLE_PROMPT_MAX_CHARS = 500; // cap on the user message embedded in the prompt
  const TITLE_FALLBACK_PREFIX = 'New chat — ';

  // --- Small helpers --------------------------------------------------------

  /** Collapse all whitespace (incl. newlines) to single spaces and trim. */
  function oneLine(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  /** Readable local date for the never-empty fallback, e.g. "12 Nov 2026". */
  function fallbackDate(now) {
    const date = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
    return date.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }

  // --- Instant title --------------------------------------------------------

  /**
   * First user message -> single-line title, cap ~40 chars at a word
   * boundary + "…", newlines stripped. Never empty: an empty, whitespace-
   * only, non-string, or emoji-only (no letters/digits) message falls back
   * to "New chat — <date>".
   *
   * @param {*} text - the first user message (any type; non-strings fall back)
   * @param {Date} [now] - date used for the fallback (defaults to now;
   *   injectable so tests are deterministic)
   * @returns {string} a non-empty, single-line title
   */
  function truncateTitle(text, now) {
    // Non-strings are never coerced: String({}) would give "[object Object]"
    // as a title. Only a real string message can become a title.
    if (typeof text !== 'string') {
      return TITLE_FALLBACK_PREFIX + fallbackDate(now);
    }
    const single = oneLine(text);
    // Never empty: nothing readable in the message (incl. emoji-only).
    if (!single || !/[\p{L}\p{N}]/u.test(single)) {
      return TITLE_FALLBACK_PREFIX + fallbackDate(now);
    }
    if (single.length <= TITLE_MAX_CHARS) return single;
    let cut = single.slice(0, TITLE_MAX_CHARS);
    if (/\s$/.test(cut)) {
      cut = cut.trimEnd();
    } else {
      const lastSpace = cut.lastIndexOf(' ');
      if (lastSpace > 0) cut = cut.slice(0, lastSpace);
      // No space in the first 40 chars (one long word): hard cut stands.
    }
    return cut + '…';
  }

  // --- Sanity check for AI titles ------------------------------------------

  /**
   * Is this a usable AI title? 2–8 words, ≤ 60 chars, non-empty, contains
   * at least one letter, single line, no surrounding quotes, no trailing
   * sentence punctuation, and not an echo of the title prompt (a model
   * repeating its instructions back is a failure, not a title).
   */
  function isSaneTitle(text) {
    if (typeof text !== 'string') return false;
    const title = text.trim();
    if (!title) return false;
    if (/[\r\n]/.test(title)) return false;
    if (title.length > TITLE_MAX_LENGTH) return false;
    if (/^["'“”`]+/.test(title) || /["'”`]+$/.test(title)) return false;
    if (/[.!?,:;]$/.test(title)) return false;
    const words = title.split(/\s+/);
    if (words.length < TITLE_MIN_WORDS || words.length > TITLE_MAX_WORDS) return false;
    if (!/[\p{L}]/u.test(title)) return false; // e.g. "!! ??" is not a title
    if (/generate a concise title|for a chat that started|reply with only the title|3–5 words/i.test(title)) {
      return false;
    }
    return true;
  }

  // --- Title prompt ---------------------------------------------------------

  /**
   * The exact prompt sent to Dolphin for an AI title (PLAN §7.2 / §(c.2)).
   *
   * NOTE on `firstAssistantSnippet`: it is accepted for API symmetry with
   * requestAiTitle() and for a possible future prompt revision (research
   * §(c.2) step 2 notes the first ~200 chars of the assistant reply can
   * improve titles), but it is deliberately NOT embedded in the prompt
   * today: the approved prompt text is the fixed string below, and keeping
   * it to the first user message only keeps the extra Colab call as short
   * and cheap as possible. If the prompt is ever revised to use the
   * snippet, that is a deliberate product decision, not a silent change.
   */
  function buildTitlePrompt(firstUserMessage /* , firstAssistantSnippet */) {
    const msg = oneLine(firstUserMessage).slice(0, TITLE_PROMPT_MAX_CHARS);
    return (
      'Generate a concise title, 3–5 words, in the same language as the user, ' +
      "for a chat that started with: '" + msg + "'. " +
      'Reply with only the title, no quotes, no punctuation at the end.'
    );
  }

  // --- AI title call ---------------------------------------------------------

  /**
   * Fire-and-forget Dolphin title call. POSTs the title prompt to the SAME
   * endpoint as the main chat path ({backendUrl}/api/chat, JSON {message}),
   * with a 30 s AbortController timeout. The prompt wording asks for 3–5
   * words, which is the ~20-token cap: /api/chat takes no maxTokens field,
   * so output length is enforced by the prompt + isSaneTitle() instead.
   *
   * Returns the cleaned title string, or null on ANY failure (no backend
   * URL, empty first message, offline, HTTP error, timeout, empty/garbage/
   * insane reply, no fetch available). NEVER throws. Callers must NOT
   * await this in the send path — fire it and let it resolve in the
   * background; a title must never block the chat.
   *
   * @param {string} backendUrl - e.g. the ngrok URL (trailing slashes ignored)
   * @param {string} firstUserMessage
   * @param {string} firstAssistantSnippet - accepted, see buildTitlePrompt()
   * @param {Function} [fetchFn] - injectable fetch (tests); defaults to global fetch
   * @param {Object} [options] - { timeoutMs } (default 30000; tests pass a small value)
   * @returns {Promise<string|null>}
   */
  async function requestAiTitle(backendUrl, firstUserMessage, firstAssistantSnippet, fetchFn, options) {
    try {
      const base = typeof backendUrl === 'string' ? backendUrl.trim().replace(/\/+$/, '') : '';
      if (!base || !/^https?:\/\//i.test(base)) return null;
      const msg = oneLine(firstUserMessage);
      if (!msg) return null;

      const fetchImpl =
        typeof fetchFn === 'function'
          ? fetchFn
          : typeof globalThis.fetch === 'function'
            ? globalThis.fetch.bind(globalThis)
            : null;
      if (!fetchImpl) return null;

      const timeoutMs =
        options && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
          ? options.timeoutMs
          : TITLE_TIMEOUT_MS;

      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      try {
        const res = await fetchImpl(base + '/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: buildTitlePrompt(msg, firstAssistantSnippet),
          }),
          ...(controller ? { signal: controller.signal } : {}),
        });
        if (!res || !res.ok) return null;
        const data = await res.json().catch(() => null);
        if (!data || typeof data !== 'object') return null;
        const raw =
          data.reply || data.response || data.answer || data.text || data.message;
        if (typeof raw !== 'string') return null;
        // Clean untrusted model output: first line only, strip surrounding
        // quotes, strip trailing punctuation, collapse whitespace.
        let cleaned = raw.split(/\r?\n/)[0].trim();
        cleaned = cleaned.replace(/^["'“”`]+|["'”`]+$/g, '').trim();
        cleaned = cleaned.replace(/[.!?,:;]+$/, '').trim();
        cleaned = cleaned.replace(/\s+/g, ' ');
        return isSaneTitle(cleaned) ? cleaned : null;
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch (_err) {
      // Silent by design: a title failure is never shown to the user and
      // never throws into the chat flow. The truncated title stays.
      return null;
    }
  }

  return {
    truncateTitle,
    isSaneTitle,
    buildTitlePrompt,
    requestAiTitle,
    TITLE_MAX_CHARS,
    TITLE_MAX_LENGTH,
    TITLE_MIN_WORDS,
    TITLE_MAX_WORDS,
    TITLE_TIMEOUT_MS,
    TITLE_PROMPT_MAX_CHARS,
  };
});
