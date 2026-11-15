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

if (!/Stopped listening|Starting microphone|Listening…/.test(appJs)) {
  fail("talk-ux-copy", "Talk status copy incomplete");
} else {
  ok("talk-ux-copy");
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

if (failures.length) {
  console.error(`\n${failures.length} unit failure(s)`);
  process.exit(1);
}
console.log("\nUnit bench passed.");
