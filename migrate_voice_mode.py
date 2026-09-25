"""Upgrade the old emergency local-voice fallback without exposing secrets."""
import os
import pathlib
import tempfile


def migrate(path):
    path = pathlib.Path(path)
    if not path.exists():
        return False
    lines = path.read_text(encoding="utf-8").splitlines()
    values = {}
    for line in lines:
        if line and not line.lstrip().startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    has_gemini = bool(values.get("GEMINI_API_KEY") or values.get("GEMINI_CONFIG_PATH"))
    if values.get("JARVIS_VOICE_MODE", "").lower() != "local" or not has_gemini:
        return False
    updated = ["JARVIS_VOICE_MODE=auto" if line.strip().startswith("JARVIS_VOICE_MODE=") else line
               for line in lines]
    fd, temporary = tempfile.mkstemp(prefix=".zuzu-env-", dir=path.parent, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as output:
            output.write("\n".join(updated) + "\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return True


if __name__ == "__main__":
    changed = migrate(pathlib.Path(__file__).resolve().parent / ".env")
    print("Enabled Gemini Live voice for this upgraded Zuzu installation." if changed
          else "Voice configuration preserved.")
