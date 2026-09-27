"""Zuzu's creative studio.

  edit_image    change any photo by describing the change (Gemini image editing)
  room_redesign restyle a room photo for a fit-out concept, keeping the layout
  product_photo clean studio shot of a finished piece
  resin_quote   materials, cost and selling price for resin / wood pieces
  design_piece  concept images plus a quote for a piece you describe
  listing       marketplace / Instagram post (English + Arabic) from a product photo
  make_music    songs and loops with Google's Lyria (same Gemini key)
  make_3d       photo or text to a 3D model (GLB / STL) with Meshy

Images come in as /uploads/... URLs (sent through /api/upload first), results are saved
to uploads/ and long jobs are announced when ready.
"""
import base64
import json
import math
import mimetypes
import os
import pathlib
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

import media
import personal
import workspace

MUSIC_CLIP_MODEL = os.environ.get("GEMINI_MUSIC_CLIP_MODEL", "lyria-3-clip-preview").strip()
MUSIC_SONG_MODEL = os.environ.get("GEMINI_MUSIC_MODEL", "lyria-3.5").strip()
MESHY = "https://api.meshy.ai/openapi/"
JOBS = {}
LOCK = threading.Lock()
ROOM_STYLES = {
    "modern majlis": "a modern Arabic majlis: low wide seating, warm neutral fabrics, walnut, brushed brass accents, soft cove lighting",
    "japandi": "Japandi: light oak, linen, stone, low furniture, calm muted palette, paper lamps",
    "scandinavian": "Scandinavian: white oak floors, soft whites and greys, wool textures, simple functional furniture, plants",
    "luxury classic": "luxury classic: marble, gold trims, panelled walls, crystal chandelier, velvet upholstery",
    "industrial": "industrial loft: exposed concrete, black steel, leather, warm Edison lighting, reclaimed wood",
    "minimal white": "minimal white gallery style: seamless white surfaces, hidden storage, one sculptural piece, linear lighting",
    "arabic contemporary": "contemporary Arabic: mashrabiya screens, arches, sand and terracotta tones, geometric patterns, warm wood",
}
STRENGTH = {1: "Keep it subtle: same furniture layout and architecture, only refresh finishes, colours and decor.",
            2: "Keep walls, windows, doors, ceiling and camera angle exactly; replace furniture, finishes and lighting.",
            3: "Keep only the room's architecture and camera angle; redesign everything else boldly."}


# ── helpers ──────────────────────────────────────────────────────────
def _upload_file(url):
    """Resolve an /uploads/... URL to a file inside the uploads folder (never outside it)."""
    name = urllib.parse.unquote(str(url or "").split("?", 1)[0])
    if not name.startswith("/uploads/"):
        raise ValueError("Upload the photo first")
    path = (workspace.UPLOADS / name[len("/uploads/"):]).resolve()
    if workspace.UPLOADS.resolve() not in path.parents or not path.is_file():
        raise ValueError("That photo is no longer available")
    if path.stat().st_size > 15 * 1024 * 1024:
        raise ValueError("Photo is too large (15 MB max)")
    return path


def _image_part(url):
    path = _upload_file(url)
    mime = mimetypes.guess_type(path.name)[0] or "image/jpeg"
    if not mime.startswith("image/"):
        raise ValueError("That file is not an image")
    return {"inlineData": {"mimeType": mime, "data": base64.b64encode(path.read_bytes()).decode()}}


def _save_image(parts, label, prompt, source=""):
    image = next((p.get("inlineData") or p.get("inline_data") for p in parts if p.get("inlineData") or p.get("inline_data")), None)
    if not image:
        note = " ".join(p.get("text", "") for p in parts).strip()
        raise RuntimeError(note[:200] or "The model returned no image")
    ext = ".jpg" if "jpeg" in image.get("mimeType", image.get("mime_type", "")) else ".png"
    saved = workspace.store_upload(f"{label}_{media._slug(prompt)}{ext}", base64.b64decode(image["data"]))
    return {**saved, "kind": "image", "prompt": prompt, "source": source}


def _gemini_image(parts):
    data = media._call(f"models/{urllib.parse.quote(media.IMAGE_MODEL, safe='-.')}:generateContent", {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {"responseModalities": ["IMAGE", "TEXT"]}}, timeout=120)
    return (data.get("candidates") or [{}])[0].get("content", {}).get("parts", [])


