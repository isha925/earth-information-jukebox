#!/usr/bin/env node
/**
 * Live end-to-end checks against a running Jukebox server.
 * Usage: node scripts/live-check.mjs [baseUrl]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const BASE = process.argv[2] || process.env.JUKEBOX_URL || "http://localhost:3000";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ARTIFACT_DIR =
  process.env.JUKEBOX_ARTIFACT_DIR ||
  path.join(ROOT, "artifacts");
const SCREENSHOT = path.join(ARTIFACT_DIR, "jukebox-live.png");

const failures = [];
const notes = [];

function ok(name, detail = "") {
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name, detail) {
  failures.push(`${name}: ${detail}`);
  console.error(`FAIL  ${name} — ${detail}`);
}

async function getJson(urlPath, { method = "GET", body } = {}) {
  const response = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON ${response.status}: ${text.slice(0, 180)}`);
  }
  return { response, json };
}

async function checkApis() {
  const health = await getJson("/api/health");
  if (!health.response.ok || !health.json.ok) {
    fail("health", JSON.stringify(health.json));
  } else {
    ok(
      "health",
      `geminiConfigured=${health.json.geminiConfigured} nasaApiKeyConfigured=${health.json.nasaApiKeyConfigured}`
    );
  }

  const nasaKey = await getJson("/api/nasa-key-check");
  if (!nasaKey.response.ok || !nasaKey.json.ok) {
    fail("nasa-key-check", JSON.stringify(nasaKey.json));
  } else {
    ok("nasa-key-check", `elementCount=${nasaKey.json.elementCount}`);
  }

  const tracks = await getJson("/api/eic-tracks");
  if (!tracks.response.ok || !Array.isArray(tracks.json.tracks) || tracks.json.tracks.length < 1) {
    fail("eic-tracks", JSON.stringify(tracks.json));
  } else {
    const frame = tracks.json.tracks[0].frameUrl || "";
    if (!/svs\.gsfc\.nasa\.gov|earth\.gov|giss\.nasa\.gov/.test(frame)) {
      fail("eic-frame-source", frame);
    } else {
      ok("eic-tracks", tracks.json.tracks.map((t) => t.id).join(","));
    }
  }

  const power = await getJson("/api/nasa-weather");
  if (
    !power.response.ok ||
    typeof power.json.rainfall !== "number" ||
    typeof power.json.temperatureC !== "number" ||
    !power.json.date
  ) {
    fail("nasa-weather", JSON.stringify(power.json));
  } else if (!power.json.eicPairing?.eicUrl?.includes("svs.gsfc.nasa.gov")) {
    fail("nasa-weather-eic-pairing", JSON.stringify(power.json.eicPairing));
  } else {
    ok(
      "nasa-weather",
      `${power.json.rainfall} mm/day @ ${power.json.date}`
    );
  }

  const gistemp = await getJson("/api/gistemp");
  if (
    !gistemp.response.ok ||
    typeof gistemp.json.anomalyC !== "number" ||
    !gistemp.json.latestYear
  ) {
    fail("gistemp", JSON.stringify(gistemp.json));
  } else {
    ok("gistemp", `${gistemp.json.latestYear} anomaly=${gistemp.json.anomalyC}`);
  }

  const chatRain = await getJson("/api/chat", {
    method: "POST",
    body: { message: "Kathmandu rainfall", history: [] }
  });
  if (
    !chatRain.response.ok ||
    !chatRain.json.reply ||
    chatRain.json.sonify?.type !== "power-rain"
  ) {
    fail("chat-kathmandu", JSON.stringify(chatRain.json));
  } else {
    ok(
      "chat-kathmandu",
      `fallback=${Boolean(chatRain.json.fallback)} sonify=${chatRain.json.sonify.type}`
    );
  }

  const chatTemp = await getJson("/api/chat", {
    method: "POST",
    body: { message: "global temperature", history: [] }
  });
  if (
    !chatTemp.response.ok ||
    !chatTemp.json.reply ||
    chatTemp.json.sonify?.type !== "gistemp"
  ) {
    fail("chat-gistemp", JSON.stringify(chatTemp.json));
  } else {
    ok(
      "chat-gistemp",
      `fallback=${Boolean(chatTemp.json.fallback)} sonify=${chatTemp.json.sonify.type}`
    );
  }
}

async function checkBrowser() {
  const chromePath =
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

  if (!fs.existsSync(chromePath)) {
    fail("browser", `Chrome not found at ${chromePath}`);
    return;
  }

  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--window-size=1280,800"]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const response = await page.goto(BASE, { waitUntil: "networkidle2", timeout: 45000 });
    if (!response || !response.ok()) {
      fail("browser-home", `status=${response?.status()}`);
      return;
    }

    const required = [
      "#earthScene",
      ".brand",
      "#askForm",
      "#askInput",
      "#askButton",
      "#talkButton",
      "#kathmanduBtn",
      "#gistempBtn",
      "#paMessage",
      "#statusMessage",
      "#dataDisplay",
      "#citationLine"
    ];

    for (const selector of required) {
      const found = await page.$(selector);
      if (!found) {
        fail("browser-dom", `missing ${selector}`);
      }
    }

    const brandText = await page.$eval(".brand", (el) => el.textContent.trim());
    if (!/Earth Information Jukebox/i.test(brandText)) {
      fail("browser-brand", brandText);
    } else {
      ok("browser-brand", brandText);
    }

    const h1Size = await page.$eval("h1", (el) => {
      const style = window.getComputedStyle(el);
      return Number.parseFloat(style.fontSize);
    });
    if (!(h1Size > 24 && h1Size < 72)) {
      fail("browser-h1-size", `fontSize=${h1Size}px (expected readable, not giant)`);
    } else {
      ok("browser-h1-size", `${h1Size}px`);
    }

    const sceneBg = await page.$eval("#earthScene", (el) => getComputedStyle(el).backgroundImage);
    if (!sceneBg.includes("svs.gsfc.nasa.gov") && !sceneBg.includes("url(")) {
      fail("browser-eic-bg", sceneBg);
    } else {
      ok("browser-eic-bg", sceneBg.slice(0, 90));
    }

    // Click Kathmandu path without microphone.
    await page.click("#kathmanduBtn");
    await page.waitForFunction(
      () => {
        const data = document.getElementById("dataDisplay")?.textContent || "";
        const pa = document.getElementById("paMessage")?.textContent || "";
        return /NASA POWER/i.test(data) && /Kathmandu|millimeter|rainfall|precipitation/i.test(pa + data);
      },
      { timeout: 60000 }
    );

    const dataText = await page.$eval("#dataDisplay", (el) => el.textContent);
    if (!/mm\/day/i.test(dataText)) {
      fail("browser-kathmandu-data", dataText);
    } else if (/\b20\d{6}\b/.test(dataText)) {
      fail("browser-date-format", `raw YYYYMMDD still shown: ${dataText}`);
    } else if (!/20\d{2}/.test(dataText)) {
      fail("browser-date-format", dataText);
    } else {
      ok("browser-kathmandu-data", dataText.replace(/\s+/g, " ").slice(0, 140));
    }

    const statusText = await page.$eval("#statusMessage", (el) => el.textContent);
    if (/lot of questions/i.test(statusText)) {
      fail("browser-no-hard-gemini-error", statusText);
    } else {
      ok("browser-status", statusText.slice(0, 100));
    }

    await page.screenshot({ path: SCREENSHOT, fullPage: true });
    notes.push(`screenshot=${SCREENSHOT}`);
    ok("browser-screenshot", SCREENSHOT);
  } finally {
    await browser.close();
  }
}

async function main() {
  console.log(`Live checks against ${BASE}`);
  await checkApis();
  await checkBrowser();

  if (failures.length) {
    console.error(`\n${failures.length} failure(s):`);
    for (const item of failures) {
      console.error(` - ${item}`);
    }
    process.exit(1);
  }

  console.log("\nAll live checks passed.");
  for (const note of notes) {
    console.log(note);
  }
}

main().catch((error) => {
  console.error("Live check crashed:", error);
  process.exit(1);
});
