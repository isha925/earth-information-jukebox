#!/usr/bin/env node
/**
 * Browser bench: UI, date formatting, Talk wiring, rain stop behavior.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const BASE = process.argv[2] || process.env.JUKEBOX_URL || "http://localhost:3000";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT_DIR = process.env.JUKEBOX_ARTIFACT_DIR || path.join(ROOT, "artifacts");
const failures = [];

function ok(name, detail = "") {
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name, detail) {
  failures.push(`${name}: ${detail}`);
  console.error(`FAIL  ${name} — ${detail}`);
}

async function main() {
  console.log(`Browser bench against ${BASE}`);
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  const chromePath =
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-gpu",
      "--window-size=1280,800",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream"
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    const client = await page.createCDPSession();
    await client.send("Browser.grantPermissions", {
      origin: BASE,
      permissions: ["audioCapture"]
    });

    // Install SpeechRecognition stub before app.js runs.
    await page.evaluateOnNewDocument(() => {
      class StubRecognition {
        constructor() {
          this.lang = "en-US";
          this.continuous = false;
          this.interimResults = false;
          this.maxAlternatives = 1;
          this.onstart = null;
          this.onresult = null;
          this.onerror = null;
          this.onend = null;
        }
        start() {
          queueMicrotask(() => {
            this.onstart?.();
            const event = {
              results: [[{ transcript: "Kathmandu rainfall" }]]
            };
            this.onresult?.(event);
            this.onend?.();
          });
        }
        stop() {
          this.onend?.();
        }
      }
      window.SpeechRecognition = StubRecognition;
      window.webkitSpeechRecognition = StubRecognition;
    });

    const response = await page.goto(BASE, { waitUntil: "networkidle2", timeout: 45000 });
    if (!response?.ok()) {
      fail("home", `status=${response?.status()}`);
      return;
    }
    ok("home");

    // Keep conversation auto-listen off in automated benches.
    await page.evaluate(() => {
      const box = document.getElementById("keepTalking");
      if (box) {
        box.checked = false;
      }
    });

    const speech = await page.evaluate(() => ({
      hasWebkit: typeof window.webkitSpeechRecognition === "function",
      hasSpeech: typeof window.SpeechRecognition === "function",
      talkDisabled: document.getElementById("talkButton")?.disabled === true,
      talkText: document.getElementById("talkButton")?.textContent
    }));
    if (!(speech.hasWebkit || speech.hasSpeech)) fail("speech-api", JSON.stringify(speech));
    else ok("speech-api", JSON.stringify(speech));
    if (speech.talkDisabled) fail("talk-enabled", "Talk button disabled on load");
    else ok("talk-enabled", speech.talkText);

    async function waitForIdle(timeout = 45000) {
      await page.waitForFunction(
        () => {
          const talk = document.getElementById("talkButton");
          const kathmandu = document.getElementById("kathmanduBtn");
          return (
            talk &&
            !talk.disabled &&
            (talk.textContent || "") === "Talk" &&
            kathmandu &&
            !kathmandu.disabled
          );
        },
        { timeout }
      );
    }

    // Talk -> stub transcript -> NASA rain path
    await page.click("#talkButton");
    await page.waitForFunction(
      () => /NASA POWER/i.test(document.getElementById("dataDisplay")?.textContent || ""),
      { timeout: 30000 }
    );
    const talkData = await page.$eval("#dataDisplay", (el) => el.textContent);
    if (/\b20\d{6}\b/.test(talkData)) fail("talk-date-format", talkData);
    else ok("talk-to-nasa", talkData.replace(/\s+/g, " ").slice(0, 140));
    await waitForIdle();
    ok("idle-after-talk");

    // Ask path
    await page.click("#gistempBtn");
    await page.waitForFunction(
      () => /GISTEMP/i.test(document.getElementById("dataDisplay")?.textContent || ""),
      { timeout: 30000 }
    );
    ok(
      "gistemp-button",
      (await page.$eval("#dataDisplay", (el) => el.textContent)).replace(/\s+/g, " ").slice(0, 120)
    );
    await waitForIdle();

    // Kathmandu again + rain finish status/wait
    await page.click("#kathmanduBtn");
    await page.waitForFunction(
      () => /NASA POWER/i.test(document.getElementById("dataDisplay")?.textContent || ""),
      { timeout: 30000 }
    );
    const dataText = await page.$eval("#dataDisplay", (el) => el.textContent);
    if (/\b20\d{6}\b/.test(dataText)) fail("date-format", dataText);
    else ok("date-format", dataText.replace(/\s+/g, " ").slice(0, 140));

    // Prefer explicit finished status; also wait out the 8s rain window.
    await Promise.race([
      page.waitForFunction(
        () => /Rain soundscape finished/i.test(document.getElementById("statusMessage")?.textContent || ""),
        { timeout: 12000 }
      ),
      new Promise((resolve) => setTimeout(resolve, 9000))
    ]);
    const statusAfter = await page.$eval("#statusMessage", (el) => el.textContent);
    if (/finished/i.test(statusAfter)) ok("rain-finished-status", statusAfter);
    else ok("rain-finished-waited", `status="${statusAfter}"`);
    await waitForIdle();

    // Listening should not disable Kathmandu: install a slow recognizer first.
    await page.evaluate(() => {
      class SlowStub {
        constructor() {
          this.onstart = null;
          this.onresult = null;
          this.onerror = null;
          this.onend = null;
        }
        start() {
          this.onstart?.();
          this._timer = setTimeout(() => this.onend?.(), 8000);
        }
        stop() {
          clearTimeout(this._timer);
          this.onend?.();
        }
      }
      window.SpeechRecognition = SlowStub;
      window.webkitSpeechRecognition = SlowStub;
    });
    await page.click("#talkButton");
    await page.waitForFunction(
      () => /Listening/i.test(document.getElementById("talkButton")?.textContent || ""),
      { timeout: 5000 }
    );
    const kathmanduDisabled = await page.$eval("#kathmanduBtn", (el) => el.disabled);
    if (kathmanduDisabled) fail("listening-keeps-ui-usable", "Kathmandu disabled while listening");
    else ok("listening-keeps-ui-usable");

    // Second Talk click stops listening
    await page.click("#talkButton");
    await page.waitForFunction(
      () => (document.getElementById("talkButton")?.textContent || "").startsWith("Talk"),
      { timeout: 5000 }
    );
    ok("talk-toggle-stop", await page.$eval("#statusMessage", (el) => el.textContent));    const shot = path.join(ARTIFACT_DIR, "jukebox-browser-bench.png");
    await page.screenshot({ path: shot, fullPage: true });
    ok("screenshot", shot);
  } finally {
    await browser.close();
  }

  if (failures.length) {
    console.error(`\n${failures.length} browser failure(s)`);
    for (const item of failures) console.error(` - ${item}`);
    process.exit(1);
  }
  console.log("\nBrowser bench passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
