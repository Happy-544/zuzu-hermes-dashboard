"""Authenticated Vapi Custom LLM relay to a separate tool-restricted Hermes profile."""
import json
import os
import secrets
import urllib.error
import urllib.parse
import urllib.request


def ready():
    return all(os.environ.get(name) for name in ("VAPI_LLM_TOKEN", "HERMES_PHONE_API_KEY", "HERMES_PHONE_API_BASE"))


def authorized(header):
    token = os.environ.get("VAPI_LLM_TOKEN", "")
    return bool(token) and secrets.compare_digest(header or "", "Bearer " + token)


def upstream(body):
    if not ready():
        raise RuntimeError("Tool-restricted Hermes phone profile is not configured")
    base = os.environ["HERMES_PHONE_API_BASE"].rstrip("/")
    parsed = urllib.parse.urlparse(base)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"}:
        raise RuntimeError("Phone Hermes API must be on localhost")
    messages = body.get("messages") if isinstance(body, dict) else None
    if not isinstance(messages, list) or not messages:
        raise ValueError("Call messages are missing")
    # Only conversation data is forwarded; Vapi cannot override tools, provider,
    # profile, model, or local approval policy through request fields.
    clean = [{"role": m.get("role"), "content": m.get("content", "")}
             for m in messages if isinstance(m, dict) and m.get("role") in {"system", "user", "assistant"}]
    if not any(m["role"] == "user" for m in clean):
        raise ValueError("No caller message")
    payload = {"model": "hermes-agent", "messages": clean, "stream": bool(body.get("stream", True))}
    req = urllib.request.Request(base + "/v1/chat/completions", data=json.dumps(payload).encode("utf-8"),
        method="POST", headers={"Authorization": "Bearer " + os.environ["HERMES_PHONE_API_KEY"],
                                "Content-Type": "application/json"})
    return urllib.request.urlopen(req, timeout=90)
