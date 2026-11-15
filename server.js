// Prefer the project .env over a stale shell export (common on this machine).
require("dotenv").config({ quiet: true, override: true });

const path = require("path");
const express = require("express");
const { GoogleGenAI } = require("@google/genai");

const PORT = Number(process.env.PORT) || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const NASA_API_KEY = process.env.NASA_API_KEY || "";

const MAX_MESSAGE_LENGTH = 2000;
const MAX_HISTORY_MESSAGES = 20;

// Curated EIC / SVS tracks. Visuals come from NASA SVS content used by the
// Earth Information Center; numeric drivers come from NASA open APIs that
// match the same Earth-science theme (water / climate).
const EIC_TRACKS = [
  {
    id: "atmospheric-river",
    title: "A 3D View of an Atmospheric River from an Earth System Model",
    theme: "water resources",
    eicSource: "NASA SVS EIC gallery item 4960",
    eicUrl: "https://svs.gsfc.nasa.gov/4960/",
    eicGallery: "https://svs.gsfc.nasa.gov/gallery/earth-information-center/",
    frameUrl: "https://svs.gsfc.nasa.gov/vis/a000000/a004900/a004960/atmos_rivers_narrated_4k.00090_print.jpg",
    videoUrl: "https://svs.gsfc.nasa.gov/vis/a000000/a004900/a004960/atmos_rivers_narrated_HD.webm",
    numericSource: "NASA POWER daily point precipitation and temperature",
    numericUrl: "https://power.larc.nasa.gov/",
    whyLinked:
      "Atmospheric rivers move water vapor; POWER PRECTOTCORR/T2M gives local rainfall and temperature that can be heard alongside the EIC water story."
  },
  {
    id: "global-temperature",
    title: "NASA GISS global surface temperature anomaly (GISTEMP v4)",
    theme: "climate / greenhouse gases",
    eicSource: "NASA Earth Information Center climate theme + GISTEMP v4",
    eicUrl: "https://earth.gov/",
    eicGallery: "https://svs.gsfc.nasa.gov/gallery/earth-information-center/",
    frameUrl: "https://data.giss.nasa.gov/gistemp/graphs_v4/graph_data/Global_Mean_Estimates_based_on_Land_and_Ocean_Data/graph.png",
    videoUrl: null,
    numericSource: "NASA GISS GISTEMP v4 GLB.Ts+dSST.csv",
    numericUrl: "https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv",
    whyLinked:
      "EIC climate storytelling is grounded in global temperature change; GISTEMP v4 is NASA's canonical anomaly series for that theme."
  }
];

const SYSTEM_INSTRUCTION = `You are the PA for Earth Information Jukebox, a NASA Space Apps project.
You help people hear Earth science by pairing NASA Earth Information Center visuals with NASA data-driven soundscapes.

Every reply is read aloud by text-to-speech, so:
- Keep replies short and conversational, usually two to four sentences.
- Use plain spoken sentences only. Never use markdown, lists, headings, emoji, or links.
- Write numbers and units the way they are spoken, for example "twenty millimeters per day".

When NASA observation context is provided in the user message, treat it as ground truth and explain it clearly.
Prefer NASA POWER precipitation or temperature for local weather questions, and GISTEMP for global temperature trends.
If no live numbers are provided, say so briefly and invite the listener to ask about Kathmandu rainfall or global temperature.`;

if (!GEMINI_API_KEY) {
  console.warn(
    "GEMINI_API_KEY is not set. The page will load, but the PA cannot answer until you add it to .env (see .env.example)."
  );
}

const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

function toGeminiHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  const turns = history
    .filter(
      (turn) =>
        turn &&
        (turn.role === "user" || turn.role === "model") &&
        typeof turn.text === "string" &&
        turn.text.trim()
    )
    .slice(-MAX_HISTORY_MESSAGES);

  while (turns.length && turns[0].role !== "user") {
    turns.shift();
  }

  return turns.map((turn) => ({
    role: turn.role,
    parts: [{ text: turn.text.slice(0, MAX_MESSAGE_LENGTH) }]
  }));
}

