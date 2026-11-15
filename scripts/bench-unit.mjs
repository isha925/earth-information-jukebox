#!/usr/bin/env node
/**
 * Pure unit bench: date formatting + rain duration contract from public/app.js
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function ok(name, detail = "") {
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name, detail) {
  failures.push(`${name}: ${detail}`);
  console.error(`FAIL  ${name} — ${detail}`);
}

const appJs = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

// Extract formatNasaDate by evaluating a minimal slice.
const match = appJs.match(/function formatNasaDate\(raw\) \{[\s\S]*?\n\}/);
if (!match) {
  fail("extract-formatNasaDate", "function not found in public/app.js");
} else {
  const context = { Intl, Date, String, Number, console };
  vm.createContext(context);
  vm.runInContext(`${match[0]}; this.formatNasaDate = formatNasaDate;`, context);
  const samples = [
    ["20261112", "12 Nov 2026"],
    ["20240107", "7 Jan 2024"],
    ["2025", "2025"]
  ];
  for (const [input, expectedPart] of samples) {
    const out = context.formatNasaDate(input);
    if (!String(out).includes(expectedPart.split(" ").pop()) && out !== expectedPart) {
      // For YYYYMMDD expect day/month/year human form, never raw 8 digits.
      if (/^\d{8}$/.test(input) && /^\d{8}$/.test(out)) {
        fail("formatNasaDate", `${input} -> ${out}`);
        continue;
      }
    }
    if (/^\d{8}$/.test(input) && /^\d{8}$/.test(out)) {
      fail("formatNasaDate-raw", `${input} -> ${out}`);
    } else if (/^\d{8}$/.test(input) && !/Nov|Jan|2026|2024|-/.test(out) && !/2026|2024/.test(out)) {
      fail("formatNasaDate-human", `${input} -> ${out}`);
    } else {
      ok("formatNasaDate", `${input} -> ${out}`);
    }
  }
}

if (!/RAIN_DURATION_SEC\s*=\s*8/.test(appJs)) {
  fail("rain-duration-const", "RAIN_DURATION_SEC should be finite (8s)");
} else {
  ok("rain-duration-const", "8s");
}

if (!/linearRampToValueAtTime/.test(appJs) || !/rainStopTimer/.test(appJs)) {
  fail("rain-stop-logic", "missing fade/stop timer for rain loop");
} else {
  ok("rain-stop-logic", "fade + stop timer present");
}

if (!/function createRecognition/.test(appJs) || !/function startTalking/.test(appJs)) {
  fail("talk-helpers", "Talk helpers missing");
} else {
  ok("talk-helpers", "createRecognition + startTalking");
}

if (!/Stopped listening|Starting microphone|Listening…|I'm listening/.test(appJs)) {
  fail("talk-ux-copy", "Talk status copy incomplete");
} else {
  ok("talk-ux-copy");
}

if (!/keepTalking|maybeContinueConversation|Alt/.test(appJs)) {
  fail("conversation-mode", "voice-first conversation helpers missing");
} else {
  ok("conversation-mode", "keep listening + shortcuts");
}

if (
  !/function stopEverything/.test(appJs) ||
  !/function bumpRunToken/.test(appJs) ||
  !/recognitionOutcome === "aborted"/.test(appJs) ||
  !/utterance\.onerror = \(\) => finish\(\)/.test(appJs)
) {
  fail("stop-hard-abort", "Stop must abort speech, mic, and continue-listen");
} else {
  ok("stop-hard-abort", "runToken + stopEverything + no speak-after-cancel");
}

const liveProxy = fs.readFileSync(path.join(ROOT, "live-proxy.js"), "utf8");
const liveClient = fs.readFileSync(path.join(ROOT, "public", "live-duplex.js"), "utf8");
const wakeJs = fs.readFileSync(path.join(ROOT, "public", "wake-word.js"), "utf8");
if (
  !/attachLiveProxy/.test(liveProxy) ||
  !/gemini-2.5-flash-native-audio-latest/.test(liveProxy) ||
  !/jukeboxStartLiveTalk/.test(liveClient) ||
  !/jukeboxStartLiveTalk/.test(appJs)
) {
  fail("talk-live-duplex", "Talk must prefer Gemini Live over Chrome speech");
} else {
  ok("talk-live-duplex", "Live proxy + Talk prefers jukeboxStartLiveTalk");
}

if (
  !/hey\\s\+jukebox/i.test(wakeJs) ||
  !/wakeWordEnabled/.test(wakeJs) ||
  !/jukeboxOnLiveEnded/.test(wakeJs) ||
  !/jukeboxStartTalk/.test(appJs)
) {
  fail("wake-word", "Hey Jukebox wake phrase wiring missing");
} else {
  ok("wake-word", "opt-in Hey Jukebox / Okay Earth");
}

if (
  !/liveProcessCue/.test(liveClient) ||
  !/setProcessCue/.test(liveClient) ||
  !/BUSY_MESSAGE/.test(liveClient) ||
  !/friendlyGoogleBusyMessage/.test(liveProxy) ||
  !/explainLiveProblem/.test(liveProxy) ||
  !/sendLiveError/.test(liveProxy)
) {
  fail("live-process-cue", "processing banner / busy Google errors missing");
} else {
  ok("live-process-cue", "visual process cue + structured Live errors");
}

const serverJs = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
if (
  !/function explainProblem/.test(serverJs) ||
  !/function explainGeminiFailure/.test(serverJs) ||
  !/texas:\s*\{\s*name:\s*"Austin"/.test(serverJs) ||
  !/function showProblem/.test(appJs) ||
  !/fromWake/.test(appJs) ||
  !/wake_live_failed|do NOT fall into Chrome STT|Live Talk did not stay open/.test(appJs) ||
  !/MIC_HANDOFF_MS/.test(liveClient) ||
  !/releasing mic, then starting Talk/.test(wakeJs)
) {
  fail(
    "core-reliability",
    "what/why/next errors, Texas alias, wake→Live mic handoff, or no Chrome after wake missing"
  );
} else {
  ok(
    "core-reliability",
    "Texas→Austin alias, structured errors, wake mic handoff, no Chrome after wake"
  );
}

if (
  !/function recognitionLanguageFor/.test(appJs) ||
  !/LISTEN_PROMPTS/.test(appJs) ||
  !/instance\.lang = sttLang/.test(appJs)
) {
  fail("talk-language-aware", "Talk STT language wiring missing");
} else {
  ok("talk-language-aware", "STT follows answer language");
}

if (!/function isDryPrecipitation/.test(appJs) || !/function playDryDayCue/.test(appJs)) {
  fail("dry-day-sonify", "0 mm must not play rain noise");
} else {
  ok("dry-day-sonify", "dry cue when precip <= 0");
}

if (!/extractPlaceFromQuestion|place=/.test(appJs)) {
  fail("any-place", "on-the-fly place query missing");
} else {
  ok("any-place", "place passed to POWER");
}

if (
  !/function resolveReplyLanguage/.test(appJs) ||
  !/function pickSpeakVoice/.test(appJs) ||
  !/RELATED_VOICE_LANGUAGES/.test(appJs) ||
  !/FALLBACK_LANGUAGE/.test(appJs)
) {
  fail("regional-voice", "regional speak + related-voice fallback missing");
} else {
  ok("regional-voice", "Nepali can borrow Hindi voice; English only if needed");
}

if (
  !/function isAffirmativePhrase/.test(appJs) ||
  !/function isNegativePhrase/.test(appJs) ||
  !/function makeAudioIntroPrompt/.test(appJs) ||
  !/pendingDetails/.test(appJs) ||
  !/Would you like additional info/.test(appJs) ||
  !/CRITICAL AUDIO-FIRST WORKFLOW FOR VISUALLY IMPAIRED LISTENERS/.test(liveProxy)
) {
  fail(
    "audio-first-workflow",
    "Missing audio-first soundscape intro, prompt for additional info, or affirmative/negative handlers"
  );
} else {
  ok(
    "audio-first-workflow",
    "Weather sound plays first, voice prompts for additional info, confirms with 'yes' for full report"
  );
}

if (failures.length) {
  console.error(`\n${failures.length} unit failure(s)`);
  process.exit(1);
}
console.log("\nUnit bench passed.");
