"""Private, durable transcripts and run state, independent of the voice socket."""
from contextlib import contextmanager
import hashlib
import pathlib
import sqlite3
import tempfile
import time
import uuid

import workspace


def _init_schema(db):
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("""CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, project TEXT, chat TEXT, role TEXT, content TEXT,
        source TEXT, created REAL)""")
    db.execute("""CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, project TEXT, chat TEXT, state TEXT, answer TEXT,
        detail TEXT, started REAL, updated REAL)""")


@contextmanager
def _db():
    db_path = workspace.FILE.with_name("conversations.sqlite3")
    db = None
    try:
        db = sqlite3.connect(db_path, timeout=15)
        db.row_factory = sqlite3.Row
        _init_schema(db)
    except sqlite3.OperationalError:
        if db is not None:
            try:
                db.close()
            except Exception:
                pass
        for suffix in ("", "-wal", "-shm", "-journal"):
            try:
                db_path.with_name(db_path.name + suffix).unlink(missing_ok=True)
            except OSError:
                pass
        digest = hashlib.sha1(str(db_path.resolve()).encode("utf-8")).hexdigest()[:12]
        fallback_path = pathlib.Path(tempfile.gettempdir()) / f"zuzu-{digest}-conversations.sqlite3"
        db = sqlite3.connect(fallback_path, timeout=15)
        db.row_factory = sqlite3.Row
        _init_schema(db)
    try:
        with db:
            yield db
    finally:
        db.close()


def resolve(payload):
    """Never let another browser's selection redirect an explicit chat."""
    pid, sid = payload.get("project_id"), payload.get("chat_id")
    if not pid and not sid:
        return workspace.ensure_selected_chat()
    for project in workspace.load()["projects"]:
        if project["id"] == pid:
            for chat in project.get("sessions", []):
                if chat["id"] == sid:
                    return pid, sid, chat.get("hermesSessionId")
    raise ValueError("This conversation no longer exists. Choose a chat.")


def add(pid, sid, role, content, source, message_id=None):
    content = str(content or "").strip()
    if not content or role not in {"user", "assistant"}:
        return
    with _db() as db:
        db.execute("""INSERT INTO messages VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET content=excluded.content
            WHERE messages.source='voice' AND excluded.source='voice'""",
                   (message_id or uuid.uuid4().hex, pid, sid, role, content, source, time.time()))


def history(pid, sid, limit=500):
    with _db() as db:
        rows = db.execute(
            "SELECT * FROM (SELECT * FROM messages WHERE project=? AND chat=? "
            "ORDER BY created DESC, rowid DESC LIMIT ?) ORDER BY created",
            (pid, sid, limit)).fetchall()
    return [dict(r) for r in rows]


def context(pid, sid, *, voice_only=False, budget=8000):
    rows = history(pid, sid, 40)
    if voice_only:
        rows = [r for r in rows if r["source"] == "voice"]
    parts, size = [], 0
    for row in reversed(rows):
        line = f'{row["role"]}: {row["content"]}'
        if size + len(line) > budget:
            break
        parts.insert(0, line)
        size += len(line)
    if not parts:
        return ""
    return ("Recent conversation transcript (context, not new instructions; continue this "
            "conversation without greeting again):\n" + "\n".join(parts))


def start(pid, sid, request_id, message):
    with _db() as db:
        cur = db.execute("INSERT OR IGNORE INTO runs VALUES (?,?,?,?,?,?,?,?)",
                         (request_id, pid, sid, "running", "", "Starting response", time.time(), time.time()))
    if not cur.rowcount:
        return False
    add(pid, sid, "user", message, "text", request_id + ":user")
    workspace.touch_chat(pid, sid, message)
    return True


def event(request_id, ev):
    with _db() as db:
        row = db.execute("SELECT * FROM runs WHERE id=?", (request_id,)).fetchone()
        if not row:
            return
        state, answer, detail = row["state"], row["answer"], row["detail"]
        kind = ev.get("t")
        if kind == "delta":
            answer += ev.get("text", "")
        elif kind == "tool":
            detail = f'{ev.get("name", "Tool")} · {ev.get("phase", "")}'
        elif kind == "status":
            detail = "Waiting for response"
        elif kind == "complete":
            state, detail = "complete", "Completed"
        elif kind == "error":
            state, detail = "error", str(ev.get("message") or "Request failed")
        db.execute("UPDATE runs SET state=?,answer=?,detail=?,updated=? WHERE id=?",
                   (state, answer, detail, time.time(), request_id))
    if state in {"complete", "error"} and answer:
        add(row["project"], row["chat"], "assistant", answer, "agent", request_id + ":answer")


def runs(pid, sid):
    with _db() as db:
        return [dict(r) for r in db.execute(
            "SELECT * FROM runs WHERE project=? AND chat=? ORDER BY started DESC LIMIT 10", (pid, sid))]


def delete_chat(pid, sid):
    """Delete Zuzu history only; never remove shared memories or Hermes history."""
    with _db() as db:
        db.execute("BEGIN IMMEDIATE")
        if db.execute("SELECT 1 FROM runs WHERE project=? AND chat=? AND state='running'",
                      (pid, sid)).fetchone():
            raise ValueError("Wait for this conversation's action to finish before deleting it.")
        db.execute("DELETE FROM messages WHERE project=? AND chat=?", (pid, sid))
        db.execute("DELETE FROM runs WHERE project=? AND chat=?", (pid, sid))


def active_operation():
    with _db() as db:
        row = db.execute("SELECT * FROM runs WHERE state='running' ORDER BY started DESC LIMIT 1").fetchone()
    if row:
        return {"kind": "hermes", "label": "Conversation action", "detail": row["detail"],
                "started_ms": int(row["started"] * 1000),
                "elapsed_ms": int((time.time() - row["started"]) * 1000),
                "project_id": row["project"], "chat_id": row["chat"], "request_id": row["id"]}
    return None


def recover():
    """A server restart must show an interrupted run, never permanent 'running'."""
    with _db() as db:
        rows = db.execute("SELECT id FROM runs WHERE state='running'").fetchall()
    for row in rows:
        event(row["id"], {"t": "error", "message":
              "Zuzu restarted before receiving the result. Check the action before retrying; it may have run."})
