"""
hello-ai-chatbot — real backend API (Flask + Qwen2.5-0.5B-Instruct)
====================================================================
Replaces the in-browser flan-t5-small (80M) Transformers.js chatbot,
which was too weak / repetitive for complex questions.

Model (already proven in Colab on CPU by Aadidev, 2026-11-09):
    Qwen/Qwen2.5-0.5B-Instruct — 494M params, ~988 MB in float32,
    loaded in ~25.9 s on Colab CPU, answered 3 test questions clearly.

Endpoints
---------
GET  /            -> service info
GET  /api/health  -> {"status": "ok"|"degraded", "model_loaded": bool, ...}
POST /api/chat    -> {"reply": str, "model": str, "source": "qwen"|"fallback"}

Run locally
-----------
    pip install -r requirements.txt
    python app.py            # http://127.0.0.1:5000

Production (Docker / hosting)
-----------------------------
    gunicorn --bind 0.0.0.0:$PORT --workers 1 --threads 2 --timeout 300 app:app
    One worker only: the model is ~1 GB in RAM; more workers = more copies.

Notes / limits
--------------
* No API keys, tokens or phone numbers are used or needed here.
  The model is downloaded from Hugging Face on first start
  (public model, no sign-in required for download).
* CPU inference is slow: expect roughly a few tokens/second and
  10-60 s for a full answer on a free 2-vCPU host. The first request
  after a cold start also pays the ~26-60 s model-load cost.
* If the model cannot load (no RAM / no network / download fails),
  the API does NOT crash: /api/health reports degraded and /api/chat
  returns a graceful fallback reply so the frontend still works.
"""

import os
import threading
import time

from flask import Flask, jsonify, request
from flask_cors import CORS

MODEL_NAME = os.environ.get("MODEL_NAME", "Qwen/Qwen2.5-0.5B-Instruct")
PORT = int(os.environ.get("PORT", "5000"))
MAX_NEW_TOKENS = int(os.environ.get("MAX_NEW_TOKENS", "256"))
# Keep this low on free CPU hosts: long answers are slow and RAM-heavy.

app = Flask(__name__)
# The Netlify frontend (https://hello-ai-chatbot.netlify.app/) calls this
# cross-origin, so CORS must be open for it. Restrict origins in
# production if the frontend gets a fixed domain, e.g.
# CORS(app, origins=["https://hello-ai-chatbot.netlify.app"])
CORS(app)

# --- Model state (loaded lazily, once, in a background thread) --------
_tokenizer = None
_model = None
_model_error = None
_model_loading = False
_model_loaded_at = None
_lock = threading.Lock()
_started_at = time.time()


def _load_model():
    """Load Qwen2.5-0.5B-Instruct on CPU. Runs once, in a thread."""
    global _tokenizer, _model, _model_error, _model_loading, _model_loaded_at
    if _model is not None or _model_loading:
        return
    _model_loading = True
    try:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        print(f"[model] loading {MODEL_NAME} ...", flush=True)
        _tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
        _model = AutoModelForCausalLM.from_pretrained(
            MODEL_NAME,
            torch_dtype=torch.float32,  # CPU: float32 is the safe default
            device_map="cpu",
        )
        _model.eval()
        _model_loaded_at = time.time()
        print(
            f"[model] loaded in {_model_loaded_at - _started_at:.1f}s",
            flush=True,
        )
    except Exception as exc:  # noqa: BLE001 - keep the API alive on failure
        _model_error = f"{type(exc).__name__}: {exc}"
        print(f"[model] FAILED to load: {_model_error}", flush=True)
    finally:
        _model_loading = False


def _ensure_model_loading():
    """Start the background load on first request (so /health stays fast)."""
    if _model is None and not _model_loading and _model_error is None:
        threading.Thread(target=_load_model, daemon=True).start()


