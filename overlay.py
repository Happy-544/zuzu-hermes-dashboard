"""Zuzu's on-screen pointer: a transparent, click-through, always-on-top layer over the
whole Windows desktop. Zuzu draws arrows, circles, freehand strokes and labels on it to
show you things; your mouse and keyboard keep working underneath.

Run by the dashboard server; it reads one JSON command per line on stdin. Coordinates are
normalised 0..1 over the full virtual desktop (all monitors), matching the screenshot.
    {"type": "arrow", "x1": .., "y1": .., "x2": .., "y2": .., "label": "Save button"}
    {"type": "circle", "x": .., "y": .., "r": 0.03}
    {"type": "path", "points": [[x, y], ...]}
    {"type": "clear"}
Shapes fade after "ttl" seconds (default 8).
"""
import json
import os
import queue
import sys
import threading

COLOR = "#ffad35"
GLOW = "#6b3a07"
KEY = "#010203"          # painted as fully transparent on Windows


def to_pixels(nx, ny, bounds):
    """Map normalised desktop coordinates to canvas pixels."""
    x, y, w, h = bounds
    nx = min(1.0, max(0.0, float(nx)))
    ny = min(1.0, max(0.0, float(ny)))
    return round(nx * w), round(ny * h)


def arrow_from(target_x, target_y, length=0.09):
    """Pick a start point so the arrow points at the target from the emptier side."""
    sx = target_x - length if target_x > 0.5 else target_x + length
    sy = target_y + length if target_y < 0.5 else target_y - length
    return min(0.98, max(0.02, sx)), min(0.98, max(0.02, sy))


def virtual_screen(root):
    if os.name == "nt":
        import ctypes
        user32 = ctypes.windll.user32
        return (user32.GetSystemMetrics(76), user32.GetSystemMetrics(77),
                user32.GetSystemMetrics(78), user32.GetSystemMetrics(79))
    return 0, 0, root.winfo_screenwidth(), root.winfo_screenheight()


def make_click_through(root):
    if os.name != "nt":
        return
    import ctypes
    hwnd = ctypes.windll.user32.GetParent(root.winfo_id())
    style = ctypes.windll.user32.GetWindowLongW(hwnd, -20)
    # WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE
    ctypes.windll.user32.SetWindowLongW(hwnd, -20, style | 0x80000 | 0x20 | 0x80 | 0x08000000)


def main():
    if os.name == "nt":
        import ctypes
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:  # noqa: BLE001
            ctypes.windll.user32.SetProcessDPIAware()
    import tkinter as tk

    root = tk.Tk()
    root.overrideredirect(True)
    root.attributes("-topmost", True)
    root.configure(bg=KEY)
    if os.name == "nt":
        root.attributes("-transparentcolor", KEY)
    bounds = virtual_screen(root)
    root.geometry(f"{bounds[2]}x{bounds[3]}+{bounds[0]}+{bounds[1]}")
    canvas = tk.Canvas(root, bg=KEY, highlightthickness=0, bd=0)
    canvas.pack(fill="both", expand=True)
    root.update_idletasks()
    make_click_through(root)
    commands = queue.Queue()

    def read_stdin():
        for line in sys.stdin:
            try:
                commands.put(json.loads(line))
            except ValueError:
                continue
        commands.put({"type": "quit"})

    threading.Thread(target=read_stdin, daemon=True).start()

    def draw(cmd):
        kind = cmd.get("type")
        if kind == "quit":
            root.destroy()
            return
        if kind == "clear":
            canvas.delete("all")
            return
        tag = f"s{id(cmd)}"
        width = max(3, round(bounds[2] / 320))
        if kind == "arrow":
            x1, y1 = to_pixels(cmd["x1"], cmd["y1"], bounds)
            x2, y2 = to_pixels(cmd["x2"], cmd["y2"], bounds)
            shape = (width * 5, width * 6, width * 2)
            canvas.create_line(x1, y1, x2, y2, fill=GLOW, width=width + 6, arrow="last", arrowshape=shape, capstyle="round", tags=tag)
            canvas.create_line(x1, y1, x2, y2, fill=COLOR, width=width, arrow="last", arrowshape=shape, capstyle="round", tags=tag)
            if cmd.get("label"):
                tid = canvas.create_text(x1, y1 - width * 5, text=str(cmd["label"])[:60], fill="#fff4dc",
                                         font=("Segoe UI", max(12, width * 4), "bold"), tags=tag)
                bx = canvas.bbox(tid)
                canvas.create_rectangle(bx[0] - 10, bx[1] - 6, bx[2] + 10, bx[3] + 6, fill="#20140a", outline=COLOR, width=2, tags=tag)
                canvas.tag_raise(tid)
        elif kind == "circle":
            x, y = to_pixels(cmd["x"], cmd["y"], bounds)
            r = round(float(cmd.get("r", 0.03)) * bounds[2])
            canvas.create_oval(x - r, y - r, x + r, y + r, outline=GLOW, width=width + 6, tags=tag)
            canvas.create_oval(x - r, y - r, x + r, y + r, outline=COLOR, width=width, tags=tag)
        elif kind == "path":
            pts = [c for p in cmd.get("points", [])[:2000] for c in to_pixels(p[0], p[1], bounds)]
            if len(pts) >= 4:
                canvas.create_line(*pts, fill=cmd.get("color", COLOR), width=width, smooth=True, capstyle="round", joinstyle="round", tags=tag)
        ttl = float(cmd.get("ttl", 8))
        if ttl > 0:
            root.after(int(ttl * 1000), lambda: canvas.delete(tag))

    def pump():
        while not commands.empty():
            draw(commands.get())
        root.lift()
        root.after(40, pump)

    root.after(40, pump)
    root.mainloop()


if __name__ == "__main__":
    main()
