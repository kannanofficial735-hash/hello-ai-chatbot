/**
 * Voice mic — Hello AI chatbot redesign (PLAN §6.3, §9.4 A4; anim-04).
 *
 * Lazy-loaded ES module. chat.js / app.js must load it ONLY when the mic is
 * first tapped — never at boot:
 *
 *   // from js/chat.js or js/panel.js (both classic scripts, so the import
 *   // resolves against the DOCUMENT base URL, not this file — hence the
 *   // './js/voice.js' path, not './voice.js'):
 *   const { createVoiceMic } = await import('./js/voice.js');
 *   const voice = createVoiceMic({
 *     micButton: document.getElementById('micBtn'),   // composer mic button
 *     composer: document.getElementById('messageInput'), // composer <textarea>
 *   });
 *
 * UNTESTED ON PHONE: Web Speech API is often stubbed in Android WebView
 * (the APK shell) even when the constructor exists, and fails there with a
 * `network` error. Do NOT report the mic as working until Aadidev has tried
 * it in Chrome on his phone. See also the `app_creation_device_packaging`
 * skill: phone-dependent features stay labelled untested until confirmed
 * on the real phone.
 *
 * Privacy: this module NEVER records audio and NEVER uploads anything.
 * Speech is recognised by the browser's own SpeechRecognition service —
 * in Chrome that means audio is sent to Google's speech service (see the
 * on-screen disclosure "Voice is transcribed by Google"). The parallel
 * AnalyserNode used for the orb/bars level is local only: its samples are
 * read for a volume number, never stored, never sent anywhere. No
 * MediaRecorder, no fetch/upload of audio, no audio in localStorage.
 *
 * Safety: transcript text is written into the composer with `.value` and
 * into the DOM only via `textContent`. This module never uses `innerHTML`
 * with transcript content (or at all). The transcript is EDITABLE in the
 * composer and is NEVER auto-sent — the user reviews, edits, then taps
 * Send themselves.
 */

'use strict';

// ---------------------------------------------------------------------------
// Feature detection + public constants
// ---------------------------------------------------------------------------

const SpeechRecognitionCtor =
  typeof window !== 'undefined'
    ? window.SpeechRecognition || window.webkitSpeechRecognition || null
    : null;

/** False where the API is absent — the mic button must be hidden, never shown dead. */
export const isSupported = Boolean(SpeechRecognitionCtor);

export const DEFAULT_LANGUAGE = 'en-IN';

export const LANGUAGES = [
  { code: 'en-IN', label: 'English (India)' },
  { code: 'ml-IN', label: 'Malayalam' },
  { code: 'en-US', label: 'English (US)' },
];

/** localStorage key for the persisted mic language (small setting only). */
export const LANGUAGE_STORAGE_KEY = 'helloai.voice.lang.v1';

/** Privacy disclosure — must appear once, plainly, near the mic (in the sheet). */
export const PRIVACY_TEXT = 'Voice is transcribed by Google';

/** 10 s with no result and no error: the API exists but never answers. */
export const NO_RESULT_TIMEOUT_MS = 10000;

/** Swipe-to-cancel thresholds (anim-04 §4.7). */
export const SWIPE_CANCEL_MIN_PX = 90;
export const SWIPE_CANCEL_MIN_VELOCITY_PX_PER_MS = 0.6;

/** Auto-dismiss for error states (anim-04 §7). */
export const ERROR_AUTO_DISMISS_MS = {
  'no-speech': 6000,
  network: 8000,
  'not-allowed': 8000,
  'audio-capture': 8000,
  'language-not-supported': 8000,
  'service-not-allowed': 8000,
  aborted: 6000,
  timeout: 6000,
};

/**
 * Error code -> one plain sentence. Shown in the listening sheet and
 * announced via role="alert". `not-allowed` deliberately gets NO shake
 * (denial is a user decision, not a system fault — anim-04 §7.1).
 */
