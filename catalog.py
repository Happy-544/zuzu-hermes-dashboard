"""Real Hermes skill registry search and audited installation."""
import json
import re
import subprocess

import runtime

SOURCES = {"all", "official", "skills-sh", "well-known", "github", "clawhub",
           "lobehub", "browse-sh", "nvidia", "openai", "anthropic", "huggingface",
           "voltagent", "gstack", "minimax"}


def search(query, source="all"):
    query = str(query or "").strip()
    if not 2 <= len(query) <= 100:
        raise ValueError("Search for at least 2 characters")
    if source not in SOURCES:
        raise ValueError("Unknown skill source")
    command = runtime._hermes_base() + ["skills", "search", query, "--source", source,
                                        "--limit", "15", "--json"]
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8",
                            errors="replace", timeout=45, cwd=runtime.WORKDIR)
    if result.returncode:
        raise RuntimeError("Hermes skill search failed")
    items = json.loads(result.stdout)
    if not isinstance(items, list):
        raise RuntimeError("Hermes returned an invalid skill catalogue")
    skills = [{"kind": "skill", "name": x.get("name", ""), "identifier": x.get("identifier", ""),
             "source": x.get("source", ""), "trust_level": x.get("trust_level", ""),
             "description": x.get("description", "")}
            for x in items if isinstance(x, dict) and x.get("identifier")]
    if source not in {"all", "github"}:
        return skills
    result = subprocess.run(runtime._hermes_base() + ["plugins", "search", query, "--json"],
                            capture_output=True, text=True, encoding="utf-8",
                            errors="replace", timeout=45, cwd=runtime.WORKDIR)
    if result.returncode:
        return skills
    plugin_data = json.loads(result.stdout)
    plugins = plugin_data.get("results", []) if isinstance(plugin_data, dict) else []
    return skills + [{"kind": "plugin", "name": x.get("name", ""),
                      "identifier": x.get("repo", ""), "source": "Hermes plugins / GitHub",
                      "trust_level": x.get("tier", ""), "description": x.get("description", "")}
                     for x in plugins if isinstance(x, dict) and x.get("repo")]


def install(identifier, kind="skill"):
    identifier = str(identifier or "").strip()
    if kind not in {"skill", "plugin"}:
        raise ValueError("Unknown catalogue item type")
    if not re.fullmatch(r"[A-Za-z0-9._/@:-]{3,200}", identifier) or ".." in identifier:
        raise ValueError("Invalid skill identifier")
    command = (["skills", "install", identifier, "--yes"] if kind == "skill"
               else ["plugins", "install", identifier, "--no-enable"])
    result = subprocess.run(runtime._hermes_base() + command,
                            capture_output=True, text=True, encoding="utf-8", errors="replace",
                            timeout=120, cwd=runtime.WORKDIR)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout or "Skill installation failed")[:400])
    return {"installed": True, "identifier": identifier, "kind": kind,
            "detail": (result.stdout or "Installed by Hermes")[-500:]}
