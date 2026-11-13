/* ==========================================================================
   Hello AI — config.js
   Single source of truth for frontend configuration. No secrets here.
   ========================================================================== */

window.HELLO_AI_CONFIG = {
  // Live backend: Dolphin Llama 3 8B in Google Colab behind ngrok.
  // NOTE: this URL stays hard-coded here on purpose. There is no build
  // pipeline for this static site, so no Netlify env var can be injected
  // at build time; the URL is already public in repo history, and the
  // backend is open (PLAN §13 E-2, accepted for now). Do NOT add tokens,
  // API keys, or client secrets to this file.
  backendUrl: "https://precision-clause-outthink.ngrok-free.dev",

  // Google OAuth Client ID (Web application) for hello-ai-chatbot.netlify.app.
  // BLOCKED on Aadidev (PLAN §4.3 / A-1): only he can create it in his
  // Google Cloud account. Empty until he pastes the Client ID string.
  // Never a client secret or password — there is none in this flow.
  clientId: "",

  // Dev-only flag: while clientId is empty, the login screen offers a
  // clearly-labelled "Dev: skip login" button (see js/app.js). The real
  // Google sign-in cannot ship until clientId is provided. Set false
  // (and remove the dev button) once the Client ID lands.
  devSkipLogin: true,

  // Behaviour constants carried over from the current live site.
  healthCheckIntervalMs: 60000, // /health check on load + every 60 s
  chatTimeoutMs: 240000,        // 240 s chat timeout (PLAN §1.2)
  offlineMessage:
    "Backend offline — Live AI is starting, please wait a moment and try again."
};