export const ERROR_MESSAGES = {
  'no-speech':
    "Didn't catch that — try speaking a little louder, or tap to type instead.",
  aborted: 'Listening stopped — tap the mic to try again.',
  'audio-capture':
    'No microphone was found — check your device mic, or just type instead.',
  'not-allowed':
    "Microphone is off — allow mic access in your browser settings to use voice, or just type instead.",
  network: 'Voice needs internet — check your connection and try again.',
  'language-not-supported':
    "That language isn't supported for voice here — try English (India) instead.",
  'service-not-allowed':
    "Voice isn't available on this device right now — try typing instead.",
};

/** Shown by the 10 s no-result timeout fallback. */
export const TIMEOUT_MESSAGE = "Didn't catch that — try typing";

/** Waveform bar gains, centre tallest (anim-04 §4.4). */
export const BAR_GAINS = [0.55, 0.8, 1.0, 0.8, 0.55];

/** Orb scale range driven by level: 1 + level * 0.12, clamped 1.00–1.12. */
const ORB_SCALE_MIN = 1.0;
const ORB_SCALE_MAX = 1.12;
const ORB_LEVEL_GAIN = 0.12;

/** Level smoothing (lerp factor) at ~30 Hz (every other rAF frame). */
const LEVEL_LERP_ORB = 0.25;
const LEVEL_LERP_BARS = 0.3;

/** Reduced-motion: stepped level driver, at most one update per 500 ms. */
const REDUCED_MOTION_LEVEL_STEP_MS = 500;

// ---------------------------------------------------------------------------
// Small DOM helpers (no innerHTML anywhere in this module)
// ---------------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function svgEl(tag, attrs) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  }
  return node;
}

