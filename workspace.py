"""Local workspace state for the dashboard UI. Secrets stay in .env."""
import json
import copy
import os
import pathlib
import re
import threading
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parent
FILE = ROOT / "workspace.json"
UPLOADS = ROOT / "uploads"
LOCK = threading.RLock()

MODELS = {
    "hermes": ["Hermes profile default"],
    "gemini": ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"],
    "openai": ["gpt-5.4", "gpt-5.4-mini"],
    "anthropic": ["claude-sonnet-4-6", "claude-opus-4-6"],
    "openrouter": ["openrouter/auto"],
    "ollama": ["llama3.2", "qwen3"],
}

DEFAULT = {
    "settings": {"provider": "gemini", "model": "gemini-2.5-flash", "profile": "default",
                 "workdir": "~", "computerControl": False, "mobileControl": False,
                 "liveModel": "gemini-2.5-flash-native-audio-preview-12-2025", "voice": "Kore",
                 "persona": "Warm, concise, capable and naturally conversational.",
                 "shortcutName": "JARVIS Control"},
    "projects": [{"id": "home", "name": "Personal workspace", "folder": "~", "sessions": [
        {"id": "main", "name": "General", "created": time.time()}]}],
    "selectedProject": "home", "selectedSession": "main", "skills": [], "memory": [],
}


