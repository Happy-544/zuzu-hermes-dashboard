"""Image and video creation with Google's Gemini API (the same key Zuzu's voice uses).

Images return in a few seconds. Videos are long-running: the job is started, polled in
the background, saved to uploads/ and announced when ready.
"""
import base64
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

import personal
import runtime
import workspace

BASE = "https://generativelanguage.googleapis.com/v1beta/"
IMAGE_MODEL = os.environ.get("GEMINI_IMAGE_MODEL", "gemini-2.5-flash-image").strip()
VIDEO_MODEL = os.environ.get("GEMINI_VIDEO_MODEL", "veo-3.0-fast-generate-001").strip()
JOBS = {}
LOCK = threading.Lock()


def _key():
    key = runtime.gemini_api_key()
    if not key:
        raise RuntimeError("A Gemini API key is needed to create images and videos")
    return key


def _call(path, body=None, timeout=90):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None,
                                 method="POST" if body is not None else "GET",
                                 headers={"content-type": "application/json", "x-goog-api-key": _key()})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read()).get("error", {}).get("message", "")
        except Exception:  # noqa: BLE001
            detail = ""
        raise RuntimeError(f"Google rejected the request: {detail or f'HTTP {exc.code}'}") from None


def _slug(prompt):
    words = "".join(c if c.isalnum() else " " for c in prompt.lower()).split()[:5]
    return "_".join(words) or "creation"


def create_image(prompt):
    prompt = str(prompt or "").strip()[:2000]
    if not prompt:
        raise ValueError("Describe the image you want")
    data = _call(f"models/{urllib.parse.quote(IMAGE_MODEL, safe='-.')}:generateContent", {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"responseModalities": ["IMAGE", "TEXT"]}})
    parts = (data.get("candidates") or [{}])[0].get("content", {}).get("parts", [])
    image = next((p.get("inlineData") or p.get("inline_data") for p in parts if p.get("inlineData") or p.get("inline_data")), None)
    if not image:
        note = " ".join(p.get("text", "") for p in parts).strip()
        raise RuntimeError(note[:200] or "The model returned no image")
    ext = ".jpg" if "jpeg" in image.get("mimeType", "") else ".png"
    saved = workspace.store_upload(f"image_{_slug(prompt)}{ext}", base64.b64decode(image["data"]))
    return {**saved, "kind": "image", "prompt": prompt}


def create_video(prompt):
    prompt = str(prompt or "").strip()[:2000]
    if not prompt:
        raise ValueError("Describe the video you want")
    op = _call(f"models/{urllib.parse.quote(VIDEO_MODEL, safe='-.')}:predictLongRunning",
               {"instances": [{"prompt": prompt}], "parameters": {"aspectRatio": "16:9"}})
    job = {"id": uuid.uuid4().hex[:8], "prompt": prompt, "status": "working", "operation": op.get("name"), "started": time.time()}
    if not job["operation"]:
        raise RuntimeError("Google did not start the video job")
    with LOCK:
        JOBS[job["id"]] = job
    threading.Thread(target=_poll_video, args=(job,), daemon=True).start()
    return {k: v for k, v in job.items() if k != "operation"}


def _poll_video(job, interval=10, limit=900):
    deadline = time.time() + limit
    try:
        while time.time() < deadline:
            time.sleep(interval)
            op = _call(job["operation"])
            if not op.get("done"):
                continue
            if op.get("error"):
                raise RuntimeError(op["error"].get("message", "video failed"))
            samples = (op.get("response", {}).get("generateVideoResponse", {}).get("generatedSamples") or [])
            uri = samples[0]["video"]["uri"] if samples else ""
            if not uri:
                raise RuntimeError("Google returned no video")
            req = urllib.request.Request(uri, headers={"x-goog-api-key": _key()})
            with urllib.request.urlopen(req, timeout=180) as response:
                saved = workspace.store_upload(f"video_{_slug(job['prompt'])}.mp4", response.read())
            job.update(status="done", url=saved["url"], name=saved["name"])
            personal.announce("media", f"Your video is ready: {job['prompt'][:80]}", {"url": saved["url"], "kind": "video"})
            return
        raise RuntimeError("video took longer than 15 minutes")
    except Exception as exc:  # noqa: BLE001
        job.update(status="failed", error=str(exc)[:200])
        personal.announce("media", f"The video could not be created: {str(exc)[:120]}", {"kind": "error"})


def jobs():
    with LOCK:
        return [{k: v for k, v in j.items() if k != "operation"} for j in JOBS.values()]