function toSpeakableText(text) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*(?:[-*•]|\d+\.)\s+/gm, "")
    .replace(/[*#`>_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function logGeminiError(error) {
  const hints = {
    400: "Gemini rejected the request. Check GEMINI_API_KEY and GEMINI_MODEL in .env.",
    401: "GEMINI_API_KEY is not valid. Create one at https://aistudio.google.com/apikey.",
    403: "GEMINI_API_KEY does not have access to this model.",
    404: `Model "${GEMINI_MODEL}" was not found. Set GEMINI_MODEL=gemini-3.8-flash in .env.`,
    429: "Gemini rate limit or quota exceeded.",
    503: "Gemini is temporarily overloaded. Retry shortly."
  };

  console.error("GEMINI ERROR:", error.status ?? "", error.message);

  if (hints[error.status]) {
    console.error("Hint:", hints[error.status]);
  }
}

function yyyymmdd(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function parseYmd(value) {
  if (!value) {
    return null;
  }
  const text = String(value).trim();
  if (/^\d{8}$/.test(text)) {
    return text;
  }
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    return `${iso[1]}${iso[2]}${iso[3]}`;
  }
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return yyyymmdd(parsed);
  }
  return null;
}

function parseDateFromMessage(message) {
  const lower = String(message || "").toLowerCase();
  const today = new Date();

  if (/\btoday\b|\bnow\b|\bcurrent\b|\blatest\b/.test(lower)) {
    return { mode: "latest" };
  }
  if (/\byesterday\b/.test(lower)) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - 1);
    return { mode: "date", date: yyyymmdd(d) };
  }
  if (/\blast\s+week\b/.test(lower)) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - 7);
    return { mode: "date", date: yyyymmdd(d) };
  }

  const iso = lower.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) {
    return { mode: "date", date: `${iso[1]}${iso[2]}${iso[3]}` };
  }
  const compact = lower.match(/\b(20\d{2})(\d{2})(\d{2})\b/);
  if (compact) {
    return { mode: "date", date: `${compact[1]}${compact[2]}${compact[3]}` };
  }

  const months = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
    jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
  };
  const named = lower.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})(?:,\s*(20\d{2}))?\b/
  );
  if (named) {
    const month = months[named[1]];
    const day = Number(named[2]);
    const year = Number(named[3] || today.getUTCFullYear());
    const d = new Date(Date.UTC(year, month - 1, day));
    if (!Number.isNaN(d.getTime())) {
      return { mode: "date", date: yyyymmdd(d) };
    }
  }

  return { mode: "latest" };
}

function powerWindowForRequest(requestedYmd) {
  if (requestedYmd) {
    // Pull a tiny window around the requested day in case of lag/fill values.
    const y = Number(requestedYmd.slice(0, 4));
    const m = Number(requestedYmd.slice(4, 6));
    const d = Number(requestedYmd.slice(6, 8));
    const center = new Date(Date.UTC(y, m - 1, d));
    const start = new Date(center);
    start.setUTCDate(start.getUTCDate() - 1);
    const end = new Date(center);
    end.setUTCDate(end.getUTCDate() + 1);
    return { start: yyyymmdd(start), end: yyyymmdd(end), requestedYmd };
  }

  // Ask through "today" and keep the newest non-fill day POWER has published.
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 14);
  return { start: yyyymmdd(start), end: yyyymmdd(end), requestedYmd: null };
}

