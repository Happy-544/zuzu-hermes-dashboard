"""Opt-in real Gemini Live -> Hermes -> native audio continuity probe.

Run from the repository with the Hermes Python environment. Uses current
credentials/persona, isolated dashboard state and a new diagnostic Hermes chat.
Prints metrics only, never credentials, transcripts or personal memory.
"""
import asyncio
import base64
import copy
import io
import json
import pathlib
import re
import sys
import tempfile
import time
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import server
import conversations
import workspace
import websockets


def config():
    handler = object.__new__(server.Handler)
    handler.path = "/api/live-token"
    handler.headers = {"Content-Type": "application/json"}
    for name in ("_host_ok", "_origin_ok", "_token_ok", "_csrf_ok"):
        setattr(handler, name, lambda: True)
    handler._read = lambda *_: b'{"project_id":"home","chat_id":"main"}'
    handler._json = lambda body, code=200: (code, body)
    code, body = handler.do_POST()
    if code != 200:
        raise RuntimeError("Live token endpoint failed (details suppressed)")
    return body


def action(request):
    handler = object.__new__(server.Handler)
    handler.wfile = io.BytesIO()
    handler.send_response = handler.send_header = handler.end_headers = lambda *_: None
    handler._stream_run(json.dumps({
        "message": request, "project_id": "home", "chat_id": "main",
        "system": "This is an authorized voice continuity diagnostic. Answer only; do not modify files, memory or accounts.",
    }).encode())
    events = [json.loads(line) for line in handler.wfile.getvalue().splitlines()]
    if any(e["t"] == "error" for e in events) or not any(e["t"] == "complete" for e in events):
        raise RuntimeError("Hermes action failed (details suppressed)")
    return {"result": "".join(e.get("text", "") for e in events if e["t"] == "delta"),
            "instruction": "Tell the user this actual result in your saved persona and Egyptian Arabic, then keep listening."}


async def connect():
    cfg = await asyncio.to_thread(config)
    ws = await websockets.connect(
        "wss://generativelanguage.googleapis.com/ws/"
        "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained"
        "?access_token=" + cfg["token"], max_size=8 * 1024 * 1024)
    await ws.send(json.dumps({"setup": {
        "model": "models/" + cfg["model"],
        "generationConfig": {"responseModalities": ["AUDIO"], "thinkingConfig": {"thinkingBudget": 0},
                             "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": cfg["voice"]}}}},
        "inputAudioTranscription": {}, "outputAudioTranscription": {},
        "tools": cfg["tools"], "systemInstruction": {"parts": [{"text": cfg["system"]}]},
    }}))
    msg = json.loads(await asyncio.wait_for(ws.recv(), 25))
    if "setupComplete" not in msg:
        raise RuntimeError("Gemini setup rejected")
    return ws, cfg


async def turn(ws, text):
    start = time.monotonic()
    await ws.send(json.dumps({"clientContent": {"turns": [{"role": "user", "parts": [{"text": text}]}],
                                               "turnComplete": True}}))
    transcript, audio_bytes, first_audio, calls = "", 0, None, []
    while True:
        msg = json.loads(await asyncio.wait_for(ws.recv(), 60))
        for call in msg.get("toolCall", {}).get("functionCalls", []):
            calls.append(call["name"])
            if call["name"] == "get_conversation_status":
                response = {"actions": [{"state": run["state"], "result": run["answer"], "detail": run["detail"]}
                                        for run in conversations.runs("home", "main")[:4]],
                            "instruction": "Report these saved outcomes; never repeat the action."}
            elif call["name"] != "hermes_action":
                response = {"error": "Diagnostic permits only the requested read-only Hermes question."}
            else:
                response = await asyncio.to_thread(action, call["args"]["request"])
            await ws.send(json.dumps({"toolResponse": {"functionResponses": [
                {"id": call["id"], "name": call["name"], "response": response}]}}))
        content = msg.get("serverContent", {})
        transcript += content.get("outputTranscription", {}).get("text", "")
        for part in content.get("modelTurn", {}).get("parts", []):
            data = part.get("inlineData", {}).get("data")
            if data:
                audio_bytes += len(base64.b64decode(data))
                if first_audio is None:
                    first_audio = round(time.monotonic() - start, 2)
        if content.get("turnComplete"):
            break
    conversations.add("home", "main", "user", text, "voice")
    conversations.add("home", "main", "assistant", transcript, "voice")
    print(json.dumps({"first_audio_seconds": first_audio, "audio_bytes": audio_bytes,
                      "arabic": bool(re.search("[\u0600-\u06ff]", transcript)), "tools": calls}), flush=True)
    if not audio_bytes:
        raise RuntimeError("No native audio returned")
    return transcript, calls


async def main():
    original = workspace.load()
    with tempfile.TemporaryDirectory(prefix="zuzu-live-check-") as folder, \
            mock.patch.object(workspace, "FILE", pathlib.Path(folder) / "workspace.json"):
        state = copy.deepcopy(workspace.DEFAULT)
        state["settings"] = original["settings"]
        state["memory"] = original.get("memory", [])
        workspace.save(state)
        ws, cfg = await connect()
        print(json.dumps({"native_model": cfg["model"], "voice": cfg["voice"],
                          "saved_persona_in_prompt": original["settings"]["persona"][:1600] in cfg["system"]}), flush=True)
        try:
            await turn(ws, "هنعمل اختبار قصير. افتكري الكود التجريبي CEDAR-482 في المحادثة دي بس. ردي عليا جملة قصيرة بالمصري من غير أدوات.")
            result, calls = await turn(ws, "ابعتي لهيرمس باستخدام hermes_action سؤال الاختبار ده: احسب 17 في 23، ورد بالناتج فقط، من غير ما تعمل أي تغيير أو تستخدم أدوات. لما يرد قوليلي النتيجة بالمصري ونكمل كلامنا.")
            if calls.count("hermes_action") != 1 or not re.search("391|٣٩١|تلتمية|ثلاثم|تلاتمية", result):
                raise RuntimeError("Expected one Hermes action and its spoken arithmetic result")
            remembered, _ = await turn(ws, "فاكرة الكود التجريبي اللي قلتلك عليه قبل سؤال هيرمس؟ قوليه من غير أدوات.")
            if "482" not in remembered and "٤٨٢" not in remembered:
                raise RuntimeError("Same-call context check failed")
            print('{"same_call_action_and_context":true}', flush=True)
        finally:
            await ws.close()
        ws, _ = await connect()
        try:
            remembered, _ = await turn(ws, "كملي نفس المحادثة: إيه الكود التجريبي اللي قلتهولك؟ قوليه من غير أدوات.")
            if "482" not in remembered and "٤٨٢" not in remembered:
                raise RuntimeError("Reconnected context check failed")
            print('{"reconnected_context":true}', flush=True)
        finally:
            await ws.close()


if __name__ == "__main__":
    try:
        asyncio.run(asyncio.wait_for(main(), 240))
    except Exception as error:
        # Exceptions may contain credential-bearing URLs; do not print them.
        print(json.dumps({"probe_failed": type(error).__name__,
                          "reason": str(error) if type(error) is RuntimeError else "Transport failure; details suppressed"}))
        sys.exit(1)
