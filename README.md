# Zuzu · Hermes Agent Dashboard

A local, voice-enabled Zuzu dashboard for [Hermes Agent](https://github.com/NousResearch/hermes-agent). It is a visual interface over your existing Hermes profile—not a second agent runtime—so it inherits the same tools, skills, memory, browser automation, MCP servers, and third-party integrations.

![Zuzu Hermes dashboard](docs/screenshot.png)

## What you get

- Futuristic browser-based mission-control HUD
- Natural conversational replies with the Zuzu voice persona
- Continuous voice conversation: listen → transcribe → answer → speak → listen
- Optional ElevenLabs speech-to-text and text-to-speech
- Browser speech fallback when ElevenLabs is not configured
- Working command matrix and slash commands
- Hermes session continuity across voice turns
- Separate Hermes transcript per Zuzu project chat, with visible chat history
- Local Hermes API streaming (recommended) with tool progress and real toolsets
- Owner login for the public link and an iPhone dialer / optional AI Calls tab
- Access to the active Hermes profile's tools, skills, browser, memory, and MCP integrations
- Local-only HTTP server bound to `127.0.0.1`


## Correct GitHub repo for the new Zuzu interface

Use this repository for the current Zuzu interface:

<https://github.com/Happy-544/zuzu-hermes-dashboard>

The older upstream repository `Itsme23476/jarvis-hermes-dashboard` still shows the legacy JARVIS layout unless that owner pulls these changes. If you see the old JARVIS screen, you installed the old repo or your browser is serving a cached copy.

## Prerequisites

1. macOS or Linux with Python 3 and a modern Chromium browser.
2. Hermes Agent installed and configured:

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
hermes setup
```

Confirm that `hermes chat -q "Say online"` works before installing the dashboard.

## One-command install

```bash
git clone https://github.com/Happy-544/zuzu-hermes-dashboard.git && \
cd zuzu-hermes-dashboard && \
./install.sh
```

The installer creates a private `.env` file, starts the dashboard, and opens:

<http://127.0.0.1:8730>

On the first local visit, create an owner password of at least 12 characters. Public access remains locked until this is done on the laptop. The installer adds local multilingual speech transcription for voice fallback; browser speech is used only when local transcription is unavailable.

For the recommended Hermes API transport, run `python setup_hermes_api.py` (or `py -3.12 setup_hermes_api.py` on Windows), then restart Hermes Gateway and Zuzu. The script preserves existing `.env` files, sets the API to localhost, and does not display the generated key. Without this setup, Zuzu retains the legacy Hermes CLI fallback.

### Windows install

```powershell
git clone https://github.com/Happy-544/zuzu-hermes-dashboard.git
cd zuzu-hermes-dashboard
.\install.ps1
```

If this PC previously opened the old JARVIS dashboard on the same localhost port, open `http://127.0.0.1:8730/?release=36`, then press Ctrl+F5 once. The service worker clears old shell caches rather than serving a stale interface.

## One-prompt installation with Hermes

Give this prompt to an already-installed Hermes Agent:

> Install and launch the Zuzu dashboard from https://github.com/Happy-544/zuzu-hermes-dashboard. Clone or update it under ~/zuzu-hermes-dashboard, preserve any existing private .env file, run its installer, open the local address to create the owner login, and verify `/api/status` after signing in. Do not print or expose any credentials.

Hermes can perform the clone, setup, launch, and health check with its terminal tools.

## Voice setup

The installer adds local speech transcription. Set `JARVIS_VOICE_MODE=local` in the private `.env` file when Gemini Live has no credits; Zuzu then sends transcribed requests to Hermes and speaks using the browser. The first local voice session downloads the multilingual Whisper base model. When Gemini Live credits are available, `JARVIS_VOICE_MODE=auto` uses the configured native audio model. ElevenLabs can also provide speech transcription and output:

```bash
ELEVENLABS_API_KEY=your_private_key
ELEVENLABS_VOICE_ID=JBFqnCBsd6RMkjVDRZzb
ELEVENLABS_MODEL=eleven_turbo_v2_5
```

Restart the dashboard after editing `.env`. The key stays server-side and is never sent to frontend JavaScript.

## Hermes profile and tools

The dashboard uses the `default` Hermes profile unless overridden:

```bash
HERMES_PROFILE=work ./start.sh
```

If Hermes is installed at a nonstandard location:

```bash
HERMES_CMD="/absolute/path/to/hermes" ./start.sh
```

Third-party applications are connected in Hermes itself—not separately in this dashboard. Typical setup paths are:

```bash
hermes skills browse       # Gmail, Notion, Airtable, Google Workspace, etc.
hermes tools               # built-in toolsets
hermes mcp list            # external MCP servers
hermes gateway setup       # Telegram, Slack, Discord, WhatsApp, etc.
```

After changing Hermes tools or integrations, restart the dashboard or use `/new`.

## Command Matrix

Every button executes its base command immediately. Commands that accept a payload stay armed so the next typed or spoken phrase becomes `/command payload`.

| Command | Action |
|---|---|
| `/new` | Start a fresh Hermes thread |
| `/goal <text\|status\|clear>` | Set, read, or clear the standing objective |
| `/tools` | Run `hermes tools list` |
| `/browser <task>` | Ask Hermes to use its browser/Chrome tools |
| `/background <mission>` | Run a background Hermes mission |
| `/mission [task]` | Read or add to the local mission queue |
| `/personality <tone>` | Read or change the JARVIS tone overlay |
| `/commands` | Show all dashboard commands |
| `/toolsets` | Summarize enabled Hermes toolsets |
| `/connectors` | Explain integration inheritance |
| `/connect <name>` | Request Hermes-native connection guidance |
| `/status` | Show runtime/profile/voice status |

Normal text and voice requests go directly to Hermes Agent.

## Architecture

```text
Browser HUD
  ├─ microphone → browser MediaRecorder → ElevenLabs STT (optional)
  ├─ POST /api/run → Python NDJSON server
  ├─ local Hermes API → native Hermes sessions, model, and tools
  └─ response → ElevenLabs TTS or browser speech synthesis
```

Key files:

```text
server.py       local HTTP API and NDJSON streaming
hermes_api.py   native Hermes API sessions and streamed turns
runtime.py      Hermes CLI fallback for older installations
auth.py         local owner login and secure browser sessions
catalog.py      Hermes skill and plugin registry search
phone_calls.py  optional Vapi phone transport
commands.py     dashboard slash commands and mission queue
voice.py        optional ElevenLabs STT/TTS proxy
persona.md      concise spoken JARVIS persona
ui/             dependency-free HTML/CSS/JavaScript HUD
install.sh      first-run setup and launch
start.sh        local launcher
```

## Security

- The server binds only to `127.0.0.1`; it is not exposed to the network.
- Public access requires an exact `JARVIS_PUBLIC_ORIGIN` and an owner password created locally. The password is stored as a salted scrypt hash, not in the browser or repository.
- Privileged requests require an HttpOnly login session, CSRF token, exact origin and host checks, approved content type, and bounded request size.
- Agent runs are serialized, and each project chat stores its own Hermes session ID.
- Raw prompt logging is disabled unless `JARVIS_RAW_LOG` is explicitly configured; opt-in logs are created with mode `0600` and symlink protection.
- `.env`, state files, Python caches, and local credentials are ignored by Git.
- The dashboard never bundles Google, Zapier, Gmail, ElevenLabs, or Hermes credentials.
- Connected apps remain owned and authenticated by the user's Hermes profile.
- Review third-party skills and MCP servers before installing them.

## Personal assistant features

| Feature | Where | Voice example |
|---|---|---|
| Reminders (English + Egyptian Arabic times, daily/weekly repeats) | My day → Reminders & brief, `/remind` | "Remind me to call mom tomorrow at 6" |
| Daily brief: date, weather, calendar (iCal link), reminders, headlines, optional email | Home → Today, `/brief` | "What's my day like?" |
| Morning/evening briefs and important-email alerts, spoken and on Telegram | My day → Reminders & brief settings | automatic |
| Music (YouTube queue + Open in YouTube Music) and videos | `/music`, `/video`, Smart tools | "Play some Amr Diab", "Show me a video about resin tables" |
| Markets: top 5 most active, watchlist, price alerts (information only) | My day → Markets, Home card | "Tell me when gold goes above 2700" |
| Library: 70,000+ free Project Gutenberg books, read-aloud, spoken briefs | My day → Library | "Find me a book by Dostoevsky" |
| Create images and videos (Gemini API; video is billed by Google) | Work → Files & create | "Make an image of a walnut resin table" |
| Switch the Hermes model | Settings → AI model, `/model claude` | "Switch to Gemini Pro" |
| "Hey Zuzu" wake word / "Zuzu sleep mode" (Chrome/Edge on the laptop) | Reminders & brief settings | "Hey Zuzu" |
| Live PC control: laptop screen opens and each Hermes step is listed while it works | Home → Now | "Open Notepad on my computer" |
| Memory graph (Obsidian-style): notes linked by `[[Title]]`, `#tags`, mentions and smart links; hover focus, local graph, search, backlinks | Brain → Memory | "Remember that my wife loves [[Resin art]] #family" |
| Auto-learn: after every chat or voice turn Zuzu saves new facts about you, updates changed ones (keeps earlier versions), merges duplicates; never stores passwords or card numbers | Brain → Memory → Auto-learn | "I switched to espresso" · "Forget the old car" |
| Draw on the laptop screen: Zuzu points at things, or you draw from your phone | Laptop live → Draw | "Point at the Save button" |
| Skill suggestions: Zuzu finds new Hermes skills; installs only after you approve | Brain → Skills | "Find skills for WhatsApp messages" |

Email is read through the account connected in Hermes (`hermes gateway setup` / email skill); Zuzu never stores email credentials.

## Public link and calls

Use a reserved ngrok hostname and set its exact HTTPS URL in `JARVIS_PUBLIC_ORIGIN`. Point the tunnel only to the local Zuzu port. Random Cloudflare/ngrok hosts are rejected. The login is required on both localhost and the public link.

The Calls tab can open the iPhone dialer immediately with a validated international number. AI calls require `VAPI_API_KEY`, `VAPI_ASSISTANT_ID`, `VAPI_PHONE_NUMBER_ID`, and a Vapi assistant configured with `custom-llm` at `<JARVIS_PUBLIC_ORIGIN>/v1` and a maximum duration of 600 seconds or less. Put its LLM bearer token in `VAPI_LLM_TOKEN`. The LLM relay intentionally requires a **separate Hermes phone profile with restricted toolsets**; set `HERMES_PHONE_API_BASE` to that localhost profile endpoint and `HERMES_PHONE_API_KEY` to its own API key. Never point unauthenticated callers at the computer-control profile. Vapi must route the phone number's inbound calls to this assistant. Until those accounts and the restricted profile are connected, the Calls tab reports AI calling as unavailable and no paid calls are placed.

## Manual start

```bash
cd ~/zuzu-hermes-dashboard
./start.sh
```

To use another port:

```bash
JARVIS_PORT=9000 ./start.sh
```

## Troubleshooting

### Hermes is not found

```bash
which hermes
hermes doctor
```

Then set `HERMES_CMD` in `.env` if needed.

### Microphone does not activate

Allow microphone access for `127.0.0.1` in the browser's site settings. ElevenLabs is optional; without it, use a browser that supports Web Speech APIs.

### iPhone home-screen app and background work

Open the public HTTPS dashboard in Safari, choose **Share → Add to Home Screen**, and launch Zuzu from its icon. The app keeps the screen awake during a foreground voice session, restores Gemini Live after iOS resumes it, and immediately collects completed background missions. Missions run on the home computer, so they continue when the phone app is suspended or closed.

iOS suspends browser microphones and WebSockets after an app is backgrounded or the phone locks; a PWA cannot override that operating-system rule. Zuzu reconnects on return. For mobile app actions, enable **Mobile control**, create an Apple Shortcut containing only the actions you approve, and enter that Shortcut's exact name in Settings. Zuzu passes the typed mobile command to it through Apple's Shortcuts URL scheme.

### A newly connected tool is missing

Start a fresh session after changing Hermes tools:

```bash
hermes tools list
```

Then restart the dashboard and click `/new`.

## Credits and license

Originally inspired by [`Itsme23476/jarvis-os`](https://github.com/Itsme23476/jarvis-os), redesigned and adapted to use Hermes Agent as its runtime. Released under the MIT License; see [LICENSE](LICENSE).
