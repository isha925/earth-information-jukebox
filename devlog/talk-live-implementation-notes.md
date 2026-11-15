# Talk → Gemini Live implementation notes

## Spec summary

Talk is broken on Chrome SpeechRecognition (`network`). Fix by making Talk use free-tier Gemini Live duplex as the primary mic path, with NASA tool grounding. Typed Ask stays.

## Plan

See coordinator store `internal/talk-live-plan.md`.

## Decisions / deviations / tradeoffs

- Prefer Live as **Talk itself**, not a second “Live duplex” button — one CTA for judges / VI users.
- Model pin: `gemini-2.5-flash-native-audio-latest` (verified audio on free key via raw WS; `@google/genai` live.connect 404’d on dated IDs).
- Keep `live-proxy.js` separate from `server.js` to limit blast radius.
- Chrome SpeechRecognition remains last-resort fallback only; `network` error copy points back to Live/Ask.
- `Keep listening` checkbox applies to Chrome fallback only; Live owns its own turn-taking/barge-in.
- Capture graph uses muted ScriptProcessor destination so mic processing stays alive without speaker feedback.
- Wake word “Hey Jukebox” / “Okay Earth” is **opt-in** (checkbox off by default). Chrome STT listens only for the trigger; Talk still starts Gemini Live. Resume wake after Live ends.
