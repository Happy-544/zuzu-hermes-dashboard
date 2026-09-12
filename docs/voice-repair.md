# Native voice and Hermes actions

Release 11 restores native Gemini Live audio. Release 10 discarded that audio,
waited for the Live turn to finish, ran a Hermes text turn, then called a separate
TTS model. That added serial latency and changed the voice.

Live now handles conversation and calls `hermes_action` for computer and other
tool requests. The bridge returns the actual backend result to the same Live
session. Backend results are never separately spoken while Live is connected.
Call IDs prevent duplicate execution; cancellation suppresses late results.
Typed messages while Live is connected go to that same session.

The saved voice is loaded at startup and on Live connection. Arabic speech is
instructed to use Egyptian Arabic and Arabic script. The browser STT fallback
also uses ar-EG. The requested Native Audio model is unchanged.

## Provider routing finding

The installed Hermes custom resolver ignores OPENAI_BASE_URL. Historical JARVIS
sessions advertised gemini-2.5-flash but recorded the OpenRouter billing host.
The integration now uses the native Google resolver with the shared Google key
in the child environment. UTF-8 decoding and Windows PATH separators are explicit.
The active Hermes profile option no longer displays the dashboard Gemini model.

A direct Google request with the current key returned HTTP 404 for
gemini-2.5-flash. This is an account/model availability blocker, not a successful
connection. No alternate model is selected automatically. A requested success
phrase is not evidence that a computer action happened.

## Verification

- 15 Python regression tests; three behavioral Node bridge tests; JS syntax check.
- Native Audio setup accepted the bridge tool and thinking budget 0.
- Two live probes returned Arabic transcription plus PCM audio. Time to first
  audio: 2.062 seconds (Kore), 4.094 seconds (restored Aoede). These used text input,
  so they do not measure microphone end-of-speech detection or mobile latency.
- A Paint request generated hermes_action in each Live probe. The diagnostic
  returned an explicit non-execution result; it did not fake a successful action.
- A separate existing-profile Hermes diagnostic recorded real computer_use calls,
  but failed to open Paint. Its vision_analyze call returned 404. A subsequent
  keyboard diagnostic stalled and was stopped. Full desktop control remains
  unverified pending a working inference/vision configuration.
- The browser loaded release 11 without JavaScript errors.

`tests/smoke_live.py` reproduces the voice/API test using a short-lived token from
the local dashboard. Its generated WAV is ignored by Git. It prints no credentials
or stored persona/memory.
