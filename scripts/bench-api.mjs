#!/usr/bin/env node
/**
 * API bench against a running server.
 */
const BASE = process.argv[2] || process.env.JUKEBOX_URL || "http://localhost:3000";
const failures = [];

function ok(name, detail = "") {
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name, detail) {
  failures.push(`${name}: ${detail}`);
  console.error(`FAIL  ${name} — ${detail}`);
}

async function getJson(urlPath, init) {
  const response = await fetch(`${BASE}${urlPath}`, init);
  const json = await response.json().catch(() => ({}));
  return { response, json };
}

function assertDatePayload(label, rawDate) {
  if (!/^\d{8}$/.test(String(rawDate))) {
    fail(label, `expected POWER YYYYMMDD raw field, got ${rawDate}`);
  } else {
    ok(label, `raw=${rawDate} (UI must format this)`);
  }
}

async function main() {
  console.log(`API bench against ${BASE}`);

  const health = await getJson("/api/health");
  if (!health.json.ok) fail("health", JSON.stringify(health.json));
  else ok("health", `gemini=${health.json.geminiConfigured} nasaKey=${health.json.nasaApiKeyConfigured}`);

  const keyCheck = await getJson("/api/nasa-key-check");
  if (!keyCheck.json.ok) fail("nasa-key-check", JSON.stringify(keyCheck.json));
  else ok("nasa-key-check", `neo elements=${keyCheck.json.elementCount}`);

  const power = await getJson("/api/nasa-weather");
  if (typeof power.json.rainfall !== "number") fail("power", JSON.stringify(power.json));
  else {
    ok("power", `${power.json.rainfall} mm/day selection=${power.json.selection}`);
    assertDatePayload("power-raw-date", power.json.date);
    if (power.json.selection !== "latest-available") {
      fail("power-latest-selection", power.json.selection);
    } else {
      ok("power-latest-selection", power.json.availabilityNote || "");
    }
    if (!power.json.eicPairing?.frameUrl?.includes("svs.gsfc.nasa.gov")) {
      fail("power-eic", JSON.stringify(power.json.eicPairing));
    } else ok("power-eic", power.json.eicPairing.eicUrl);
  }

  const dated = await getJson("/api/nasa-weather?date=2026-11-10");
  if (dated.json.date !== "20261110" || dated.json.selection !== "exact") {
    fail("power-dated", JSON.stringify(dated.json));
  } else {
    ok("power-dated", `${dated.json.date} rain=${dated.json.rainfall}`);
  }

  if (!/Kathmandu/i.test(power.json.location?.label || power.json.location?.name || "")) {
    fail("power-default-place", JSON.stringify(power.json.location));
  } else {
    ok("power-default-place", power.json.location.label);
  }

  const tokyo = await getJson("/api/nasa-weather?place=Tokyo");
  if (!/Tokyo/i.test(tokyo.json.location?.name || "") || typeof tokyo.json.rainfall !== "number") {
    fail("power-tokyo", JSON.stringify(tokyo.json));
  } else {
    ok(
      "power-tokyo",
      `${tokyo.json.location.label} rain=${tokyo.json.rainfall} lat=${tokyo.json.location.lat}`
    );
  }

  const gistemp = await getJson("/api/gistemp");
  if (typeof gistemp.json.anomalyC !== "number") fail("gistemp", JSON.stringify(gistemp.json));
  else ok("gistemp", `${gistemp.json.latestYear} => ${gistemp.json.anomalyC} C`);

  const t0 = Date.now();
  const chat = await getJson("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Kathmandu rainfall", history: [] })
  });
  const elapsed = Date.now() - t0;
  if (!chat.json.reply || chat.json.sonify?.type !== "power-rain") {
    fail("chat-rain", JSON.stringify(chat.json));
  } else if (elapsed > 20000) {
    fail("chat-rain-latency", `${elapsed}ms`);
  } else {
    ok("chat-rain", `${elapsed}ms fallback=${Boolean(chat.json.fallback)}`);
    if (chat.json.reply.includes("20261112") || /\b20\d{6}\b/.test(chat.json.reply)) {
      fail("chat-rain-spoken-date", chat.json.reply.slice(0, 160));
    } else {
      ok("chat-rain-spoken-date", "no raw YYYYMMDD in reply");
    }
  }

  const chatTemp = await getJson("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "global temperature", history: [] })
  });
  if (!chatTemp.json.reply || chatTemp.json.sonify?.type !== "gistemp") {
    fail("chat-temp", JSON.stringify(chatTemp.json));
  } else ok("chat-temp", `fallback=${Boolean(chatTemp.json.fallback)}`);

  // Static assets
  for (const asset of ["/", "/app.js", "/styles.css"]) {
    const response = await fetch(`${BASE}${asset}`);
    if (!response.ok) fail(`asset ${asset}`, String(response.status));
    else ok(`asset ${asset}`, String(response.status));
  }

  const appJs = await (await fetch(`${BASE}/app.js`)).text();
  for (const needle of ["formatNasaDate", "RAIN_DURATION_SEC", "startTalking", "createRecognition"]) {
    if (!appJs.includes(needle)) fail("served-app-js", `missing ${needle}`);
    else ok("served-app-js", needle);
  }

  if (failures.length) {
    console.error(`\n${failures.length} API failure(s)`);
    process.exit(1);
  }
  console.log("\nAPI bench passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
