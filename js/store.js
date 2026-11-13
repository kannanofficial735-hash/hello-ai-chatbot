/**
 * store.js — chat history storage (PLAN §7.5, research §(b))
 *
 * IndexedDB via Dexie.js (vendored UMD build, js/vendor/dexie.min.js —
 * Dexie 4.4.7, Apache-2.0, https://cdn.jsdelivr.net/npm/dexie@4.4.7/dist/dexie.min.js).
 * Database 'hello-ai-chatbot', schema version 1:
 *   chats:    'id, userSub, updatedAt, pinned, createdAt'
 *   messages: 'id, chatId, userSub, createdAt'
 *
 * Rules (non-negotiable):
 *   - History is PII and lives ONLY on this device, in this browser.
 *     Export is a file download, never an upload. No cross-device sync.
 *   - History is per Google account, keyed by Google `sub` from the stored
 *     profile (localStorage "hello-ai-profile"). Dev profile (no sign-in)
 *     uses sub "dev-local". Signing out hides that account's chats; it
 *     never deletes them (research §(b.5) B-5).
 *   - A chat row is created ONLY on the first user message — never an
 *     empty chat (research §(b.3)).
 *   - Delete is one Dexie transaction: chat + all its messages together.
 *   - Caps: 200 chats / 500 messages per chat; prune oldest UNPINNED
 *     first, never pinned.
 *   - QuotaExceededError is caught and surfaced as a plain message via the
 *     'hello-ai:storage-full' event — never a silent failure.
 *
 * Dexie is loaded lazily (script injection, same-origin 'self', allowed by
 * the CSP in _headers) because index.html is owned by foundation and this
 * module must not edit it. If Dexie cannot load, the store degrades:
 * `store.available` is false and the history UI shows an honest message.
 *
 * Pure helpers (grouping, relative time, export validation, pruning) are
 * dependency-free and unit-tested in js/store.test.js.
 * Works in the browser (attaches to window.HelloAI.store) and in Node
 * (module.exports) so the pure helpers are unit-testable with `node --test`.
 */