def _fallback_reply(message: str) -> str:
    """Graceful fallback when the model is not available yet / failed.

    This is NOT pretending to be the model: the response flags itself
    as a fallback (see "source": "fallback" in the JSON), and the
    frontend should show that too.
    """
    if _model_loading:
        return (
            "The AI model is still loading (it takes about 30-60 seconds "
            "on the first start). Please wait a moment and ask again."
        )
    if _model_error:
        return (
            "Sorry — the AI model could not start on the server right now, "
            "so I can only give a short built-in answer. "
            "Please try again later. "
            f"(Server note: {_model_error})"
        )
    return "Sorry, the AI model is not ready yet. Please try again in a moment."


def _qwen_reply(message: str, history: list | None) -> str:
    """Generate one reply with Qwen2.5-0.5B-Instruct + its chat template."""
    import torch

    messages = []
    for turn in (history or [])[-6:]:  # last 3 exchanges only: saves RAM/time
        role = turn.get("role") if isinstance(turn, dict) else None
        content = turn.get("content") if isinstance(turn, dict) else None
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": str(content)[:2000]})
    messages.append({"role": "user", "content": message})

    # Qwen's own chat template: this is what makes it behave as a
    # chatbot instead of continuing text like a base model.
    prompt = _tokenizer.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True
    )
    inputs = _tokenizer(prompt, return_tensors="pt")

    with _lock:  # one generation at a time on a small CPU host
        with torch.no_grad():
            outputs = _model.generate(
                **inputs,
                max_new_tokens=MAX_NEW_TOKENS,
                do_sample=True,
                temperature=0.7,
                top_p=0.9,
                pad_token_id=_tokenizer.eos_token_id,
            )
    # Decode only the newly generated tokens, not the prompt.
    new_tokens = outputs[0][inputs["input_ids"].shape[1]:]
    reply = _tokenizer.decode(new_tokens, skip_special_tokens=True).strip()
    return reply or "Sorry, I could not generate an answer. Please try again."


# --- Routes ------------------------------------------------------------

@app.get("/")
def index():
    return jsonify(
        {
            "service": "hello-ai-chatbot backend",
            "model": MODEL_NAME,
            "model_loaded": _model is not None,
            "endpoints": ["GET /api/health", "POST /api/chat"],
        }
    )


@app.get("/api/health")
def health():
    _ensure_model_loading()
    status = "ok" if _model is not None else "degraded"
    return jsonify(
        {
            "status": status,
            "model": MODEL_NAME,
            "model_loaded": _model is not None,
            "model_loading": _model_loading,
            "model_error": _model_error,
            "uptime_seconds": round(time.time() - _started_at, 1),
        }
    ), (200 if _model is not None else 200)  # 200 either way: the API is up


@app.post("/api/chat")
def chat():
    _ensure_model_loading()
    data = request.get_json(silent=True) or {}
    message = str(data.get("message") or "").strip()
    if not message:
        return jsonify({"error": "Send JSON like {\"message\": \"Hello\"}"}), 400
    if len(message) > 4000:
        return jsonify({"error": "Message too long (max 4000 characters)."}), 400

    history = data.get("history") if isinstance(data.get("history"), list) else []

    if _model is None or _tokenizer is None:
        return jsonify(
            {
                "reply": _fallback_reply(message),
                "model": MODEL_NAME,
                "source": "fallback",
                "model_loaded": False,
            }
        )

    try:
        reply = _qwen_reply(message, history)
    except Exception as exc:  # noqa: BLE001 - never 500 on a generation error
        print(f"[chat] generation failed: {exc}", flush=True)
        return jsonify(
            {
                "reply": "Sorry, something went wrong while generating the "
                         "answer. Please try again with a shorter question.",
                "model": MODEL_NAME,
                "source": "fallback",
                "model_loaded": True,
                "error": str(exc)[:300],
            }
        )

    return jsonify(
        {"reply": reply, "model": MODEL_NAME, "source": "qwen", "model_loaded": True}
    )


if __name__ == "__main__":
    _ensure_model_loading()  # start loading immediately when run directly
    app.run(host="0.0.0.0", port=PORT)