def _load():
    try:
        data = json.loads(FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    merged = {**copy.deepcopy(DEFAULT), **data}
    merged["settings"] = {**DEFAULT["settings"], **data.get("settings", {})}
    return merged


def load():
    with LOCK:
        return _load()


def save(data):
    with LOCK:
        temp = FILE.with_name(f".{FILE.name}.{uuid.uuid4().hex}.tmp")
        temp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        os.replace(temp, FILE)


def public_state():
    data = load()
    settings = dict(data["settings"])
    provider = settings.get("provider", "gemini")
    key_name = f"{provider.upper()}_API_KEY"
    settings["apiConfigured"] = bool(os.environ.get(key_name)) or (provider == "gemini" and bool(os.environ.get("GEMINI_CONFIG_PATH")))
    settings["apiBase"] = os.environ.get("JARVIS_API_BASE", "")
    return {**data, "settings": settings, "models": MODELS, "uploads": uploads(),
            "hermesMemory": hermes_memory_snapshot()}


def clean_tags(raw):
    """Normalise memory tags: accepts a list or a "#work, family" string; returns up to 12 unique tags."""
    if isinstance(raw, str):
        raw = re.split(r"[,\s]+", raw)
    tags = []
    for tag in raw if isinstance(raw, list) else []:
        tag = re.sub(r"[^\w/-]", "", str(tag).strip().lstrip("#").lower())[:40]
        if tag and tag not in tags:
            tags.append(tag)
    return tags[:12]


def _tag_suffix(memory):
    tags = memory.get("tags") or []
    return " [" + " ".join("#" + t for t in tags) + "]" if tags else ""


def hermes_memory_snapshot():
    """Read Hermes' own curated memory without editing its internal storage."""
    home = pathlib.Path(os.environ.get("HERMES_HOME", pathlib.Path.home() / ".hermes"))
    result = []
    for filename in ("USER.md", "MEMORY.md"):
        path = home / filename
        try:
            content = path.read_text(encoding="utf-8")[:12000]
        except OSError:
            continue
        if content.strip():
            result.append({"source": filename, "content": content})
    return result


def selected_hermes_session():
    """Return the selected UI chat and its own Hermes transcript ID."""
    data = load()
    pid, sid = data.get("selectedProject"), data.get("selectedSession")
    for project in data.get("projects", []):
        if project.get("id") == pid:
            for session in project.get("sessions", []):
                if session.get("id") == sid:
                    return pid, sid, session.get("hermesSessionId")
    return pid, sid, None


def ensure_selected_chat():
    """Choose the first chat, or create one, for the selected project."""
    with LOCK:
        data = _load()
        project = next((p for p in data.get("projects", []) if p.get("id") == data.get("selectedProject")), None)
        if project is None:
            raise ValueError("No selected project")
        sessions = project.setdefault("sessions", [])
        session = next((s for s in sessions if s.get("id") == data.get("selectedSession")), None)
        if session is None:
            if not sessions:
                sessions.append({"id": uuid.uuid4().hex[:10], "name": "General", "created": time.time()})
            session = sessions[0]
            data["selectedSession"] = session["id"]
            save(data)
        return project["id"], session["id"], session.get("hermesSessionId")


def bind_hermes_session(project_id, ui_session_id, hermes_id):
    """Bind a completed run to its original UI chat even if selection changed."""
    with LOCK:
        data = _load()
        for project in data.get("projects", []):
            if project.get("id") == project_id:
                for session in project.get("sessions", []):
                    if session.get("id") == ui_session_id:
                        if hermes_id:
                            session["hermesSessionId"] = hermes_id
                        else:
                            session.pop("hermesSessionId", None)
                        save(data)
                        return True
    return False


def _words(text):
    return {w for w in re.findall(r"[^\W_]{3,}", str(text or "").lower())}


def pick_memories(memories, query="", budget=1600):
    """Most relevant memories for `query` first (shared words, then recency), within a character budget."""
    q = _words(query)
    ranked = sorted(enumerate(memories), key=lambda im: (
        -len(q & _words(f"{im[1].get('label')} {im[1].get('value')} {' '.join(im[1].get('tags') or [])}")),
        -max(im[1].get("updated") or 0, im[1].get("created") or 0, im[0])))
    picked, used = [], 0
    for _, m in ranked:
        cost = len(m.get("label", "")) + min(260, len(m.get("value", ""))) + 12
        if used + cost > budget:
            continue
        picked.append(m); used += cost
    return picked


def agent_context(limit=2400, query=""):
    """Return the bounded Zuzu memory/skill context injected into Hermes and Live voice."""
    data = load(); chunks = []
    memories = pick_memories(data.get("memory", []), query, budget=int(limit * 0.65))
    if memories:
        chunks.append(
            "Zuzu durable memory brain (authoritative saved facts to use across conversations):\n"
            + "\n".join(f"- {m['label']}{_tag_suffix(m)}: {m['value'][:260]}" for m in memories)
        )
    skills = [s for s in data.get("skills", []) if s.get("enabled", True)][-8:]
    if skills:
        chunks.append(
            "Active Zuzu workspace skills (follow when relevant):\n"
            + "\n".join(f"- {s['name']}: {s['instructions'][:360]}" for s in skills)
        )
    if chunks:
        chunks.append(
            "Memory sync rule: these dashboard memories are injected into every Hermes text run and Gemini Live voice setup. "
            "Zuzu also learns automatically: after each turn she saves new lasting facts the user shares and updates changed ones, "
            "so never tell the user you cannot remember things. "
            "Use saved memory naturally and do not claim you forgot it unless it is absent above."
        )
    return "\n\n".join(chunks)[:limit]

_CONTROL_INTENT = re.compile(
    r"(?:^/(?:pc|computer)\b|\b(?:open|close|launch|run|click|tap|type|press|"
    r"download|upload|install|uninstall|move|rename|delete|control|navigate)\b.*"
    r"\b(?:pc|computer|desktop|windows|chrome|edge|browser|file|folder|app|application|"
    r"notepad|calculator|excel|word|powerpoint|outlook|teams|whatsapp)\b|"
    r"(?:افتح|اقفل|شغل|اضغط|اكتب|نز[ّل]|حم[ّل]|احذف|انقل|غي[ّر]).*"
    r"(?:الكمبيوتر|اللابتوب|الويندوز|كروم|إيدج|المتصفح|ملف|مجلد|برنامج))",
    re.I,
)


def computer_control_request(message):
    """Route explicit device actions through Hermes when control is enabled."""
    settings = load().get("settings", {})
    return bool(settings.get("computerControl")) and bool(_CONTROL_INTENT.search(message or ""))


def _env_value(value):
    return re.sub(r"[\r\n\x00]", "", str(value))


def _env_update(values):
    path = ROOT / ".env"
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    pending = dict(values)
    output = []
    for line in lines:
        if "=" in line and not line.lstrip().startswith("#"):
            key = line.split("=", 1)[0].strip()
            if key in pending:
                output.append(f"{key}={_env_value(pending.pop(key))}")
                continue
        output.append(line)
    output.extend(f"{key}={_env_value(value)}" for key, value in pending.items())
    path.write_text("\n".join(output) + "\n", encoding="utf-8")
    for key, value in values.items():
        os.environ[key] = _env_value(value)


def action(payload):
    kind = str(payload.get("action", ""))
    data = load()
    if kind == "save_settings":
        src = payload.get("settings") or {}
        provider = str(src.get("provider", "gemini")).lower()
        if provider not in MODELS:
            raise ValueError("unsupported provider")
        clean = {
            "provider": provider, "model": str(src.get("model", "")).strip()[:120],
            "profile": str(src.get("profile", "default")).strip()[:80] or "default",
            "workdir": str(src.get("workdir", "~")).strip()[:500] or "~",
            "computerControl": bool(src.get("computerControl")), "mobileControl": bool(src.get("mobileControl")),
            "liveModel": str(src.get("liveModel", DEFAULT["settings"]["liveModel"])).strip()[:150],
            "voice": str(src.get("voice", "Kore")).strip()[:60] or "Kore",
            "persona": str(src.get("persona", DEFAULT["settings"]["persona"])).strip()[:8000],
            "shortcutName": str(src.get("shortcutName", DEFAULT["settings"]["shortcutName"])).strip()[:120],
        }
        data["settings"] = clean
        gemini_chat_model = clean["model"] if provider == "gemini" else os.environ.get("GEMINI_CHAT_MODEL", "gemini-2.5-flash")
        env = {"JARVIS_PROVIDER": provider, "JARVIS_MODEL": clean["model"],
               "HERMES_PROFILE": clean["profile"], "JARVIS_WORKDIR": clean["workdir"],
               "GEMINI_CHAT_MODEL": gemini_chat_model,
               "GEMINI_LIVE_MODEL": clean["liveModel"], "GEMINI_TTS_VOICE": clean["voice"],
               "JARVIS_API_BASE": str(src.get("apiBase", "")).strip()[:500]}
        api_key = str(src.get("apiKey", "")).strip()
        if api_key:
            env[f"{provider.upper()}_API_KEY"] = api_key
        _env_update(env)
        save(data)
    elif kind == "add_project":
        name = str(payload.get("name", "New project")).strip()[:80] or "New project"
        folder = str(payload.get("folder", "~")).strip()[:500] or "~"
        item = {"id": uuid.uuid4().hex[:10], "name": name, "folder": folder, "sessions": []}
        data["projects"].append(item); data["selectedProject"] = item["id"]; data["selectedSession"] = ""
        save(data)
    elif kind == "delete_project":
        pid = str(payload.get("id", "")); data["projects"] = [p for p in data["projects"] if p["id"] != pid]
        if not data["projects"]: data["projects"] = copy.deepcopy(DEFAULT["projects"])
        data["selectedProject"] = data["projects"][0]["id"]; data["selectedSession"] = ""; save(data)
    elif kind == "add_session":
        pid = str(payload.get("projectId", data["selectedProject"])); name = str(payload.get("name", "New chat")).strip()[:80] or "New chat"
        for project in data["projects"]:
            if project["id"] == pid:
                session = {"id": uuid.uuid4().hex[:10], "name": name, "created": time.time()}
                project.setdefault("sessions", []).append(session); data["selectedProject"] = pid; data["selectedSession"] = session["id"]
        save(data)
    elif kind == "select_session":
        data["selectedProject"] = str(payload.get("projectId", "")); data["selectedSession"] = str(payload.get("sessionId", ""))
        selected = next((p for p in data["projects"] if p["id"] == data["selectedProject"]), None)
        if selected and selected.get("folder"): data["settings"]["workdir"] = selected["folder"]
        save(data)
    elif kind == "delete_session":
        sid = str(payload.get("id", ""))
        for project in data["projects"]: project["sessions"] = [s for s in project.get("sessions", []) if s["id"] != sid]
        if data.get("selectedSession") == sid: data["selectedSession"] = ""
        save(data)
    elif kind == "add_skill":
        data["skills"].append({"id": uuid.uuid4().hex[:10], "name": str(payload.get("name", "Skill"))[:80],
                               "instructions": str(payload.get("instructions", ""))[:8000], "enabled": True}); save(data)
    elif kind == "delete_skill":
        data["skills"] = [s for s in data["skills"] if s["id"] != str(payload.get("id", ""))]; save(data)
    elif kind == "add_memory":
        data["memory"].append({"id": uuid.uuid4().hex[:10], "label": str(payload.get("label", "Memory"))[:100],
                               "value": str(payload.get("value", ""))[:4000], "tags": clean_tags(payload.get("tags")),
                               "created": time.time()}); save(data)
    elif kind == "delete_memory":
        data["memory"] = [m for m in data["memory"] if m["id"] != str(payload.get("id", ""))]; save(data)
    elif kind == "edit_memory":
        found = next((m for m in data["memory"] if m["id"] == str(payload.get("id", ""))), None)
        if found is None:
            raise ValueError("memory not found")
        found["label"] = str(payload.get("label", found["label"])).strip()[:100]
        found["value"] = str(payload.get("value", found["value"])).strip()[:4000]
        if "tags" in payload:
            found["tags"] = clean_tags(payload.get("tags"))
        found["updated"] = time.time()
        if not found["label"] or not found["value"]:
            raise ValueError("memory label and value are required")
        save(data)
    else:
        raise ValueError("unknown workspace action")
    return public_state()


def store_upload(filename, content):
    safe = re.sub(r"[^A-Za-z0-9._ -]", "_", pathlib.Path(filename).name).strip(". ")[:140] or "upload.bin"
    UPLOADS.mkdir(exist_ok=True)
    target = UPLOADS / f"{int(time.time())}_{safe}"
    target.write_bytes(content)
    return {"name": safe, "path": str(target), "url": f"/uploads/{target.name}", "size": len(content)}


def uploads():
    if not UPLOADS.exists(): return []
    return [{"name": p.name, "size": p.stat().st_size, "path": str(p), "url": f"/uploads/{p.name}"} for p in sorted(UPLOADS.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True)[:30] if p.is_file()]
