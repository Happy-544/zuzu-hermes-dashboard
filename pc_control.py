"""Small server-side bridge for an explicit, persistent CUA session.

The bridge only creates/ends a named driver session. It never accepts arbitrary
mouse or keyboard coordinates from the browser; those remain tool-mediated.
"""
import json
import os
import subprocess
import threading

_LOCK = threading.Lock()
_SESSION = "zuzu-direct"
_EXE = os.environ.get(
    "CUA_DRIVER_EXE",
    r"C:\Users\DELL\AppData\Local\Programs\Cua\cua-driver\bin\cua-driver.EXE",
)


def _call(tool, args=None):
    if not os.path.exists(_EXE):
        raise RuntimeError("CUA driver is not installed on this computer")
    cmd = [_EXE, "call", "--tool", tool, "--args", json.dumps(args or {}), "--json"]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=8,
                          creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if proc.returncode:
        raise RuntimeError((proc.stderr or proc.stdout or "CUA driver failed").strip()[:240])
    return json.loads(proc.stdout or "{}")


def start():
    with _LOCK:
        return _call("start_session", {"session": _SESSION})


def status():
    with _LOCK:
        try:
            return _call("get_session", {"session": _SESSION})
        except Exception as exc:
            return {"state": "offline", "error": str(exc)[:240], "session": _SESSION}


def stop():
    with _LOCK:
        return _call("end_session", {"session": _SESSION})