async function fetchNasaPowerKathmandu(options = {}) {
  const lat = "27.7172";
  const lon = "85.3240";
  const requestedYmd = parseYmd(options.date);
  const { start, end } = powerWindowForRequest(requestedYmd);
  const nasaUrl =
    `https://power.larc.nasa.gov/api/temporal/daily/point` +
    `?parameters=PRECTOTCORR,T2M&community=RE&longitude=${lon}&latitude=${lat}` +
    `&start=${start}&end=${end}&format=JSON`;

  const response = await fetch(nasaUrl);
  if (!response.ok) {
    throw new Error(`NASA POWER HTTP ${response.status}`);
  }

  const data = await response.json();
  const precip = data?.properties?.parameter?.PRECTOTCORR;
  const temp = data?.properties?.parameter?.T2M;

  if (!precip || !temp) {
    throw new Error("Invalid response structure from NASA POWER.");
  }

  const dates = Object.keys(precip).sort();
  const usable = dates.filter((date) => {
    const rain = precip[date];
    const t2m = temp[date];
    return rain !== undefined && rain > -900 && t2m !== undefined && t2m > -900;
  });

  if (!usable.length) {
    throw new Error("NASA POWER returned only fill values for this window.");
  }

  let selectedDate = usable[usable.length - 1];
  let selection = "latest-available";
  if (requestedYmd) {
    if (usable.includes(requestedYmd)) {
      selectedDate = requestedYmd;
      selection = "exact";
    } else {
      // Nearest available day to the request.
      selectedDate = usable.reduce((best, date) =>
        Math.abs(Number(date) - Number(requestedYmd)) <
        Math.abs(Number(best) - Number(requestedYmd))
          ? date
          : best
      );
      selection = "nearest-available";
    }
  }

  const series = usable.map((date) => ({
    date,
    rainfallMm: precip[date],
    tempC: temp[date]
  }));

  const lagDays = Math.max(
    0,
    Math.round((Date.now() - Date.UTC(
      Number(selectedDate.slice(0, 4)),
      Number(selectedDate.slice(4, 6)) - 1,
      Number(selectedDate.slice(6, 8))
    )) / 86400000)
  );

  return {
    trackId: "atmospheric-river",
    rainfall: precip[selectedDate],
    temperatureC: temp[selectedDate],
    date: selectedDate,
    requestedDate: requestedYmd,
    selection,
    lagDays,
    availabilityNote:
      selection === "exact"
        ? `Observation for ${formatNasaDate(selectedDate)}`
        : selection === "nearest-available"
          ? `Requested ${formatNasaDate(requestedYmd)}; nearest POWER day is ${formatNasaDate(selectedDate)}`
          : `Latest POWER day available now: ${formatNasaDate(selectedDate)} (usually lags ~${Math.max(lagDays, 2)} days)`,
    series,
    location: { lat, lon, name: "Kathmandu" },
    source: {
      dataset: "NASA POWER Agroclimatology API",
      parameters: ["PRECTOTCORR", "T2M"],
      url: nasaUrl,
      citation: "NASA Langley Research Center POWER Project"
    },
    eicPairing: EIC_TRACKS[0]
  };
}