def _gemini_json(parts, max_tokens=1200):
    data = media._call(f"models/{urllib.parse.quote(os.environ.get('GEMINI_CHAT_MODEL', 'gemini-2.5-flash'), safe='-.')}:generateContent", {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {"responseMimeType": "application/json", "temperature": 0.6, "maxOutputTokens": max_tokens}}, timeout=90)
    out = (data.get("candidates") or [{}])[0].get("content", {}).get("parts", [])
    return json.loads("".join(p.get("text", "") for p in out) or "{}")


def _job(kind, prompt, **extra):
    job = {"id": uuid.uuid4().hex[:8], "kind": kind, "prompt": prompt[:200], "status": "working", "started": time.time(), **extra}
    with LOCK:
        JOBS[job["id"]] = job
        for old in sorted(JOBS.values(), key=lambda j: j["started"])[:-30]:
            JOBS.pop(old["id"], None)
    return job


def jobs():
    with LOCK:
        return sorted((dict(j) for j in JOBS.values()), key=lambda j: j["started"], reverse=True)


def _run(job, work, done_text):
    def target():
        try:
            job.update(work(), status="done")
            personal.announce("media", done_text(job), {"url": job.get("url", ""), "kind": job["kind"]}, telegram=False)
        except Exception as exc:  # noqa: BLE001 - report every failure to the user
            job.update(status="failed", error=str(exc)[:220])
            personal.announce("media", f"The {job['kind']} could not be created: {str(exc)[:120]}", {"kind": "error"}, telegram=False)
    threading.Thread(target=target, daemon=True).start()
    return dict(job)


# ── photo editing ────────────────────────────────────────────────────
def edit_image(image_url, prompt, references=()):
    prompt = str(prompt or "").strip()[:1500]
    if not prompt:
        raise ValueError("Describe the change you want")
    parts = [_image_part(image_url)] + [_image_part(u) for u in list(references)[:2]]
    parts.append({"text": "Edit the first image: " + prompt + ". Keep everything else exactly as it is, same framing and "
                          "resolution, photorealistic. Return the edited image."})
    return _save_image(_gemini_image(parts), "edit", prompt, image_url)


def room_redesign(image_url, style, materials="", strength=2):
    style_key = str(style or "").strip().lower()
    look = ROOM_STYLES.get(style_key, str(style or "").strip()[:300])
    if not look:
        raise ValueError("Pick a style")
    level = STRENGTH.get(int(strength or 2), STRENGTH[2])
    prompt = (f"Interior design concept render of this exact room in the style of {look}. {level} "
              + (f"Use these materials: {str(materials)[:300]}. " if materials else "")
              + "Realistic lighting and scale, professional architectural photography, no people, no text.")
    parts = [_image_part(image_url), {"text": prompt}]
    return _save_image(_gemini_image(parts), "room", style_key or look, image_url)


def product_photo(image_url, background="clean white studio"):
    prompt = (f"Turn this into a professional product photo on a {str(background)[:120]} background with soft studio lighting "
              "and a gentle natural shadow. Keep the product itself exactly the same shape, colours and details.")
    return _save_image(_gemini_image([_image_part(image_url), {"text": prompt}]), "product", background, image_url)


