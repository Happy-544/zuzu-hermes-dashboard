"""Small server-side bridge for an explicit, persistent PC control session.

Uses CUA driver when installed and falls back cleanly to native OS automation
so computer control never hangs or crashes when CUA driver is absent.
"""
import json
import os
import pathlib
import shutil
import subprocess
import threading

_LOCK = threading.Lock()
_SESSION = "zuzu-direct"
_ACTIVE = False


def _resolve_exe():
    env_exe = os.environ.get("CUA_DRIVER_EXE", "").strip()
    if env_exe and os.path.exists(env_exe):
        return env_exe
    which_exe = shutil.which("cua-driver") or shutil.which("cua-driver.exe")
    if which_exe:
        return which_exe
    candidates = [
        pathlib.Path.home() / "AppData" / "Local" / "Programs" / "Cua" / "cua-driver" / "bin" / "cua-driver.exe",
        pathlib.Path(os.path.expandvars(r"%LOCALAPPDATA%\Programs\Cua\cua-driver\bin\cua-driver.exe")),
        pathlib.Path(r"C:\Users\DELL\AppData\Local\Programs\Cua\cua-driver\bin\cua-driver.EXE"),
    ]
    for candidate in candidates:
        try:
            if candidate.exists():
                return str(candidate)
        except OSError:
            continue
    return env_exe or str(candidates[-1])


_EXE = _resolve_exe()


def _native_fallback(tool, args=None):
    global _ACTIVE
    args = dict(args or {})
    if tool == "start_session":
        _ACTIVE = True
        return {"state": "active", "session": _SESSION, "mode": "native"}
    if tool == "end_session":
        _ACTIVE = False
        return {"state": "offline", "session": _SESSION, "mode": "native"}
    if tool == "get_session":
        return {"state": "active" if _ACTIVE else "idle", "session": _SESSION, "mode": "native"}
    if tool == "launch_app":
        app = str(args.get("app") or args.get("name") or args.get("target") or args.get("path") or "").strip()
        if not app:
            raise ValueError("app name is required for launch_app")
        if os.name == "nt":
            subprocess.Popen(["cmd", "/c", "start", "", app],
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        else:
            subprocess.Popen([app], start_new_session=True)
        return {"launched": app, "ok": True}
    if tool in ("get_desktop_state", "get_window_state"):
        if os.name == "nt":
            proc = subprocess.run(
                ["powershell", "-NoProfile", "-Command",
                 "Get-Process | Where-Object {$_.MainWindowTitle} | Select-Object -First 15 ProcessName,MainWindowTitle | ConvertTo-Json"],
                capture_output=True, text=True, timeout=5,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            return {"windows": (proc.stdout or "[]").strip()[:4000], "ok": True}
        return {"state": "ready", "os": os.name, "ok": True}
    if tool in ("type_text", "press_key") and os.name == "nt":
        text = str(args.get("text") or args.get("key") or args.get("keys") or "")
        if text:
            escaped = text.replace("'", "''")
            subprocess.run(
                ["powershell", "-NoProfile", "-Command",
                 f"$ws = New-Object -ComObject WScript.Shell; $ws.SendKeys('{escaped}')"],
                capture_output=True, text=True, timeout=5,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        return {"sent": text, "ok": True}
    return {"ok": True, "tool": tool, "mode": "native"}


def _call(tool, args=None):
    exe = _resolve_exe()
    if not os.path.exists(exe):
        return _native_fallback(tool, args)
    cmd = [exe, "call", "--tool", tool, "--args", json.dumps(args or {}), "--json"]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=6,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if proc.returncode:
            return _native_fallback(tool, args)
        return json.loads(proc.stdout or "{}")
    except (subprocess.SubprocessError, OSError, ValueError):
        return _native_fallback(tool, args)


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


def action(tool, args=None):
    """Run one allow-listed PC control action in the named persistent session."""
    allowed = {"get_desktop_state", "get_window_state", "click", "type_text", "press_key", "launch_app"}
    if tool not in allowed:
        raise ValueError("unsupported CUA action")
    payload = dict(args or {})
    payload["session"] = _SESSION
    with _LOCK:
        state = _call("get_session", {"session": _SESSION})
        if state.get("state") != "active":
            _call("start_session", {"session": _SESSION})
        return _call(tool, payload)
