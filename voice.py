"""
Text to speech.

ElevenLabs when a key is present, browser speechSynthesis otherwise.

The key stays here, server-side. The browser asks /api/speak for audio and gets
mp3 bytes back — it never sees the key, so nothing leaks into devtools, the
page source, or a screen recording.
"""
import json
import os
import urllib.error
import urllib.request
import base64
import wave
from io import BytesIO

from runtime import gemini_api_key

# Rachel — calm, British-adjacent. Override with ELEVENLABS_VOICE_ID.
DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM"
MODEL = os.environ.get("ELEVENLABS_MODEL", "eleven_turbo_v2_5")
GEMINI_TTS_MODEL = os.environ.get("GEMINI_TTS_MODEL", "gemini-2.5-flash-preview-tts")
GEMINI_TTS_VOICE = os.environ.get("GEMINI_TTS_VOICE", "Kore")


def available():
    return tts_available()


def tts_provider():
    if gemini_api_key():
        return "gemini"
    if os.environ.get("ELEVENLABS_API_KEY"):
        return "elevenlabs"
    return "browser"


def tts_available():
    return tts_provider() != "browser"


def stt_available():
    return bool(os.environ.get("ELEVENLABS_API_KEY"))


def voice_id():
    if tts_provider() == "gemini":
        return GEMINI_TTS_VOICE
    return os.environ.get("ELEVENLABS_VOICE_ID", DEFAULT_VOICE)


def content_type():
    return "audio/wav" if tts_provider() == "gemini" else "audio/mpeg"


def _gemini_speak(text):
    prompt = f"Read this warmly, calmly, and naturally as JARVIS: {text[:2500]}"
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": GEMINI_TTS_VOICE}}},
        },
    }
    url = ("https://generativelanguage.googleapis.com/v1beta/models/"
           f"{GEMINI_TTS_MODEL}:generateContent?key={gemini_api_key()}")
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST",
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as response:
        data = json.loads(response.read())
    parts = (data.get("candidates") or [{}])[0].get("content", {}).get("parts", [])
    inline = next((part.get("inlineData") or part.get("inline_data") for part in parts if part.get("inlineData") or part.get("inline_data")), None)
    if not inline or not inline.get("data"):
        raise RuntimeError("Gemini TTS returned no audio")
    pcm = base64.b64decode(inline["data"])
    output = BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24000)
        wav.writeframes(pcm)
    return output.getvalue()


def speak(text):
    """Returns mp3 bytes, or raises. Caller decides what to do on failure."""
    if not tts_available():
        raise RuntimeError("no text-to-speech provider configured")
    text = (text or "").strip()
    if not text:
        raise ValueError("empty text")

    if tts_provider() == "gemini":
        return _gemini_speak(text)

    req = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id()}",
        data=json.dumps({
            "text": text[:2500],
            "model_id": MODEL,
            "voice_settings": {
                "stability": 0.42,          # a little variation; 0.5+ goes flat
                "similarity_boost": 0.85,
                "style": 0.25,
                "use_speaker_boost": True,
            },
        }).encode(),
        method="POST",
        headers={
            "content-type": "application/json",
            "accept": "audio/mpeg",
            "xi-api-key": os.environ["ELEVENLABS_API_KEY"],
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def transcribe(audio, mime="audio/webm"):
    """Speech to text via ElevenLabs Scribe. Returns the transcript, or raises.

    Used instead of the browser's Web Speech API because that one only exists in
    Chrome and is a silently-failing stub in Brave — and because it ships your
    audio to Google. This keeps listening on the same provider as speaking.
    """
    if not stt_available():
        raise RuntimeError("no ELEVENLABS_API_KEY")
    if not audio:
        raise ValueError("empty audio")

    ext = {"audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "mp4",
           "audio/mpeg": "mp3", "audio/wav": "wav"}.get(mime.split(";")[0], "webm")
    boundary = "----jarvis" + os.urandom(8).hex()
    b = boundary.encode()

    body = b"".join([
        b"--", b, b"\r\n",
        b'Content-Disposition: form-data; name="model_id"\r\n\r\nscribe_v1\r\n',
        b"--", b, b"\r\n",
        f'Content-Disposition: form-data; name="file"; filename="turn.{ext}"\r\n'.encode(),
        f"Content-Type: {mime}\r\n\r\n".encode(),
        audio, b"\r\n",
        b"--", b, b"--\r\n",
    ])

    req = urllib.request.Request(
        "https://api.elevenlabs.io/v1/speech-to-text",
        data=body, method="POST",
        headers={
            "content-type": f"multipart/form-data; boundary={boundary}",
            "xi-api-key": os.environ["ELEVENLABS_API_KEY"],
        },
    )
    with urllib.request.urlopen(req, timeout=45) as r:
        return (json.loads(r.read()).get("text") or "").strip()


def voices():
    """List the account's voices, so you can find an id to put in .env."""
    if not stt_available():
        return []
    req = urllib.request.Request(
        "https://api.elevenlabs.io/v2/voices",
        headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"]},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            body = json.loads(r.read())
    except Exception:                                  # noqa: BLE001
        return []
    return [dict(id=v.get("voice_id"), name=v.get("name"),
                 labels=v.get("labels", {}))
            for v in body.get("voices", [])]