# ── resin & wood studio ──────────────────────────────────────────────
def resin_quote(values):
    """Materials, cost and price for a resin (and wood) piece. Pure maths; all money in `currency`."""
    v = dict(values or {})
    num = lambda k, d, lo=0.0, hi=1e6: max(lo, min(hi, float(v.get(k) if v.get(k) not in (None, "") else d)))
    length, width, depth = num("length", 60, 1, 1000), num("width", 40, 1, 1000), num("depth", 2, 0.1, 50)
    shape = str(v.get("shape", "rectangle")).lower()
    area = math.pi * (length / 2) ** 2 if shape in {"round", "circle"} else length * width      # cm²
    fill = num("fillPercent", 100, 1, 100) / 100
    waste = num("wastePercent", 10, 0, 50) / 100
    pieces = int(num("pieces", 1, 1, 500))
    litres = area * fill * depth / 1000 * (1 + waste) * pieces
    kg = litres * 1.1                                  # typical epoxy density ≈ 1.1 kg/L
    ratio_a, ratio_b = (float(x) for x in str(v.get("ratio", "2:1")).split(":")[:2])
    max_pour = num("maxPourCm", 5, 0.3, 20)
    layers = max(1, math.ceil(depth / max_pour))
    pigment_g = kg * 1000 * 0.01                       # ~1% pigment by weight
    resin_cost = litres * num("resinPrice", 45)
    pigment_cost = pigment_g * num("pigmentPricePerGram", 0.15)
    wood_cost = num("woodCost", 0) * pieces
    extras = num("extrasCost", 0) * pieces             # legs, sealant, sanding discs, moulds
    labour = num("hours", 6) * num("hourlyRate", 50) * pieces
    materials = resin_cost + pigment_cost + wood_cost + extras
    cost = materials + labour
    margin = num("marginPercent", 60, 0, 500) / 100
    price = cost * (1 + margin)
    r = lambda x, n=2: round(x, n)
    return {
        "currency": str(v.get("currency", "AED"))[:6], "pieces": pieces, "areaCm2": r(area * pieces, 1),
        "resinLitres": r(litres), "resinKg": r(kg), "partA": r(litres * ratio_a / (ratio_a + ratio_b)),
        "partB": r(litres * ratio_b / (ratio_a + ratio_b)), "ratio": f"{ratio_a:g}:{ratio_b:g}", "layers": layers,
        "layerDepthCm": r(depth / layers, 1), "pigmentGrams": r(pigment_g, 0),
        "costs": {"resin": r(resin_cost), "pigment": r(pigment_cost), "wood": r(wood_cost), "extras": r(extras),
                  "materials": r(materials), "labour": r(labour), "total": r(cost)},
        "price": r(price), "pricePerPiece": r(price / pieces), "profit": r(price - cost),
        "notes": [f"Pour in {layers} layer{'s' if layers > 1 else ''} of about {depth / layers:.1f} cm; check your resin's maximum pour depth.",
                  "Mix by volume at the ratio on your resin; weigh with a scale for small batches.",
                  "Seal the wood first so it does not release air bubbles into the resin."],
    }


def design_piece(description, values=None):
    description = str(description or "").strip()[:600]
    if not description:
        raise ValueError("Describe the piece")
    image = media.create_image(f"Product concept photo of a handmade piece: {description}. Premium craftsmanship, epoxy resin "
                               "and natural wood where relevant, soft studio lighting, realistic, no text.")
    return {"image": image, "quote": resin_quote(values or {})}


def listing(image_url, notes="", cost=None, currency="AED"):
    prompt = ("You write product listings for a small handmade resin & wood studio in the UAE. From the photo and notes, reply JSON: "
              '{"title": "short catchy title", "en": "Instagram/marketplace post in English, 60-90 words, warm and premium, with size/material if known", '
              '"ar": "the same post in natural Gulf/Egyptian-friendly Arabic", "hashtags": ["10 relevant hashtags without #"], '
              '"price": {"low": number, "high": number, "reason": "one line"}, "photoTips": ["2 short tips to photograph it better"]}. '
              f"Currency {currency}. " + (f"Production cost is {cost} {currency}; never price below cost x1.5. " if cost else "")
              + f"Notes from the maker: {str(notes)[:600]}")
    result = _gemini_json([_image_part(image_url), {"text": prompt}])
    result["hashtags"] = [str(h).lstrip("#") for h in (result.get("hashtags") or [])][:15]
    return result


