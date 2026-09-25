"""Connect this dashboard to the local Hermes API without revealing credentials."""
import os
from pathlib import Path
import secrets

ROOT = Path(__file__).resolve().parent
HERMES_HOME = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))


def entries(path):
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    found = {}
    for line in lines:
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            found[key.strip()] = value.strip().strip('"').strip("'")
    return lines, found


def update(path, values):
    lines, _ = entries(path)
    pending = dict(values)
    output = []
    for line in lines:
        key = line.split("=", 1)[0].strip() if "=" in line and not line.lstrip().startswith("#") else None
        if key in pending:
            output.append(f"{key}={pending.pop(key)}")
        else:
            output.append(line)
    output.extend(f"{key}={value}" for key, value in pending.items())
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".new")
    with temporary.open("w", encoding="utf-8") as target:
        target.write("\n".join(output) + "\n")
        target.flush()
        os.fsync(target.fileno())
    os.replace(temporary, path)


def main():
    dashboard = ROOT / ".env"
    hermes = HERMES_HOME / ".env"
    _, d = entries(dashboard)
    _, h = entries(hermes)
    old_dashboard = d.get("HERMES_API_KEY", "")
    old_hermes = h.get("API_SERVER_KEY", "")
    if old_dashboard and old_hermes and not secrets.compare_digest(old_dashboard, old_hermes):
        raise RuntimeError("Dashboard and Hermes API keys differ; resolve locally without overwriting either credential")
    key = old_hermes or old_dashboard or secrets.token_urlsafe(48)
    update(hermes, {"API_SERVER_ENABLED": "true", "API_SERVER_HOST": "127.0.0.1", "API_SERVER_KEY": key})
    update(dashboard, {"HERMES_API_BASE": "http://127.0.0.1:8642", "HERMES_API_KEY": key})
    print("Hermes API configured on localhost. Restart Hermes gateway and Zuzu to apply it; credentials were not displayed.")


if __name__ == "__main__":
    main()