/** Inline mic glyph (Lucide-style line icon; never emoji as an icon). */
function micIcon() {
  const svg = svgEl('svg', {
    viewBox: '0 0 24 24',
    width: '20',
    height: '20',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  });
  svg.appendChild(svgEl('path', { d: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z' }));
  svg.appendChild(svgEl('path', { d: 'M19 10v2a7 7 0 0 1-14 0v-2' }));
  svg.appendChild(svgEl('path', { d: 'M12 19v3' }));
  return svg;
}

function loadStoredLanguage() {
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (stored && LANGUAGES.some((entry) => entry.code === stored)) return stored;
  } catch (_error) {
    // Storage unavailable (private mode, etc.) — fall back to the default.
  }
  return DEFAULT_LANGUAGE;
}

function storeLanguage(code) {
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, code);
  } catch (_error) {
    // Non-fatal: the language just won't persist.
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Wire the voice mic.
 *
 * @param {object} options
 * @param {HTMLElement} options.micButton - the composer mic button (#micBtn).
 *   Hidden automatically when SpeechRecognition is unsupported.
 * @param {HTMLTextAreaElement} options.composer - the composer field
 *   (#messageInput). Interim/final transcript is written here; it stays
 *   editable and is never auto-sent.
 * @param {string} [options.language] - initial BCP 47 tag; defaults to the
 *   stored choice, else 'en-IN'.
 * @param {function} [options.onStateChange] - called with ('idle'|'listening'|'error').
 * @param {function} [options.onError] - called with (code, message).
 * @returns {{ isSupported: boolean, getState, isListening, start, stop,
 *   cancel, setLanguage, getLanguage, destroy }}
 */
export function createVoiceMic(options = {}) {
  const micButton = options.micButton || document.getElementById('micBtn');
  const composer = options.composer || document.getElementById('messageInput');
  const onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : null;
  const onError = typeof options.onError === 'function' ? options.onError : null;

  const reducedMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // -- state ---------------------------------------------------------------
  let state = 'idle'; // 'idle' | 'listening' | 'error'
  let language = options.language || loadStoredLanguage();
  let recognition = null;
  let userCancelled = false;
  let hadResult = false;
  let noResultTimer = null;
  let dismissTimer = null;
  let dismissAt = 0;
  let dismissMs = 0;
  let lastErrorCode = null;

  // Transcript bookkeeping. `prefix` is whatever the user had typed before
  // this listen started; voice words are appended after it and stay editable.
  let prefix = '';
  let finalText = '';
  let interimText = '';

  // Level (AnalyserNode) bookkeeping.
  let audioContext = null;
  let analyser = null;
  let mediaStream = null;
  let levelRafId = 0;
  let levelFrameParity = 0;
  let levelCurrent = 0;
  let lastLevelStepAt = 0;

  // Sheet DOM (built lazily on first start so unsupported browsers pay nothing).
  let sheet = null;
  let orb = null;
  let orbWrap = null;
  let bars = [];
  let statusText = null;
  let errorText = null;
  let cancelHint = null;
  let stopButton = null;
  let cancelButton = null;
  let retryButton = null;
  let languageSelect = null;
  let previouslyFocused = null;

  // Swipe-to-cancel bookkeeping.
  let swipe = null; // { pointerId, startX, startTime, dx } | null

  // -- stylesheet ----------------------------------------------------------
  // Lazy CSS to match the lazy JS: one dynamic import() brings both. If the
  // shell already links css/voice.css statically, this is a no-op.
  function ensureVoiceCss() {
    if (document.querySelector('link[data-voice-css]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'css/voice.css';
    link.setAttribute('data-voice-css', '');
    document.head.appendChild(link);
  }

  // -- sheet construction (textContent only, never innerHTML) --------------
  function buildSheet() {
    sheet = el('div', 'voice-sheet');
    sheet.hidden = true;
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', 'Voice input');
    sheet.setAttribute('aria-modal', 'false');

    const inner = el('div', 'voice-sheet__inner');

    orbWrap = el('div', 'voice-orb-wrap');
    for (let i = 0; i < 3; i++) {
      orbWrap.appendChild(el('span', 'voice-ring', ''));
    }
    orb = el('button', 'voice-orb');
    orb.type = 'button';
    orb.setAttribute('aria-label', 'Stop listening');
    orb.appendChild(el('span', 'voice-orb__glow', ''));
    orb.appendChild(micIcon());
    orbWrap.appendChild(orb);

    const barsWrap = el('div', 'voice-bars');
    barsWrap.setAttribute('aria-hidden', 'true');
    bars = [];
    for (let i = 0; i < 5; i++) {
      const bar = el('span', 'voice-bar', '');
      barsWrap.appendChild(bar);
      bars.push(bar);
    }

    statusText = el('p', 'voice-status', 'Listening…');
    statusText.setAttribute('aria-live', 'polite');

    cancelHint = el('p', 'voice-cancel-hint', 'Release to cancel');
    cancelHint.hidden = true;

    errorText = el('p', 'voice-error', '');
    errorText.hidden = true;
    errorText.setAttribute('role', 'alert');

    const actions = el('div', 'voice-actions');
    stopButton = el('button', 'voice-stop', 'Stop');
    stopButton.type = 'button';
    stopButton.setAttribute('aria-label', 'Stop listening');
    cancelButton = el('button', 'voice-cancel', 'Cancel');
    cancelButton.type = 'button';
    cancelButton.setAttribute('aria-label', 'Cancel voice input and discard transcript');
    retryButton = el('button', 'voice-retry', 'Listen again');
    retryButton.type = 'button';
    retryButton.hidden = true;
    actions.append(stopButton, cancelButton, retryButton);

    const langLabel = el('label', 'voice-lang', 'Language ');
    languageSelect = document.createElement('select');
    languageSelect.setAttribute('aria-label', 'Voice input language');
    for (const entry of LANGUAGES) {
      const option = document.createElement('option');
      option.value = entry.code;
      option.textContent = entry.label;
      languageSelect.appendChild(option);
    }
    languageSelect.value = language;
    langLabel.appendChild(languageSelect);

    // Privacy disclosure: exactly once, plainly, near the mic.
    const privacy = el('p', 'voice-privacy', PRIVACY_TEXT);

    inner.append(orbWrap, barsWrap, statusText, cancelHint, errorText, actions, langLabel, privacy);
    sheet.appendChild(inner);
    document.body.appendChild(sheet);

    orb.addEventListener('click', () => stop());
    stopButton.addEventListener('click', () => stop());
    cancelButton.addEventListener('click', () => cancel());
    retryButton.addEventListener('click', () => {
      hideError();
      start();
    });
    languageSelect.addEventListener('change', () => {
      setLanguage(languageSelect.value);
    });

    sheet.addEventListener('pointerdown', onSheetPointerDown);
    sheet.addEventListener('pointermove', onSheetPointerMove);
    sheet.addEventListener('pointerup', onSheetPointerUp);
    sheet.addEventListener('pointercancel', onSheetPointerUp);
    sheet.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
      }
    });
  }

  // -- state / sheet visibility --------------------------------------------
  function setState(next) {
    state = next;
    if (micButton) {
      micButton.setAttribute('aria-pressed', next === 'listening' ? 'true' : 'false');
      micButton.setAttribute(
        'aria-label',
        next === 'listening' ? 'Stop listening' : 'Start voice input',
      );
      micButton.classList.toggle('voice-mic--listening', next === 'listening');
    }
    if (onStateChange) onStateChange(next);
  }

  function openSheet() {
    if (!sheet) buildSheet();
    ensureVoiceCss();
    previouslyFocused = document.activeElement;
    sheet.hidden = false;
    // Force a reflow so the open transition runs from its start state.
    void sheet.offsetWidth;
    sheet.classList.add('voice-sheet--open');
    sheet.classList.remove('voice-sheet--closing', 'voice-sheet--error');
    if (stopButton) stopButton.focus({ preventScroll: true });
  }

  function closeSheet() {
    if (!sheet || sheet.hidden) return;
    sheet.classList.remove('voice-sheet--open');
    sheet.classList.add('voice-sheet--closing');
    window.setTimeout(() => {
      if (!sheet) return;
      sheet.hidden = true;
      sheet.classList.remove('voice-sheet--closing');
      sheet.style.transform = '';
      sheet.style.opacity = '';
      if (orbWrap) orbWrap.style.transform = '';
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus({ preventScroll: true });
      }
      previouslyFocused = null;
    }, 300);
  }

  // -- transcript -> composer ----------------------------------------------
  // A <textarea> cannot style part of its text, so interim vs final is shown
  // at field level: grey italic while interim words are pending, white roman
  // once they settle (css/voice.css: .voice-composer--interim / --final).
  // The words themselves are always plain editable text in the field.
  function composedValue() {
    return [prefix, finalText, interimText].filter(Boolean).join(' ');
  }

  function writeComposer() {
    if (!composer) return;
    composer.value = composedValue();
    composer.classList.toggle('voice-composer--interim', Boolean(interimText));
    composer.classList.toggle('voice-composer--final', !interimText && Boolean(finalText));
    // Let chat.js notice: auto-grow, send-button visibility, etc.
    composer.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function refreshPrefix() {
    if (!composer) return;
    const current = composer.value;
    const tail = [finalText, interimText].filter(Boolean).join(' ');
    if (tail && current.endsWith(tail)) {
      prefix = current.slice(0, current.length - tail.length).trimEnd();
    } else if (current !== composedValue()) {
      // The user edited the composer mid-listen: keep their edit as the
      // new prefix. (Edge case: editing the voice words themselves and then
      // speaking on can duplicate words — the intended flow is to edit
      // after stopping, when the transcript is final.)
      prefix = current;
    }
  }

  // -- level reactivity (AnalyserNode, local only) --------------------------
  function startLevelLoop() {
    stopLevelLoop();
    if (bars.length > 0 && bars[0].parentElement) {
      bars[0].parentElement.classList.add('voice-bars--live');
    }
    if (!analyser || reducedMotion) {
      if (analyser && reducedMotion) startSteppedLevelLoop();
      return;
    }
    const buffer = new Uint8Array(analyser.fftSize);
    const tick = () => {
      levelRafId = window.requestAnimationFrame(tick);
      levelFrameParity += 1;
      if (levelFrameParity % 2 !== 0) return; // ~30 Hz, not 60 Hz
      analyser.getByteTimeDomainData(buffer);
      let sumSquares = 0;
      for (let i = 0; i < buffer.length; i++) {
        const sample = (buffer[i] - 128) / 128;
        sumSquares += sample * sample;
      }
      const target = Math.min(1, Math.sqrt(sumSquares / buffer.length) * 3);
      levelCurrent += (target - levelCurrent) * LEVEL_LERP_ORB;
      applyLevel(levelCurrent);
    };
    levelRafId = window.requestAnimationFrame(tick);
  }

  // Reduced motion: stepped updates, at most every 500 ms, no smooth pulsing.
  function startSteppedLevelLoop() {
    const step = () => {
      if (!analyser || state !== 'listening') return;
      const buffer = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(buffer);
      let sumSquares = 0;
      for (let i = 0; i < buffer.length; i++) {
        const sample = (buffer[i] - 128) / 128;
        sumSquares += sample * sample;
      }
      const target = Math.min(1, Math.sqrt(sumSquares / buffer.length) * 3);
      levelCurrent = Math.round(target * 20) / 20; // 0.05 steps only
      applyLevel(levelCurrent);
      lastLevelStepAt = Date.now();
      levelRafId = window.setTimeout(step, REDUCED_MOTION_LEVEL_STEP_MS);
    };
    levelRafId = window.setTimeout(step, 0);
  }

  function stopLevelLoop() {
    if (levelRafId) {
      window.cancelAnimationFrame(levelRafId);
      window.clearTimeout(levelRafId);
      levelRafId = 0;
    }
    if (bars.length > 0 && bars[0].parentElement) {
      bars[0].parentElement.classList.remove('voice-bars--live');
    }
    levelCurrent = 0;
    applyLevel(0);
  }

  function applyLevel(level) {
    if (orb) {
      const scale = Math.min(ORB_SCALE_MAX, Math.max(ORB_SCALE_MIN, 1 + level * ORB_LEVEL_GAIN));
      orb.style.setProperty('--mic-level', String(level));
      // Scale via a CSS var (not inline transform) so the orb's :active
      // press rule in voice.css can still win while pressed.
      orb.style.setProperty('--mic-orb-scale', scale.toFixed(3));
    }
    for (let i = 0; i < bars.length; i++) {
      const scaleY = 0.15 + level * BAR_GAINS[i] * 0.85;
      bars[i].style.transform = `scaleY(${scaleY.toFixed(3)})`;
    }
  }

  function startAnalyser() {
    // Best-effort only: SpeechRecognition works without it (bars fall back
    // to the CSS idle sine). Never let a mic-level failure break listening.
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    if (typeof AudioContext === 'undefined' && typeof window.webkitAudioContext === 'undefined') return;
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        if (state !== 'listening') {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        mediaStream = stream;
        const Ctor = window.AudioContext || window.webkitAudioContext;
        audioContext = new Ctor();
        if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
        const source = audioContext.createMediaStreamSource(stream);
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        startLevelLoop();
      })
      .catch(() => {
        // Level reactivity unavailable; CSS idle animation carries the face.
      });
  }

  function stopAnalyser() {
    stopLevelLoop();
    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop());
      mediaStream = null;
    }
    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
    }
    analyser = null;
  }

  // -- errors ---------------------------------------------------------------
  function showError(code, message) {
    lastErrorCode = code;
    const text = message || ERROR_MESSAGES[code] || ERROR_MESSAGES['service-not-allowed'];
    if (errorText) {
      errorText.textContent = text;
      errorText.hidden = false;
    }
    if (statusText) statusText.textContent = 'Voice input paused';
    if (retryButton) retryButton.hidden = false;
    if (cancelButton) cancelButton.hidden = false;
    if (sheet) {
      sheet.classList.add('voice-sheet--error');
      // Permission denied: NO shake (anim-04 §7.1). A shake is used only
      // for a failed retry, never for the denial itself.
      if (code !== 'not-allowed') sheet.classList.add('voice-sheet--shake');
    }
    if (micButton && code === 'not-allowed') {
      // Quiet amber-dot reminder on the mic until the next successful listen.
      micButton.classList.add('voice-mic--denied');
    }
    setState('error');
    if (onError) onError(code, text);
    scheduleErrorDismiss(ERROR_AUTO_DISMISS_MS[code] || 8000);
  }

  function hideError() {
    lastErrorCode = null;
    clearDismissTimer();
    if (errorText) {
      errorText.textContent = '';
      errorText.hidden = true;
    }
    if (retryButton) retryButton.hidden = true;
    if (sheet) sheet.classList.remove('voice-sheet--error', 'voice-sheet--shake');
  }

  function scheduleErrorDismiss(ms) {
    clearDismissTimer();
    dismissMs = ms;
    dismissAt = Date.now() + ms;
    dismissTimer = window.setTimeout(() => {
      dismissTimer = null;
      closeSheet();
      setState('idle');
    }, ms);
  }

  function clearDismissTimer() {
    if (dismissTimer) {
      window.clearTimeout(dismissTimer);
      dismissTimer = null;
    }
  }

  // Auto-dismiss pauses while the user's finger is on the sheet (anim-04
  // §7.5) and resumes on release with 2 s grace.
  function pauseDismiss() {
    if (!dismissTimer) return;
    clearDismissTimer();
    dismissMs = Math.max(0, dismissAt - Date.now());
  }

  function resumeDismiss() {
    if (state !== 'error' || !dismissMs) return;
    dismissAt = Date.now() + dismissMs + 2000;
    dismissTimer = window.setTimeout(() => {
      dismissTimer = null;
      closeSheet();
      setState('idle');
    }, dismissMs + 2000);
  }

  // -- recognition lifecycle -------------------------------------------------
  function clearNoResultTimer() {
    if (noResultTimer) {
      window.clearTimeout(noResultTimer);
      noResultTimer = null;
    }
  }

  function start() {
    if (!isSupported) return false;
    if (state === 'listening') return true;
    if (!micButton && !composer) return false;

    ensureVoiceCss();
    hideError();
    userCancelled = false;
    hadResult = false;
    finalText = '';
    interimText = '';
    prefix = composer ? composer.value.trimEnd() : '';

    recognition = new SpeechRecognitionCtor();
    recognition.lang = language;
    recognition.continuous = false; // tap-to-talk: one utterance per tap
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      hadResult = true;
      clearNoResultTimer();
      let nextInterim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0] && result[0].transcript ? result[0].transcript.trim() : '';
        if (!transcript) continue;
        if (result.isFinal) {
          finalText = finalText ? `${finalText} ${transcript}` : transcript;
        } else {
          nextInterim = transcript;
        }
      }
      interimText = nextInterim;
      refreshPrefix();
      writeComposer();
      if (statusText) statusText.textContent = 'Listening…';
    };

    recognition.onerror = (event) => {
      const code = event && event.error ? event.error : 'service-not-allowed';
      clearNoResultTimer();
      stopAnalyser();
      if (userCancelled && code === 'aborted') return; // intentional cancel: silent
      if (code === 'aborted' && state === 'listening' && !hadResult) {
        showError('aborted');
        return;
      }
      showError(code);
    };

    recognition.onend = () => {
      clearNoResultTimer();
      stopAnalyser();
      if (userCancelled) return; // cancel() already closed the sheet
      if (state === 'error') return; // error sheet stays open until dismissed
      // Normal end: recognition stopped (tap-to-stop, or auto-stop on pause).
      // Final words have already settled in the composer; never auto-send.
      if (finalText && micButton) micButton.classList.remove('voice-mic--denied');
      if (composer) {
        composer.classList.remove('voice-composer--interim');
        composer.classList.toggle('voice-composer--final', Boolean(finalText));
      }
      closeSheet();
      setState('idle');
    };

    try {
      recognition.start();
    } catch (_error) {
      // The sheet must exist before showError() can render into it.
      openSheet();
      showError('service-not-allowed');
      return false;
    }

    openSheet();
    setState('listening');
    if (statusText) statusText.textContent = 'Listening…';
    startAnalyser();

    // Some environments expose the constructor but never fire result/error.
    noResultTimer = window.setTimeout(() => {
      noResultTimer = null;
      if (state !== 'listening' || hadResult) return;
      try {
        if (recognition) recognition.stop();
      } catch (_error) {
        // Already ended; the error state below still applies.
      }
      showError('no-speech', TIMEOUT_MESSAGE);
    }, NO_RESULT_TIMEOUT_MS);

    return true;
  }

  /** Tap-to-stop: keep whatever final transcript exists, close the sheet. */
  function stop() {
    if (state !== 'listening' || !recognition) return;
    try {
      recognition.stop();
    } catch (_error) {
      // onend still fires (or already fired); nothing more to do.
    }
  }

  /** Cancel: abort recognition and DISCARD this session's voice text. */
  function cancel() {
    if (state === 'idle') return;
    userCancelled = true;
    clearNoResultTimer();
    clearDismissTimer();
    hideError();
    try {
      if (recognition) recognition.abort();
    } catch (_error) {
      // Already ended.
    }
    stopAnalyser();
    // Restore the composer to what the user had before this listen.
    if (composer) {
      composer.value = prefix;
      composer.classList.remove('voice-composer--interim', 'voice-composer--final');
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    }
    finalText = '';
    interimText = '';
    closeSheet();
    setState('idle');
  }

  // -- swipe-to-cancel (anim-04 §4.7) ---------------------------------------
  function onSheetPointerDown(event) {
    pauseDismiss();
    if (event.target.closest('button, select, a, input, label')) return;
    try {
      sheet.setPointerCapture(event.pointerId);
    } catch (_error) {
      // Pointer capture unavailable; swipe still tracks while over the sheet.
    }
    swipe = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startTime: performance.now(),
      dx: 0,
    };
  }

  function onSheetPointerMove(event) {
    if (!swipe || event.pointerId !== swipe.pointerId) return;
    swipe.dx = event.clientX - swipe.startX;
    const abs = Math.abs(swipe.dx);
    // Sheet follows the finger 1:1 (transform only); content lags at 0.3x.
    if (sheet) {
      sheet.style.transform = `translateX(${swipe.dx}px)`;
      sheet.style.opacity = String(Math.max(0.55, 1 - abs / 180));
    }
    if (orbWrap) orbWrap.style.transform = `translateX(${swipe.dx * 0.3}px)`;
    if (cancelHint) cancelHint.hidden = abs < 40;
  }

  function onSheetPointerUp(event) {
    resumeDismiss();
    if (!swipe || event.pointerId !== swipe.pointerId) return;
    const dx = swipe.dx;
    const dt = Math.max(1, performance.now() - swipe.startTime);
    const velocity = Math.abs(dx) / dt;
    swipe = null;
    if (sheet) {
      sheet.style.transform = '';
      sheet.style.opacity = '';
    }
    if (orbWrap) orbWrap.style.transform = '';
    if (cancelHint) cancelHint.hidden = true;
    if (Math.abs(dx) >= SWIPE_CANCEL_MIN_PX || velocity >= SWIPE_CANCEL_MIN_VELOCITY_PX_PER_MS) {
      cancel();
    }
    // Below threshold: the sheet simply stays put (CSS transition eases it
    // back; reduced-motion: no spring, it just stays — anim-04 §8).
  }

  // -- public API -------------------------------------------------------------
  function setLanguage(code) {
    if (!LANGUAGES.some((entry) => entry.code === code)) return false;
    language = code;
    storeLanguage(code);
    if (languageSelect) languageSelect.value = code;
    return true;
  }

  function destroy() {
    userCancelled = true;
    clearNoResultTimer();
    clearDismissTimer();
    try {
      if (recognition) recognition.abort();
    } catch (_error) {
      // Already ended.
    }
    stopAnalyser();
    if (sheet) {
      sheet.remove();
      sheet = null;
    }
    if (micButton) {
      micButton.removeEventListener('click', onMicClick);
    }
    setState('idle');
  }

  function onMicClick() {
    if (state === 'listening') stop();
    else if (state === 'error') {
      hideError();
      closeSheet();
      setState('idle');
    } else {
      start();
    }
  }

  // -- wire-up ------------------------------------------------------------------
  if (micButton) {
    if (!isSupported) {
      // Never show a mic that does nothing.
      micButton.hidden = true;
      micButton.setAttribute('aria-hidden', 'true');
    } else {
      micButton.classList.add('voice-mic');
      micButton.setAttribute('aria-label', 'Start voice input');
      micButton.setAttribute('aria-pressed', 'false');
      micButton.addEventListener('click', onMicClick);
    }
  }

  return {
    isSupported,
    getState: () => state,
    isListening: () => state === 'listening',
    start,
    stop,
    cancel,
    setLanguage,
    getLanguage: () => language,
    destroy,
  };
}

export default createVoiceMic;