# ── music (Lyria) ────────────────────────────────────────────────────
def make_music(prompt, full=False, image_url=""):
    prompt = str(prompt or "").strip()[:800]
    if not prompt:
        raise ValueError("Describe the music")
    model = MUSIC_SONG_MODEL if full else MUSIC_CLIP_MODEL
    parts = ([_image_part(image_url)] if image_url else []) + [{"text": prompt + ("" if full else ". Instrumental loop.")}]
    job = _job("music", prompt, model=model, full=bool(full))

    def work():
        data = media._call(f"models/{urllib.parse.quote(model, safe='-.')}:generateContent", {
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": {"responseModalities": ["AUDIO", "TEXT"]}}, timeout=300)
        out = (data.get("candidates") or [{}])[0].get("content", {}).get("parts", [])
        audio = next((p.get("inlineData") or p.get("inline_data") for p in out if p.get("inlineData") or p.get("inline_data")), None)
        if not audio:
            raise RuntimeError(" ".join(p.get("text", "") for p in out).strip()[:200] or "Lyria returned no audio")
        mime = audio.get("mimeType", audio.get("mime_type", "audio/mpeg"))
        ext = ".wav" if "wav" in mime else ".mp3"
        saved = workspace.store_upload(f"music_{media._slug(prompt)}{ext}", base64.b64decode(audio["data"]))
        lyrics = " ".join(p.get("text", "") for p in out).strip()
        return {"url": saved["url"], "name": saved["name"], "lyrics": lyrics[:2000]}
    return _run(job, work, lambda j: f"Your music is ready: {j['prompt'][:80]}")


# ── 3D (Meshy) ───────────────────────────────────────────────────────
def meshy_key():
    return os.environ.get("MESHY_API_KEY", "").strip()


def _meshy(path, body=None):
    key = meshy_key()
    if not key:
        raise RuntimeError("Add MESHY_API_KEY to the .env file to create 3D models (meshy.ai → API)")
    req = urllib.request.Request(MESHY + path, data=json.dumps(body).encode() if body is not None else None,
                                 method="POST" if body is not None else "GET",
                                 headers={"content-type": "application/json", "authorization": f"Bearer {key}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read()).get("message", "")
        except Exception:  # noqa: BLE001
            detail = ""
        raise RuntimeError(f"Meshy rejected the request: {detail or f'HTTP {exc.code}'}") from None


def make_3d(image_url="", prompt=""):
    prompt = str(prompt or "").strip()[:600]
    if not image_url and not prompt:
        raise ValueError("Add a photo or describe the object")
    if not meshy_key():
        raise RuntimeError("Add MESHY_API_KEY to the .env file to create 3D models (meshy.ai → API)")
    if image_url:
        part = _image_part(image_url)["inlineData"]
        route = "v1/image-to-3d"
        body = {"image_url": f"data:{part['mimeType']};base64,{part['data']}", "should_texture": True, "enable_pbr": False}
    else:
        route = "v2/text-to-3d"
        body = {"mode": "preview", "prompt": prompt}
    job = _job("3d", prompt or "model from photo", source=image_url)

    def work(interval=8, limit=900):
        task = _meshy(route, body).get("result")
        if not task:
            raise RuntimeError("Meshy did not start the job")
        deadline = time.time() + limit
        while time.time() < deadline:
            time.sleep(interval)
            info = _meshy(f"{route}/{task}")
            job["progress"] = info.get("progress", 0)
            if info.get("status") == "SUCCEEDED":
                result = {}
                for fmt in ("glb", "stl"):
                    link = (info.get("model_urls") or {}).get(fmt)
                    if link:
                        with urllib.request.urlopen(link, timeout=180) as response:
                            saved = workspace.store_upload(f"model_{media._slug(job['prompt'])}.{fmt}", response.read())
                        result[fmt] = saved["url"]
                thumb = info.get("thumbnail_url")
                if thumb:
                    with urllib.request.urlopen(thumb, timeout=60) as response:
                        result["thumbnail"] = workspace.store_upload(f"model_{media._slug(job['prompt'])}.png", response.read())["url"]
                return {"url": result.get("glb") or result.get("stl", ""), **result}
            if info.get("status") in {"FAILED", "CANCELED", "EXPIRED"}:
                raise RuntimeError((info.get("task_error") or {}).get("message") or "Meshy could not build the model")
        raise RuntimeError("the 3D model took longer than 15 minutes")
    return _run(job, work, lambda j: f"Your 3D model is ready: {j['prompt'][:80]}")


def action(payload):
    kind = payload.get("action")
    if kind == "edit":
        return edit_image(payload.get("image"), payload.get("prompt"), payload.get("references") or [])
    if kind == "room":
        return room_redesign(payload.get("image"), payload.get("style"), payload.get("materials", ""), payload.get("strength", 2))
    if kind == "product":
        return product_photo(payload.get("image"), payload.get("background") or "clean white studio")
    if kind == "quote":
        return resin_quote(payload.get("values"))
    if kind == "design":
        return design_piece(payload.get("description"), payload.get("values"))
    if kind == "listing":
        return listing(payload.get("image"), payload.get("notes", ""), payload.get("cost"), payload.get("currency", "AED"))
    if kind == "music":
        return make_music(payload.get("prompt"), bool(payload.get("full")), payload.get("image") or "")
    if kind == "3d":
        return make_3d(payload.get("image") or "", payload.get("prompt") or "")
    raise ValueError("unknown creative action")