async function fetchGistempAnnual() {
  if (gistempCache.payload && Date.now() - gistempCache.at < GISTEMP_CACHE_MS) {
    return gistempCache.payload;
  }

  const url = "https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv";
  let response;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      response = await fetch(url, {
        headers: {
          "User-Agent": "EarthInformationJukebox/1.0 (NASA Space Apps)",
          Accept: "text/csv,text/plain,*/*"
        }
      });
      if (response.ok) {
        break;
      }
      lastError = new Error(`GISTEMP HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }
  if (!response || !response.ok) {
    if (gistempCache.payload) {
      return gistempCache.payload;
    }
    throw lastError || new Error("GISTEMP fetch failed");
  }
  const text = await response.text();
  const lines = text.trim().split(/\r?\n/);
  // Skip title rows until the Year header.
  const startIdx = lines.findIndex((line) => /^Year,/i.test(line.trim()));
  if (startIdx < 0) {
    throw new Error("Could not parse GISTEMP CSV header.");
  }

  const header = lines[startIdx].split(",").map((part) => part.trim());
  const annualIdx = header.findIndex((part) => part === "J-D");
  if (annualIdx < 0) {
    throw new Error("GISTEMP CSV missing J-D annual column.");
  }

  const rows = [];
  for (const line of lines.slice(startIdx + 1)) {
    const parts = line.split(",").map((part) => part.trim());
    const year = Number(parts[0]);
    const annual = parts[annualIdx];
    if (!Number.isFinite(year) || !annual || annual === "***") {
      continue;
    }
    const anomalyC = Number(annual);
    if (!Number.isFinite(anomalyC)) {
      continue;
    }
    rows.push({ year, anomalyC });
  }

  if (!rows.length) {
    throw new Error("GISTEMP CSV had no annual values.");
  }

  const latest = rows[rows.length - 1];
  const payload = {
    trackId: "global-temperature",
    latestYear: latest.year,
    anomalyC: latest.anomalyC,
    series: rows.slice(-30),
    source: {
      dataset: "NASA GISS GISTEMP v4",
      url,
      citation: "Lenssen et al. / NASA Goddard Institute for Space Studies"
    },
    eicPairing: EIC_TRACKS[1]
  };
  gistempCache = { at: Date.now(), payload };
  return payload;
}


function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`${label} timed out after ${ms}ms`);
        error.status = 503;
        reject(error);
      }, ms);
    })
  ]);
}

let gistempCache = { at: 0, payload: null };
const GISTEMP_CACHE_MS = 15 * 60 * 1000;

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    geminiConfigured: Boolean(ai),
    nasaApiKeyConfigured: Boolean(NASA_API_KEY),
    model: GEMINI_MODEL,
    tracks: EIC_TRACKS.map((track) => track.id)
  });
});

// Validates api.nasa.gov key. APOD is currently flaky; NEO is a stable probe.
app.get("/api/nasa-key-check", async (_req, res) => {
  if (!NASA_API_KEY) {
    return res.status(503).json({
      ok: false,
      error: "NASA_API_KEY is not set in .env"
    });
  }

  try {
    const url =
      "https://api.nasa.gov/neo/rest/v1/feed?start_date=2026-11-01&end_date=2026-11-01&api_key=" +
      encodeURIComponent(NASA_API_KEY);
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok) {
      return res.status(502).json({
        ok: false,
        error: data.error_message || data.msg || `NASA API HTTP ${response.status}`
      });
    }
    res.json({
      ok: true,
      service: "api.nasa.gov/neo",
      elementCount: data.element_count,
      note: "Key works. Challenge sonification still uses NASA POWER + GISTEMP + SVS EIC frames (no api.nasa.gov key required)."
    });
  } catch (error) {
    console.error("NASA key check failed:", error);
    res.status(502).json({ ok: false, error: "Failed to reach api.nasa.gov" });
  }
});

app.get("/api/eic-tracks", (_req, res) => {
  res.json({ tracks: EIC_TRACKS });
});

app.get("/api/nasa-weather", async (req, res) => {
  try {
    const payload = await fetchNasaPowerKathmandu({ date: req.query.date });
    console.log(
      `[NASA POWER] Kathmandu rain=${payload.rainfall} mm/day temp=${payload.temperatureC} C on ${payload.date} selection=${payload.selection}`
    );
    res.json(payload);
  } catch (error) {
    console.error("NASA POWER Error:", error);
    res.status(500).json({ error: error.message || "Failed to fetch NASA POWER climate data." });
  }
});

app.get("/api/gistemp", async (_req, res) => {
  try {
    const payload = await fetchGistempAnnual();
    console.log(`[GISTEMP] latest ${payload.latestYear} anomaly=${payload.anomalyC} C`);
    res.json(payload);
  } catch (error) {
    console.error("GISTEMP Error:", error);
    res.status(500).json({ error: "Failed to fetch NASA GISTEMP data." });
  }
});


function formatNasaDate(raw) {
  const text = String(raw || "").trim();
  if (/^\d{8}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }
  return text;
}

function fallbackReplyFromSonify(sonify) {
  if (!sonify) {
    return null;
  }

  if (sonify.type === "power-rain") {
    return (
      `For Kathmandu on ${formatNasaDate(sonify.date)}, rainfall was ` +
      `${Number(sonify.rainfallMm).toFixed(1)} millimeters per day, ` +
      `and air temperature around ${Number(sonify.temperatureC).toFixed(0)} degrees Celsius.`
    );
  }

  if (sonify.type === "gistemp") {
    return (
      `Global temperature anomaly for ${sonify.year} was ` +
      `${Number(sonify.anomalyC).toFixed(2)} degrees Celsius above the nineteen fifty one to nineteen eighty baseline.`
    );
  }

  return null;
}

async function attachNasaContext(message) {
  const lower = message.toLowerCase();
  let nasaContext = "";
  let sonify = null;

  if (
    lower.includes("kathmandu") ||
    lower.includes("rainfall") ||
    lower.includes("precipitation") ||
    lower.includes("weather") ||
    lower.includes("rain")
  ) {
    const dateReq = parseDateFromMessage(message);
    const power = await fetchNasaPowerKathmandu({
      date: dateReq.mode === "date" ? dateReq.date : undefined
    });
    nasaContext =
      `NASA observation context: POWER for Kathmandu on ${power.date} ` +
      `(${power.availabilityNote}) reports precipitation ${power.rainfall} millimeters per day ` +
      `and temperature ${power.temperatureC} degrees Celsius. ` +
      `Paired with SVS EIC atmospheric river visualization (${power.eicPairing.eicUrl}). ` +
      `If the user asked for a day POWER has not published yet, explain the lag briefly.`;
    sonify = {
      type: "power-rain",
      rainfallMm: power.rainfall,
      temperatureC: power.temperatureC,
      date: power.date,
      requestedDate: power.requestedDate,
      selection: power.selection,
      availabilityNote: power.availabilityNote,
      trackId: power.trackId,
      frameUrl: power.eicPairing.frameUrl,
      citation: power.source.citation
    };
  } else if (
    lower.includes("global temperature") ||
    lower.includes("gistemp") ||
    lower.includes("warming") ||
    lower.includes("climate")
  ) {
    const gistemp = await fetchGistempAnnual();
    nasaContext =
      `NASA observation context: NASA GISS GISTEMP version 4 global annual anomaly for ` +
      `${gistemp.latestYear} is ${gistemp.anomalyC} degrees Celsius relative to the ` +
      `1951 to 1980 baseline. Pair this with the EIC climate theme on earth.gov.`;
    sonify = {
      type: "gistemp",
      anomalyC: gistemp.anomalyC,
      year: gistemp.latestYear,
      trackId: gistemp.trackId,
      frameUrl: gistemp.eicPairing.frameUrl,
      citation: gistemp.source.citation
    };
  }

  return { nasaContext, sonify };
}

app.post("/api/chat", async (req, res) => {
  const { message, history } = req.body ?? {};

  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "No message received." });
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: "That message is too long." });
  }

  let nasaContext = "";
  let sonify = null;

  try {
    ({ nasaContext, sonify } = await attachNasaContext(message.trim()));
  } catch (error) {
    console.error("NASA context attach failed:", error.message);
    nasaContext =
      "NASA observation context unavailable right now. Answer generally and invite a retry.";
  }

  if (!ai) {
    const fallback = fallbackReplyFromSonify(sonify);
    if (fallback) {
      return res.json({ reply: fallback, sonify, fallback: true });
    }

    return res.status(503).json({
      error: "The PA isn't set up yet. Add a Gemini API key to the server's .env file."
    });
  }

  const prompt = nasaContext
    ? `${message.trim()}\n\n${nasaContext}`
    : message.trim();

  try {
    const response = await withTimeout(
      ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [
          ...toGeminiHistory(history),
          { role: "user", parts: [{ text: prompt }] }
        ],
        config: {
          systemInstruction: SYSTEM_INSTRUCTION
        }
      }),
      12000,
      "Gemini"
    );

    const reply = toSpeakableText(response.text ?? "");

    if (!reply) {
      const fallback = fallbackReplyFromSonify(sonify);
      if (fallback) {
        return res.json({ reply: fallback, sonify, fallback: true });
      }

      console.error(
        "GEMINI EMPTY REPLY:",
        response.candidates?.[0]?.finishReason ??
          response.promptFeedback?.blockReason ??
          "unknown"
      );

      return res.status(502).json({
        error: "I don't have an answer for that. Could you try asking another way?"
      });
    }

    res.json({ reply, sonify, fallback: false });
  } catch (error) {
    logGeminiError(error);

    const fallback = fallbackReplyFromSonify(sonify);
    if (fallback) {
      return res.json({ reply: fallback, sonify, fallback: true });
    }

    if (error.status === 429 || error.status === 503) {
      return res.status(error.status).json({
        error: "I'm getting a lot of questions right now. Please try again in a moment."
      });
    }

    res.status(502).json({ error: "The PA could not respond. Please try again." });
  }
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  const status = error.status || error.statusCode || 500;

  if (status >= 500) {
    console.error("SERVER ERROR:", error);
  }

  res.status(status).json({
    error: status < 500 ? "The request could not be read." : "Something went wrong on the server."
  });
});

app.listen(PORT, (error) => {
  if (error) {
    console.error(`Could not start the server on port ${PORT}:`, error.message);
    process.exit(1);
  }

  console.log(
    `Earth Information Jukebox running at http://localhost:${PORT} (model: ${GEMINI_MODEL})`
  );
});