'use strict';

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) {
    // Flat in Node so tests can destructure the pure helpers directly
    // (same convention as titles.js): { ...pure, store }.
    module.exports = Object.assign({}, api.pure, { store: api.store });
  }
  root.HelloAI = root.HelloAI || {};
  root.HelloAI.store = api.store;
  // Legacy alias: chat.js used window.HelloAIStore before the namespace
  // existed. New code uses window.HelloAI.store; this stays so older
  // call sites (and chat.js's fallback) keep working.
  root.HelloAIStore = api.store;
  Object.assign(root.HelloAI, api.pure);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  // --- Constants (PLAN §7.5 / research §(b.4)) ------------------------------
  const DB_NAME = 'hello-ai-chatbot';
  const DB_VERSION = 1;
  const MAX_CHATS = 200;
  const MAX_MESSAGES_PER_CHAT = 500;
  const PREVIEW_MAX_CHARS = 120;
  const EXPORT_VERSION = 1;
  const DEXIE_VERSION = '4.4.7';
  const DEXIE_SRC = 'js/vendor/dexie.min.js';
  const PROFILE_KEY = 'hello-ai-profile';
  const DEV_SUB = 'dev-local';
  const QUOTA_MESSAGE = 'Storage full — export or delete old chats to make room.';

  // --- Pure helpers (no DOM, no Dexie — unit-tested) ------------------------

  function oneLine(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  /**
   * Latest-message snippet: first ~120 chars, single line, word-boundary
   * cut + '…' (research §(b.3) / §(c.2) step 5).
   */
  function truncatePreview(text, maxChars) {
    const max = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : PREVIEW_MAX_CHARS;
    const single = oneLine(text);
    if (!single) return '';
    if (single.length <= max) return single;
    let cut = single.slice(0, max);
    const lastSpace = cut.lastIndexOf(' ');
    if (lastSpace > 0) cut = cut.slice(0, lastSpace);
    return cut + '…';
  }

  function startOfDay(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  /**
   * Temporal grouping (PLAN §7.1): Pinned on top, then Today / Yesterday /
   * Last 7 days / Last 30 days. Chats older than 30 days go in "Older" —
   * they must still be reachable, the plan names no bucket for them.
   * Archived chats are excluded unless options.includeArchived is true.
   */
  function groupChats(chats, nowMs, options) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const includeArchived = !!(options && options.includeArchived);
    const groups = { pinned: [], today: [], yesterday: [], last7: [], last30: [], older: [] };
    const todayStart = startOfDay(now);
    const yesterdayStart = todayStart - 24 * 3600_000;
    const weekStart = todayStart - 7 * 24 * 3600_000;
    const monthStart = todayStart - 30 * 24 * 3600_000;
    const sorted = sortChats(chats.slice());
    for (const c of sorted) {
      if (c.archived && !includeArchived) continue;
      if (c.pinned) { groups.pinned.push(c); continue; }
      const t = c.updatedAt || 0;
      if (t >= todayStart) groups.today.push(c);
      else if (t >= yesterdayStart) groups.yesterday.push(c);
      else if (t >= weekStart) groups.last7.push(c);
      else if (t >= monthStart) groups.last30.push(c);
      else groups.older.push(c);
    }
    return groups;
  }

  /**
   * Relative time for a row (PLAN §7.1): "Just now" / "5 min ago" /
   * "2 h ago" / "Yesterday" / "3 d ago" / "12 Nov 2026".
   */
  function relativeTime(ts, nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const t = Number(ts);
    if (!Number.isFinite(t) || t > now) return 'Just now';
    const diff = now - t;
    if (diff < 60_000) return 'Just now';
    if (diff < 3600_000) {
      const m = Math.floor(diff / 60_000);
      return m === 1 ? '1 min ago' : m + ' min ago';
    }
    if (startOfDay(t) === startOfDay(now)) {
      const h = Math.floor(diff / 3600_000);
      return h === 1 ? '1 h ago' : h + ' h ago';
    }
    if (startOfDay(t) === startOfDay(now) - 24 * 3600_000) return 'Yesterday';
    if (diff < 7 * 24 * 3600_000) {
      const d = Math.floor(diff / (24 * 3600_000));
      return d === 1 ? '1 d ago' : d + ' d ago';
    }
    return new Date(t).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }

  /**
   * List sort: pinned first (most recently pinned on top), then by
   * updatedAt desc (research §(b.3)).
   */
  function sortChats(chats) {
    return chats.slice().sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      if (a.pinned && b.pinned) return (b.pinnedAt || 0) - (a.pinnedAt || 0);
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
  }

  /**
   * Which chat ids to prune so the list fits `maxChats`: oldest unpinned
   * first. Pinned chats are NEVER pruned — if everything is pinned, the
   * list is allowed to exceed the cap rather than delete a pinned chat.
   */
  function pickChatsToPrune(chats, maxChats) {
    const max = Number.isFinite(maxChats) && maxChats > 0 ? maxChats : MAX_CHATS;
    const excess = chats.length - max;
    if (excess <= 0) return [];
    const unpinned = chats
      .filter((c) => !c.pinned)
      .slice()
      .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    return unpinned.slice(0, excess).map((c) => c.id);
  }

  function isQuotaError(err) {
    if (!err || typeof err !== 'object') return false;
    return err.name === 'QuotaExceededError' || err.code === 22;
  }

  function matchesQuery(chat, query) {
    const q = oneLine(query).toLowerCase();
    if (!q) return true;
    const hay = ((chat.title || '') + ' ' + (chat.preview || '')).toLowerCase();
    return hay.includes(q);
  }

  // --- Export / import (pure shape + serialisation) -------------------------

  function buildExportPayload(chats, messages, userSub, exportedAt) {
    return {
      version: EXPORT_VERSION,
      exportedAt: Number.isFinite(exportedAt) ? exportedAt : Date.now(),
      userSub: userSub || '',
      chats: Array.isArray(chats) ? chats : [],
      messages: Array.isArray(messages) ? messages : [],
    };
  }

  /**
   * Validate an imported file BEFORE anything is deleted (research §(b.4)):
   * versioned envelope, chats/messages arrays, every row with a string id,
   * every message with a chatId. Returns { ok: true } or { ok: false, error }.
   */
  function validateExportData(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, error: 'That file is not a Hello AI history export.' };
    }
    if (data.version !== EXPORT_VERSION) {
      return { ok: false, error: 'Unsupported export version: ' + String(data.version) + '.' };
    }
    if (!Array.isArray(data.chats) || !Array.isArray(data.messages)) {
      return { ok: false, error: 'Export is missing its chats or messages.' };
    }
    for (const c of data.chats) {
      if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !c.id) {
        return { ok: false, error: 'Export has a chat without an id.' };
      }
    }
    for (const m of data.messages) {
      if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id ||
          typeof m.chatId !== 'string' || !m.chatId) {
        return { ok: false, error: 'Export has a message without an id or chat.' };
      }
    }
    return { ok: true };
  }

  /**
   * Single chat as Markdown (human-readable download, research §(b.4)).
   * Plain string building only — the caller renders/downloads it, never
   * injects it as HTML.
   */
  function chatToMarkdown(chat, messages) {
    const lines = [];
    lines.push('# ' + (chat.title || 'Untitled chat'));
    lines.push('');
    const created = new Date(chat.createdAt || Date.now()).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
    });
    lines.push('*Created ' + created + ' · ' + (chat.messageCount || messages.length) +
      ' messages · Dolphin · Live*');
    lines.push('');
    for (const m of messages) {
      const who = m.role === 'user' ? 'You' : m.role === 'assistant' ? 'Hello AI' : m.role;
      lines.push('**' + who + ':** ' + (m.content || ''));
      lines.push('');
    }
    lines.push('---');
    lines.push('*Exported from Hello AI. Chats are stored only on this device.*');
    return lines.join('\n');
  }

  // --- Browser-only store (Dexie) -------------------------------------------
  // Everything below needs `document` / Dexie and is skipped in Node.

  const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

  let db = null; // Dexie instance, once opened
  let dbPromise = null; // in-flight open promise (single-flight)
  let quotaNotifiedAt = 0; // throttle the storage-full event

  function emitQuotaError(err) {
    const now = Date.now();
    if (now - quotaNotifiedAt < 5000) return; // one notice per 5 s at most
    quotaNotifiedAt = now;
    if (isBrowser && typeof document.dispatchEvent === 'function') {
      document.dispatchEvent(new CustomEvent('hello-ai:storage-full', {
        detail: { message: QUOTA_MESSAGE, error: String((err && err.name) || err || '') },
      }));
    }
  }

  /** Wrap a Dexie write so QuotaExceededError becomes a plain, surfaced message. */
  async function guarded(fn) {
    try {
      return await fn();
    } catch (err) {
      if (isQuotaError(err)) emitQuotaError(err);
      throw err;
    }
  }

  /** Current account key: Google `sub` from the stored profile; dev profile falls back to "dev-local". */
  function getUserSub() {
    try {
      const raw = root.localStorage && root.localStorage.getItem(PROFILE_KEY);
      const profile = raw ? JSON.parse(raw) : null;
      return (profile && profile.sub) || DEV_SUB;
    } catch (_e) {
      return DEV_SUB;
    }
  }

  function uuid() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  /** Inject the vendored Dexie UMD script (same-origin, CSP 'self'). Single-flight. */
  function loadDexie() {
    if (!isBrowser) return Promise.reject(new Error('Dexie needs a browser.'));
    if (root.Dexie) return Promise.resolve(root.Dexie);
    if (loadDexie._promise) return loadDexie._promise;
    loadDexie._promise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = DEXIE_SRC;
      script.async = true;
      script.onload = () => {
        if (root.Dexie) resolve(root.Dexie);
        else reject(new Error('Dexie script loaded but window.Dexie is missing.'));
      };
      script.onerror = () => reject(new Error('Could not load ' + DEXIE_SRC + '.'));
      document.head.appendChild(script);
    });
    return loadDexie._promise;
  }

  async function openDb() {
    if (db) return db;
    if (dbPromise) return dbPromise;
    dbPromise = (async () => {
      const Dexie = await loadDexie();
      const instance = new Dexie(DB_NAME);
      instance.version(DB_VERSION).stores({
        chats: 'id, userSub, updatedAt, pinned, createdAt',
        messages: 'id, chatId, userSub, createdAt',
      });
      await instance.open();
      db = instance;
      return db;
    })();
    try {
      return await dbPromise;
    } catch (err) {
      dbPromise = null; // allow a later retry (e.g. after the user frees space)
      throw err;
    }
  }

  /** Ask the browser to keep this origin's storage (research §(b.4)). Best-effort, never blocks. */
  function requestPersistence() {
    if (!isBrowser || !navigator.storage || typeof navigator.storage.persist !== 'function') {
      return Promise.resolve(false);
    }
    return navigator.storage.persist().catch(() => false);
  }

  async function getStorageEstimate() {
    if (!isBrowser || !navigator.storage || typeof navigator.storage.estimate !== 'function') {
      return null;
    }
    try {
      const est = await navigator.storage.estimate();
      return { usage: est.usage || 0, quota: est.quota || 0 };
    } catch (_e) {
      return null;
    }
  }

  // --- Store API (all async; all scoped to the current userSub) -------------

  const store = {
    DB_NAME,
    DB_VERSION,
    MAX_CHATS,
    MAX_MESSAGES_PER_CHAT,
    EXPORT_VERSION,
    DEXIE_VERSION,
    DEXIE_SRC,
    QUOTA_MESSAGE,
    available: false,
    ready: null,

    getUserSub,

    async ensureReady() {
      if (!store.ready) {
        store.ready = openDb()
          .then(() => { store.available = true; return true; })
          .catch((err) => { store.available = false; store.ready = null; throw err; });
      }
      return store.ready;
    },

    /** A chat row is created ONLY on the first user message — never empty (research §(b.3)). */
    async createChat(options) {
      const database = await openDb();
      const opts = options || {};
      const now = Date.now();
      const firstMessage = typeof opts.firstMessage === 'string' ? opts.firstMessage : '';
      const chat = {
        // The caller may supply the id (chat.js passes its draft id so the
        // in-memory chat and the stored row stay the same record); otherwise
        // a fresh uuid is generated. A supplied id must be a non-empty string.
        id: typeof opts.id === 'string' && opts.id ? opts.id : uuid(),
        userSub: getUserSub(),
        title: typeof opts.title === 'string' && opts.title ? opts.title : 'New chat',
        titleSource: opts.titleSource || 'truncated',
        titleManual: !!opts.titleManual,
        preview: truncatePreview(
          typeof opts.preview === 'string' ? opts.preview : firstMessage
        ),
        previewAt: now,
        previewRole: opts.previewRole || 'user',
        messageCount: 0,
        pinned: false,
        pinnedAt: null,
        archived: false,
        createdAt: now,
        updatedAt: now,
      };
      await guarded(() => database.transaction('rw', database.chats, database.messages, async () => {
        await database.chats.add(chat);
        // Enforce the 200-chat cap: prune oldest unpinned first, never pinned.
        const all = await database.chats.where('userSub').equals(chat.userSub).toArray();
        const doomed = pickChatsToPrune(all, MAX_CHATS);
        if (doomed.length) {
          await database.chats.bulkDelete(doomed);
          await database.messages.where('chatId').anyOf(doomed).delete();
        }
      }));
      return chat;
    },

    async getChat(chatId) {
      const database = await openDb();
      const found = await database.chats.get(chatId);
      return found && found.userSub === getUserSub() ? found : null;
    },

    /**
     * Generic patch. Defence in depth for titles: a patch that sets a new
     * title is ignored when the chat was manually renamed, unless the patch
     * itself is the rename (titleSource 'manual'). Callers must still check
     * titleManual before applying an AI title (see build-notes/titles.md).
     */
    async updateChat(chatId, patch) {
      const database = await openDb();
      const existing = await database.chats.get(chatId);
      if (!existing || existing.userSub !== getUserSub()) return null;
      const safe = Object.assign({}, patch);
      delete safe.id;
      delete safe.userSub;
      delete safe.createdAt;
      if (typeof safe.title === 'string' && existing.titleManual &&
          safe.titleSource !== 'manual') {
        delete safe.title;
        delete safe.titleSource;
      }
      if (typeof safe.title === 'string') safe.title = oneLine(safe.title) || existing.title;
      await guarded(() => database.chats.update(chatId, safe));
      return database.chats.get(chatId);
    },

    /** Insert a message and update the chat's denormalised preview/count in the SAME transaction. */
    async addMessage(chatId, role, content, options) {
      const database = await openDb();
      const opts = options || {};
      const now = Date.now();
      const message = {
        id: uuid(),
        chatId,
        userSub: getUserSub(),
        role: role || 'user',
        content: typeof content === 'string' ? content : '',
        createdAt: now,
        model: opts.model || 'dolphin-2.9.3-llama-3-8b',
        latencyMs: Number.isFinite(opts.latencyMs) ? opts.latencyMs : null,
        error: opts.error || null,
      };
      await guarded(() => database.transaction('rw', database.chats, database.messages, async () => {
        const chat = await database.chats.get(chatId);
        if (!chat || chat.userSub !== getUserSub()) {
          throw new Error('Chat not found for this account.');
        }
        await database.messages.add(message);
        // 500-message cap per chat: prune the oldest messages in THIS chat.
        const count = await database.messages.where('chatId').equals(chatId).count();
        if (count > MAX_MESSAGES_PER_CHAT) {
          const oldest = await database.messages.where('chatId').equals(chatId)
            .sortBy('createdAt');
          const extra = oldest.slice(0, count - MAX_MESSAGES_PER_CHAT);
          await database.messages.bulkDelete(extra.map((m) => m.id));
        }
        const freshCount = await database.messages.where('chatId').equals(chatId).count();
        await database.chats.update(chatId, {
          preview: truncatePreview(message.content),
          previewAt: now,
          previewRole: message.role,
          messageCount: freshCount,
          updatedAt: now,
        });
      }));
      return message;
    },

    async getMessages(chatId) {
      const database = await openDb();
      const rows = await database.messages.where('chatId').equals(chatId).sortBy('createdAt');
      return rows.filter((m) => m.userSub === getUserSub());
    },

    async listChats(options) {
      const database = await openDb();
      const rows = await database.chats.where('userSub').equals(getUserSub()).toArray();
      const includeArchived = !!(options && options.includeArchived);
      return sortChats(includeArchived ? rows : rows.filter((c) => !c.archived));
    },

    /**
     * Chats created on one calendar day (local time), for the panel's
     * "Today's recap" (PLAN §8.2). Accepts a Date, a timestamp, or a
     * date string; returns [] (never null) so callers can check .length.
     * Async (Dexie) — panel.js awaits it via Promise.resolve().
     */
    async getChatsForDate(date) {
      const target = startOfDay(date instanceof Date ? date.getTime()
        : typeof date === 'number' ? date
        : Date.parse(date));
      if (!Number.isFinite(target)) return [];
      const all = await store.listChats({ includeArchived: false });
      return all.filter((c) => startOfDay(c.createdAt) === target);
    },

    async setPinned(chatId, pinned) {
      const database = await openDb();
      const now = Date.now();
      await guarded(() => database.chats.update(chatId, {
        pinned: !!pinned,
        pinnedAt: pinned ? now : null,
      }));
      return database.chats.get(chatId);
    },

    /** Rename sets titleManual: true + titleSource 'manual' — auto-titles never overwrite it again. */
    async renameChat(chatId, title) {
      return store.updateChat(chatId, {
        title: oneLine(title),
        titleManual: true,
        titleSource: 'manual',
      });
    },

    async setArchived(chatId, archived) {
      return store.updateChat(chatId, { archived: !!archived });
    },

    /** Delete is ONE transaction: the chat row AND all its messages together. */
    async deleteChat(chatId) {
      const database = await openDb();
      await guarded(() => database.transaction('rw', database.chats, database.messages, async () => {
        await database.messages.where('chatId').equals(chatId).delete();
        await database.chats.delete(chatId);
      }));
    },

    /** Duplicate: a new chat with the same messages (new ids, "(copy)" title, now). */
    async duplicateChat(chatId) {
      const database = await openDb();
      const source = await database.chats.get(chatId);
      if (!source || source.userSub !== getUserSub()) return null;
      const messages = await database.messages.where('chatId').equals(chatId).sortBy('createdAt');
      const now = Date.now();
      const copy = Object.assign({}, source, {
        id: uuid(),
        title: source.title + ' (copy)',
        titleManual: true,
        titleSource: 'manual',
        pinned: false,
        pinnedAt: null,
        archived: false,
        createdAt: now,
        updatedAt: now,
      });
      await guarded(() => database.transaction('rw', database.chats, database.messages, async () => {
        await database.chats.add(copy);
        if (messages.length) {
          await database.messages.bulkAdd(messages.map((m) => Object.assign({}, m, {
            id: uuid(),
            chatId: copy.id,
            createdAt: m.createdAt,
          })));
        }
      }));
      return copy;
    },

    // --- Export / import (download-only, never upload) ----------------------

    async exportAll() {
      const database = await openDb();
      const userSub = getUserSub();
      const chats = await database.chats.where('userSub').equals(userSub).toArray();
      const messages = await database.messages.where('userSub').equals(userSub).toArray();
      return buildExportPayload(chats, messages, userSub, Date.now());
    },

    /**
     * Import a validated export. Mode 'replace' deletes this account's
     * existing history first; 'merge' inserts only ids not already present
     * (on collision the existing row is kept). Validation happens BEFORE
     * anything is deleted. Returns { importedChats, importedMessages }.
     */
    async importData(data, mode) {
      const check = validateExportData(data);
      if (!check.ok) throw new Error(check.error);
      const database = await openDb();
      const userSub = getUserSub();
      const replace = mode === 'replace';
      const chats = data.chats.filter((c) => !c.userSub || c.userSub === userSub);
      const messages = data.messages.filter((m) => !m.userSub || m.userSub === userSub);
      let importedChats = 0;
      let importedMessages = 0;
      await guarded(() => database.transaction('rw', database.chats, database.messages, async () => {
        if (replace) {
          await database.messages.where('userSub').equals(userSub).delete();
          await database.chats.where('userSub').equals(userSub).delete();
          await database.chats.bulkAdd(chats);
          await database.messages.bulkAdd(messages);
          importedChats = chats.length;
          importedMessages = messages.length;
        } else {
          for (const c of chats) {
            const exists = await database.chats.get(c.id);
            if (!exists) { await database.chats.add(c); importedChats++; }
          }
          for (const m of messages) {
            const exists = await database.messages.get(m.id);
            if (!exists) { await database.messages.add(m); importedMessages++; }
          }
        }
      }));
      return { importedChats, importedMessages };
    },

    /** Single chat as a { filename, mime, text } download payload (JSON or Markdown). */
    async exportChat(chatId, format) {
      const database = await openDb();
      const chat = await database.chats.get(chatId);
      if (!chat || chat.userSub !== getUserSub()) return null;
      const messages = await store.getMessages(chatId);
      const stamp = new Date().toISOString().slice(0, 10);
      if (format === 'md' || format === 'markdown') {
        return {
          filename: 'hello-ai-chat-' + stamp + '.md',
          mime: 'text/markdown',
          text: chatToMarkdown(chat, messages),
        };
      }
      return {
        filename: 'hello-ai-chat-' + stamp + '.json',
        mime: 'application/json',
        text: JSON.stringify(buildExportPayload([chat], messages, chat.userSub, Date.now()), null, 2),
      };
    },

    /** Download a text payload as a file (export is download-only, never upload). */
    downloadFile(filename, mime, text) {
      if (!isBrowser) return false;
      const blob = new Blob([text], { type: mime || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    },

    /** Delete ALL of this account's history (Settings "clear data"). No undo — callers must confirm + offer export first. */
    async clearAllForAccount() {
      const database = await openDb();
      const userSub = getUserSub();
      await guarded(() => database.transaction('rw', database.chats, database.messages, async () => {
        await database.messages.where('userSub').equals(userSub).delete();
        await database.chats.where('userSub').equals(userSub).delete();
      }));
    },

    getStorageEstimate,
    requestPersistence,
  };

  // Pure helpers are also reachable as store.relativeTime etc. so callers
  // (history-ui.js) need only one handle: window.HelloAI.store.
  Object.assign(store, {
    relativeTime,
    truncatePreview,
    groupChats,
    sortChats,
    pickChatsToPrune,
    validateExportData,
    buildExportPayload,
    chatToMarkdown,
    isQuotaError,
    matchesQuery,
  });

  // Best-effort: warm the DB + request persistent storage in the browser.
  // Failures are silent here — the store reports available:false and the
  // history UI shows the honest state instead of breaking the app.
  if (isBrowser) {
    store.ready = openDb()
      .then(() => { store.available = true; return true; })
      .catch(() => { store.available = false; store.ready = null; return false; });
    requestPersistence();
  }

  return {
    store,
    pure: {
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
      PREVIEW_MAX_CHARS,
      EXPORT_VERSION,
      DEXIE_VERSION,
      DEXIE_SRC,
    },
  };
});
