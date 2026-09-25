"""Vapi phone transport. Hermes remains the model; this module never stores keys."""
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

_PHONE = re.compile(r"^\+[1-9][0-9]{7,14}$")
_LOCK = threading.Lock()
_RECENT = {}


def valid_number(number):
    return isinstance(number, str) and bool(_PHONE.fullmatch(number))


def readiness():
    required = ("VAPI_API_KEY", "VAPI_ASSISTANT_ID", "VAPI_PHONE_NUMBER_ID",
                "VAPI_LLM_TOKEN", "HERMES_PHONE_API_KEY", "HERMES_PHONE_API_BASE")
    missing = [name for name in required if not os.environ.get(name)]
    return {"configured": not missing, "missing": missing,
            "dialer": True, "ai_calls": not missing,
            "note": "Vapi assistant must route inbound calls and use Hermes as its custom LLM."}


def _api(method, path, payload=None):
    key = os.environ.get("VAPI_API_KEY", "")
    if not key:
        raise RuntimeError("Vapi is not configured")
    req = urllib.request.Request("https://api.vapi.ai" + path,
        data=json.dumps(payload).encode("utf-8") if payload is not None else None,
        method=method, headers={"Authorization": "Bearer " + key,
                                 "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Vapi HTTP {exc.code}") from exc


def outbound(number, confirmation, request_id):
    if not valid_number(number):
        raise ValueError("Use an international phone number such as +15551234567")
    if confirmation is not True:
        raise ValueError("Confirm the destination before placing a paid call")
    if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{12,80}", request_id):
        raise ValueError("A unique request ID is required")
    state = readiness()
    if not state["configured"]:
        raise RuntimeError("Vapi phone account is not connected")
    assistant = _api("GET", "/assistant/" + urllib.parse.quote(os.environ["VAPI_ASSISTANT_ID"], safe=""))
    model = assistant.get("model") or {}
    expected = os.environ.get("JARVIS_PUBLIC_ORIGIN", "").rstrip("/") + "/v1"
    if model.get("provider") != "custom-llm" or model.get("url", "").rstrip("/") != expected:
        raise RuntimeError("Vapi assistant is not connected to this Hermes-backed Zuzu endpoint")
    if int(assistant.get("maxDurationSeconds") or 0) not in range(1, 601):
        raise RuntimeError("Set a maximum call duration of 10 minutes or less in Vapi")
    with _LOCK:
        now = time.monotonic()
        for key, item in list(_RECENT.items()):
            if now - item[0] > 300:
                del _RECENT[key]
        if request_id in _RECENT:
            return _RECENT[request_id][1]
        if any(now - at < 30 for at, _ in _RECENT.values()):
            raise RuntimeError("Wait 30 seconds before starting another AI call")
        # Hold the reservation throughout the API request: double clicks cannot place two calls.
        _RECENT[request_id] = (now, {"status": "starting"})
        try:
            response = _api("POST", "/call", {
                "assistantId": os.environ["VAPI_ASSISTANT_ID"],
                "phoneNumberId": os.environ["VAPI_PHONE_NUMBER_ID"],
                "customer": {"number": number},
            })
            result = {"id": response.get("id"), "status": response.get("status", "queued")}
            if not result["id"]:
                raise RuntimeError("Vapi did not confirm the call ID")
            _RECENT[request_id] = (now, result)
            return result
        except BaseException:
            # A timeout is ambiguous: keep the reservation to avoid a duplicate billed call.
            raise


def history():
    if not os.environ.get("VAPI_API_KEY"):
        return []
    calls = _api("GET", "/call")
    if not isinstance(calls, list):
        calls = calls.get("results", []) if isinstance(calls, dict) else []
    return [{"id": call.get("id"), "status": call.get("status"),
             "type": call.get("type"), "startedAt": call.get("startedAt"),
             "endedAt": call.get("endedAt"), "cost": call.get("cost"),
             "summary": (call.get("analysis") or {}).get("summary", "")}
            for call in calls[:30] if isinstance(call, dict)]
