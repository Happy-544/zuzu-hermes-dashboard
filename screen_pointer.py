"""Drive the on-screen overlay and find things on the laptop screen with Gemini vision."""
import base64
import json
import os
import pathlib
import subprocess
import sys
import threading
import urllib.parse
import urllib.request

import overlay
import runtime

ROOT = pathlib.Path(__file__).resolve().parent
_PROC = None
_LOCK = threading.Lock()
VISION_MODEL = os.environ.get("GEMINI_VISION_MODEL", "gemini-2.5-flash").strip()


def available():
    return os.name == "nt"


def send(cmd):
    """Send one drawing command to the overlay, starting it if needed."""
    global _PROC
    if not available():
        raise RuntimeError("Drawing on the screen works on the Windows laptop")
    with _LOCK:
        if _PROC is None or _PROC.poll() is not None:
            _PROC = subprocess.Popen([sys.executable, str(ROOT / "overlay.py")], stdin=subprocess.PIPE,
                                     text=True, encoding="utf-8", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        _PROC.stdin.write(json.dumps(cmd) + "\n")
        _PROC.stdin.flush()


def clean_command(cmd):
    kind = cmd.get("type")
    num = lambda v: min(1.0, max(0.0, float(v)))
    ttl = min(60.0, max(1.0, float(cmd.get("ttl", 8))))
    if kind == "clear":
        return {"type": "clear"}
    if kind == "path":
        points = [[num(p[0]), num(p[1])] for p in (cmd.get("points") or [])[:2000]]
        if len(points) < 2:
            raise ValueError("A stroke needs at least two points")
        return {"type": "path", "points": points, "ttl": ttl}
    if kind == "arrow":
        return {"type": "arrow", "x1": num(cmd["x1"]), "y1": num(cmd["y1"]), "x2": num(cmd["x2"]), "y2": num(cmd["y2"]),
                "label": str(cmd.get("label", ""))[:60], "ttl": ttl}
    if kind == "circle":
        return {"type": "circle", "x": num(cmd["x"]), "y": num(cmd["y"]), "r": min(0.3, max(0.005, float(cmd.get("r", 0.03)))), "ttl": ttl}
    raise ValueError("unknown drawing command")


def locate(jpeg, description):
    """Ask Gemini where `description` is on the screenshot. Returns normalised centre and size."""
    key = runtime.gemini_api_key()
    if not key:
        raise RuntimeError("A Gemini API key is needed to find things on the screen")
    prompt = (f"Find this on the screenshot: {description}. Reply with JSON only: "
              '{"found": true or false, "box_2d": [ymin, xmin, ymax, xmax], "label": "2-4 word name"} '
              "with box coordinates normalised to 0-1000 over the whole image.")
    body = {"contents": [{"role": "user", "parts": [
                {"inlineData": {"mimeType": "image/jpeg", "data": base64.b64encode(jpeg).decode()}}, {"text": prompt}]}],
            "generationConfig": {"responseMimeType": "application/json", "temperature": 0}}
    req = urllib.request.Request(
        "https://generativelanguage.googleapis.com/v1beta/models/" + urllib.parse.quote(VISION_MODEL, safe="-.") + ":generateContent",
        data=json.dumps(body).encode(), method="POST", headers={"content-type": "application/json", "x-goog-api-key": key})
    with urllib.request.urlopen(req, timeout=40) as response:
        payload = json.loads(response.read())
    parts = (payload.get("candidates") or [{}])[0].get("content", {}).get("parts", [])
    answer = json.loads("".join(p.get("text", "") for p in parts) or "{}")
    if isinstance(answer, list):
        answer = answer[0] if answer else {}
    box = answer.get("box_2d")
    if not answer.get("found", bool(box)) or not box or len(box) != 4:
        return {"found": False}
    ymin, xmin, ymax, xmax = [float(v) / 1000 for v in box]
    return {"found": True, "x": (xmin + xmax) / 2, "y": (ymin + ymax) / 2,
            "w": abs(xmax - xmin), "h": abs(ymax - ymin), "label": str(answer.get("label") or description)[:40]}


def point(jpeg, description, ttl=10):
    spot = locate(jpeg, description)
    if not spot["found"]:
        return spot
    sx, sy = overlay.arrow_from(spot["x"], spot["y"])
    r = max(0.015, min(0.2, max(spot["w"], spot["h"]) * 0.65))
    send({"type": "circle", "x": spot["x"], "y": spot["y"], "r": r, "ttl": ttl})
    dx, dy = sx - spot["x"], sy - spot["y"]
    length = max(1e-6, (dx * dx + dy * dy) ** 0.5)
    tip_x, tip_y = spot["x"] + dx / length * r, spot["y"] + dy / length * r   # stop at the circle's edge
    send({"type": "arrow", "x1": sx, "y1": sy, "x2": tip_x, "y2": tip_y, "label": spot["label"], "ttl": ttl})
    return spot
