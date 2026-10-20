"""Read-only health bridge for the user's AutoCAD MCP installation."""
from __future__ import annotations
import ctypes, json, os, pathlib, subprocess

MCP_ROOT = pathlib.Path(os.environ.get("ZUZU_AUTOCAD_MCP_ROOT", r"C:\Users\DELL\Documents\Codex\2026-09-24\i-want-you-to-install-configure\work\autocad-mcp"))
PYTHON = MCP_ROOT / ".venv" / "Scripts" / "python.exe"
IPC_DIR = pathlib.Path(os.environ.get("AUTOCAD_MCP_IPC_DIR", str(MCP_ROOT / ".ipc")))
LISP = MCP_ROOT / "lisp-code" / "mcp_dispatch.lsp"
RUNNER = pathlib.Path(__file__).with_name("autocad_runner.py")

def runner_command():
    return f'"{PYTHON}" "{RUNNER}"'

def _autocad_windows():
    if os.name != "nt": return []
    titles, user32 = [], ctypes.windll.user32
    callback = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def visit(hwnd, _):
        if user32.IsWindowVisible(hwnd):
            size = user32.GetWindowTextLengthW(hwnd)
            if size:
                buf = ctypes.create_unicode_buffer(size + 1); user32.GetWindowTextW(hwnd, buf, size + 1)
                if "autocad" in buf.value.lower(): titles.append(buf.value[:180])
        return True
    user32.EnumWindows(callback(visit), 0)
    return titles

def _live_probe():
    script = '''import asyncio, json\nfrom autocad_mcp.client import get_backend\nasync def main():\n b=await get_backend(); init=await b.initialize(); out={"backend":b.name,"connected":bool(init.ok),"detail":init.to_dict()}\n if init.ok:\n  out["drawing"]=(await b.drawing_info()).to_dict(); out["entities"]=(await b.entity_count()).to_dict()\n print(json.dumps(out,ensure_ascii=False))\nasyncio.run(main())'''
    env=os.environ.copy(); env.update({"AUTOCAD_MCP_BACKEND":"file_ipc","AUTOCAD_MCP_IPC_DIR":str(IPC_DIR)})
    run=subprocess.run([str(PYTHON),"-c",script],cwd=MCP_ROOT,env=env,capture_output=True,text=True,timeout=18,check=False)
    lines=[line for line in run.stdout.splitlines() if line.strip().startswith("{")]
    if not lines: return {"connected":False,"error":(run.stderr or "AutoCAD MCP did not return status")[-400:]}
    try: return json.loads(lines[-1])
    except json.JSONDecodeError: return {"connected":False,"error":"AutoCAD MCP returned invalid status"}

def status(live=False):
    windows=_autocad_windows()
    result={"installed":PYTHON.is_file() and LISP.is_file(),"autocad_open":bool(windows),"window":windows[0] if windows else "","backend":"file_ipc","ipc_ready":IPC_DIR.is_dir(),"dispatcher_file":LISP.is_file(),"connected":False,"checked_live":bool(live)}
    if live and result["installed"] and result["autocad_open"]: result.update(_live_probe())
    return result
