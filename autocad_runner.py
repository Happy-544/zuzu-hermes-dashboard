"""Small CLI used by Hermes' terminal tool to call the installed AutoCAD MCP.

Usage: <mcp-python> autocad_runner.py drawing info '{}'
The unrestricted execute_lisp operation is deliberately rejected here.
"""
from __future__ import annotations
import asyncio, json, os, pathlib, sys

MCP_ROOT = pathlib.Path(os.environ.get("ZUZU_AUTOCAD_MCP_ROOT", r"C:\Users\DELL\Documents\Codex\2026-09-24\i-want-you-to-install-configure\work\autocad-mcp"))
# Prefer the live AutoCAD window, but use the installed ezdxf headless backend
# when LT is unavailable or its license prevents the UI from opening.
os.environ.setdefault("AUTOCAD_MCP_BACKEND", "auto")
os.environ.setdefault("AUTOCAD_MCP_IPC_DIR", str(MCP_ROOT / ".ipc"))
sys.path.insert(0, str(MCP_ROOT / "src"))

async def main():
    if len(sys.argv) < 3:
        raise SystemExit("usage: autocad_runner.py TOOL OPERATION [JSON_DATA] [--screenshot]")
    tool, operation = sys.argv[1].lower(), sys.argv[2].lower()
    if tool not in {"drawing", "entity", "layer", "block", "annotation", "pid", "view", "system"}:
        raise SystemExit("unsupported AutoCAD MCP tool")
    if tool == "system" and operation == "execute_lisp":
        raise SystemExit("execute_lisp is not available through the Zuzu runner")
    data = json.loads(sys.argv[3]) if len(sys.argv) > 3 and not sys.argv[3].startswith("--") else {}
    if not isinstance(data, dict): raise SystemExit("JSON_DATA must be an object")
    screenshot = "--screenshot" in sys.argv[3:]
    from autocad_mcp import server
    result = await getattr(server, tool)(operation=operation, data=data, include_screenshot=screenshot)
    print(result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, default=str))

if __name__ == "__main__":
    asyncio.run(main())
