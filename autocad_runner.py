"""Small CLI used by Hermes' terminal tool to call the installed AutoCAD MCP.

Usage: <mcp-python> autocad_runner.py TOOL OPERATION [JSON_DATA] [--screenshot]
Also supports: <mcp-python> autocad_runner.py batch run '{"ops": [{"tool": "layer", "operation": "create", "data": {...}}, ...]}'
The unrestricted execute_lisp operation is deliberately rejected here.
"""
from __future__ import annotations
import asyncio, json, os, pathlib, sys

MCP_ROOT = pathlib.Path(os.environ.get("ZUZU_AUTOCAD_MCP_ROOT", r"C:\Users\DELL\Documents\Codex\2026-09-24\i-want-you-to-install-configure\work\autocad-mcp"))
# Prefer the live AutoCAD window, but use the installed ezdxf headless backend
# when LT is unavailable or its license prevents the UI from opening.
os.environ.setdefault("AUTOCAD_MCP_BACKEND", "auto")
IPC_DIR = pathlib.Path(os.environ.get("AUTOCAD_MCP_IPC_DIR", str(MCP_ROOT / ".ipc")))
os.environ.setdefault("AUTOCAD_MCP_IPC_DIR", str(IPC_DIR))
STATE_FILE = IPC_DIR / "zuzu_active_drawing.json"
sys.path.insert(0, str(MCP_ROOT / "src"))

ALLOWED_TOOLS = {"drawing", "entity", "layer", "block", "annotation", "pid", "view", "system", "batch"}


def _load_active_path() -> str:
    try:
        return str(json.loads(STATE_FILE.read_text(encoding="utf-8")).get("path") or "").strip()
    except (OSError, ValueError):
        return ""


def _save_active_path(path: str) -> None:
    if not path:
        return
    try:
        IPC_DIR.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps({"path": str(path)}), encoding="utf-8")
    except OSError:
        pass


async def _run_single(server_mod, tool: str, operation: str, data: dict, screenshot: bool):
    if tool not in {"drawing", "entity", "layer", "block", "annotation", "pid", "view", "system"}:
        raise SystemExit("unsupported AutoCAD MCP tool")
    if tool == "system" and operation == "execute_lisp":
        raise SystemExit("execute_lisp is not available through the Zuzu runner")
    if tool == "drawing" and operation in {"open", "save", "save_as", "create"}:
        target = data.get("path") or data.get("file_path") or data.get("filename")
        if target:
            _save_active_path(str(target))
    result = await getattr(server_mod, tool)(operation=operation, data=data, include_screenshot=screenshot)
    return result


async def main():
    if len(sys.argv) < 3:
        raise SystemExit("usage: autocad_runner.py TOOL OPERATION [JSON_DATA] [--screenshot]")
    tool, operation = sys.argv[1].lower(), sys.argv[2].lower()
    if tool not in ALLOWED_TOOLS:
        raise SystemExit("unsupported AutoCAD MCP tool")
    if tool == "system" and operation == "execute_lisp":
        raise SystemExit("execute_lisp is not available through the Zuzu runner")
    data = json.loads(sys.argv[3]) if len(sys.argv) > 3 and not sys.argv[3].startswith("--") else {}
    if not isinstance(data, dict):
        raise SystemExit("JSON_DATA must be an object")
    screenshot = "--screenshot" in sys.argv[3:]
    from autocad_mcp import server

    active_path = _load_active_path()
    if active_path and os.path.exists(active_path) and not (tool == "drawing" and operation in {"open", "create"}):
        try:
            await server.drawing(operation="open", data={"path": active_path}, include_screenshot=False)
        except Exception:
            pass

    if tool == "batch":
        ops = data.get("ops") or data.get("operations") or []
        results = []
        for index, item in enumerate(ops):
            if not isinstance(item, dict):
                continue
            op_tool = str(item.get("tool", "")).lower()
            op_name = str(item.get("operation", "")).lower()
            op_data = item.get("data") if isinstance(item.get("data"), dict) else {}
            op_shot = bool(item.get("screenshot")) or (screenshot and index == len(ops) - 1)
            res = await _run_single(server, op_tool, op_name, op_data, op_shot)
            results.append({"step": index + 1, "tool": op_tool, "operation": op_name, "result": res})
        save_path = data.get("save_path") or data.get("path") or active_path
        if save_path:
            _save_active_path(str(save_path))
            try:
                await server.drawing(operation="save", data={"path": str(save_path)}, include_screenshot=False)
            except Exception:
                pass
        print(json.dumps({"ok": True, "count": len(results), "results": results}, ensure_ascii=False, default=str))
        return

    result = await _run_single(server, tool, operation, data, screenshot)
    if active_path and tool in {"entity", "layer", "block", "annotation", "pid"}:
        try:
            await server.drawing(operation="save", data={"path": active_path}, include_screenshot=False)
        except Exception:
            pass
    print(result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, default=str))

if __name__ == "__main__":
    asyncio.run(main())
