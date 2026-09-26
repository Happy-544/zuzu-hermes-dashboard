"""Zuzu's local, authenticated Hermes gateway transport."""
import json
import os
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request


def configured():
    return bool(os.environ.get("HERMES_API_KEY", ""))


def _base():
    base = os.environ.get("HERMES_API_BASE", "http://127.0.0.1:8642").rstrip("/")
    parsed = urllib.parse.urlparse(base)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"}:
        raise RuntimeError("Hermes API must bind to this computer's loopback address")
    return base


def _request(path, body=None, *, timeout=10):
    headers = {"Authorization": "Bearer " + os.environ["HERMES_API_KEY"],
               "Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(_base() + path, data=data, headers=headers,
                                 method="POST" if body is not None else "GET")
    return urllib.request.urlopen(req, timeout=timeout)


def health():
    if not configured():
        return {"connected": False, "pending": False, "detail": "Hermes API key is not configured"}
    try:
        with _request("/v1/models", timeout=3) as response:
            result = json.load(response)
        return {"connected": bool(result.get("data")), "pending": False, "detail": "Hermes API ready"}
    except urllib.error.HTTPError as exc:
        return {"connected": False, "pending": False, "detail": f"Hermes API HTTP {exc.code}"}
    except (OSError, ValueError, RuntimeError) as exc:
        return {"connected": False, "pending": False, "detail": f"Hermes API unavailable: {type(exc).__name__}"}


def toolsets():
    try:
        with _request("/v1/toolsets", timeout=4) as response:
            items = json.load(response).get("data", [])
        return [f"{'✓ enabled' if item.get('enabled') else '○ disabled'} {item.get('name', 'tool')} {item.get('label', '')}"
                for item in items if item.get("configured") or item.get("enabled")]
    except (OSError, ValueError, RuntimeError):
        return []


def messages(session_id):
    if not session_id:
        return []
    path = "/api/sessions/" + urllib.parse.quote(session_id, safe="") + "/messages?limit=30&order=latest"
    with _request(path, timeout=6) as response:
        data = json.load(response).get("data", [])
    return [{"role": item.get("role"), "content": item.get("content", ""),
             "timestamp": item.get("timestamp")}
            for item in data if item.get("role") in {"user", "assistant"}]


def create_session(title, system):
    # Hermes requires globally unique titles, while UI chat names such as
    # "General" are intentionally reusable. A disconnected first turn can
    # also leave a valid Hermes session before Zuzu has persisted its ID.
    base = (str(title or "Zuzu chat").strip() or "Zuzu chat")[:80]
    internal_title = f"{base} · {int(time.time())}-{secrets.token_hex(3)}"
    with _request("/api/sessions", {"title": internal_title, "source": "api_server",
                                    "system_prompt": system}, timeout=10) as response:
        item = json.load(response)
    session = item.get("session") or item
    sid = session.get("id")
    if not sid:
        raise RuntimeError("Hermes did not return a session ID")
    return sid


def run_hermes(message, session_id=None, system=None, *, title="Zuzu chat", provider=None, model=None):
    """Yield dashboard NDJSON events from Hermes' native session SSE."""
    started = time.monotonic()
    sid = session_id or create_session(title, system or "")
    body = {"message": message, "system_message": system or ""}
    if provider and model:
        body.update(provider=provider, model=model, require_model_lock=True)
    yield {"t": "status", "runtime": "hermes-api", "model": model or "Hermes profile default",
           "session_id": sid, "tools": 0, "profile": os.environ.get("HERMES_PROFILE", "default")}
    path = "/api/sessions/" + urllib.parse.quote(sid, safe="") + "/chat/stream"
    saw_delta = False
    final_text = ""
    terminal = None
    failure = ""
    try:
        with _request(path, body, timeout=180) as response:
            event_name = ""
            for raw in response:
                line = raw.decode("utf-8", "replace").rstrip("\r\n")
                if line.startswith("event:"):
                    event_name = line[6:].strip()
                elif line.startswith("data:"):
                    try:
                        event = json.loads(line[5:].strip())
                    except ValueError:
                        continue
                    kind = event_name or event.get("type", "")
                    if kind == "assistant.delta":
                        delta = event.get("delta", "")
                        if delta:
                            if not saw_delta:
                                yield {"t": "latency", "ms": int((time.monotonic() - started) * 1000)}
                                saw_delta = True
                            yield {"t": "delta", "text": delta}
                    elif kind in {"tool.started", "tool.completed", "tool.failed"}:
                        yield {"t": "tool", "phase": "use" if kind == "tool.started" else "done",
                               "name": event.get("tool_name", "tool"), "input": str(event.get("preview") or "")[:160],
                               "ok": kind != "tool.failed"}
                    elif kind == "assistant.completed":
                        final_text = event.get("content") or ""
                    elif kind in {"run.completed", "run.failed", "run.cancelled"}:
                        terminal = kind
                        if kind != "run.completed":
                            failure = str(event.get("error") or event.get("reason") or final_text or kind)[:300]
                        if event.get("usage"):
                            yield {"t": "usage", **event["usage"]}
                    elif kind == "error":
                        terminal = "run.failed"
                        failure = str(event.get("message") or "Hermes run failed")[:300]
                elif not line:
                    event_name = ""
        if terminal == "run.completed":
            if not saw_delta and final_text:
                yield {"t": "delta", "text": final_text}
            yield {"t": "complete", "session_id": sid, "ms": int((time.monotonic() - started) * 1000)}
        else:
            yield {"t": "error", "message": failure if terminal in {"run.failed", "run.cancelled"} else "Hermes ended without completing the turn"}
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            payload = json.loads(exc.read())
            detail = str((payload.get("error") or {}).get("message") or "")[:180]
        except (ValueError, OSError, AttributeError):
            pass
        yield {"t": "error", "message": detail or f"Hermes API HTTP {exc.code}"}
    except (OSError, ValueError, RuntimeError) as exc:
        yield {"t": "error", "message": f"Hermes API disconnected: {type(exc).__name__}"}
