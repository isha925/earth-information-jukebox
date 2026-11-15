// Prefer the project .env over a stale shell export (common on this machine).
require("dotenv").config({ quiet: true, override: true });

const path = require("path");
const express = require("express");
const { GoogleGenAI } = require("@google/genai");

const PORT = Number(process.env.PORT) || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

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

function recentPowerWindow() {
  // POWER daily values lag a few days; end 3 days ago, start 9 days before that.
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 3);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 6);
  return { start: yyyymmdd(start), end: yyyymmdd(end) };
}

async function fetchNasaPowerKathmandu() {
  const lat = "27.7172";
  const lon = "85.3240";
  const { start, end } = recentPowerWindow();
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

  const latestDate = usable[usable.length - 1];
  const series = usable.map((date) => ({
    date,
    rainfallMm: precip[date],
    tempC: temp[date]
  }));

  return {
    trackId: "atmospheric-river",
    rainfall: precip[latestDate],
    temperatureC: temp[latestDate],
    date: latestDate,
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
  const url = "https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv";
  const response = await fetch(url, {
    headers: {
      "User-Agent": "EarthInformationJukebox/1.0 (NASA Space Apps)",
      Accept: "text/csv,text/plain,*/*"
    }
  });
  if (!response.ok) {
    throw new Error(`GISTEMP HTTP ${response.status}`);
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
  return {
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
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    geminiConfigured: Boolean(ai),
    model: GEMINI_MODEL,
    tracks: EIC_TRACKS.map((track) => track.id)
  });
});

app.get("/api/eic-tracks", (_req, res) => {
  res.json({ tracks: EIC_TRACKS });
});

app.get("/api/nasa-weather", async (_req, res) => {
  try {
    const payload = await fetchNasaPowerKathmandu();
    console.log(
      `[NASA POWER] Kathmandu rain=${payload.rainfall} mm/day temp=${payload.temperatureC} C on ${payload.date}`
    );
    res.json(payload);
  } catch (error) {
    console.error("NASA POWER Error:", error);
    res.status(500).json({ error: "Failed to fetch NASA POWER climate data." });
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

app.post("/api/chat", async (req, res) => {
  const { message, history } = req.body ?? {};

  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "No message received." });
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: "That message is too long." });
  }

  if (!ai) {
    return res.status(503).json({
      error: "The PA isn't set up yet. Add a Gemini API key to the server's .env file."
    });
  }

  const lower = message.toLowerCase();
  let nasaContext = "";
  let sonify = null;

  try {
    if (
      lower.includes("kathmandu") ||
      lower.includes("rainfall") ||
      lower.includes("precipitation") ||
      lower.includes("weather") ||
      lower.includes("rain")
    ) {
      const power = await fetchNasaPowerKathmandu();
      nasaContext =
        `NASA observation context: NASA POWER for Kathmandu on ${power.date} ` +
        `reports precipitation ${power.rainfall} millimeters per day and temperature ` +
        `${power.temperatureC} degrees Celsius. This is paired with the NASA SVS EIC ` +
        `atmospheric river visualization (${power.eicPairing.eicUrl}).`;
      sonify = {
        type: "power-rain",
        rainfallMm: power.rainfall,
        temperatureC: power.temperatureC,
        date: power.date,
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
        `NASA observation context: NASA GISTEMP version 4 global annual anomaly for ` +
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
  } catch (error) {
    console.error("NASA context attach failed:", error.message);
    nasaContext =
      "NASA observation context unavailable right now. Answer generally and invite a retry.";
  }

  const prompt = nasaContext
    ? `${message.trim()}\n\n${nasaContext}`
    : message.trim();

  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        ...toGeminiHistory(history),
        { role: "user", parts: [{ text: prompt }] }
      ],
      config: {
        systemInstruction: SYSTEM_INSTRUCTION
      }
    });

    const reply = toSpeakableText(response.text ?? "");

    if (!reply) {
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

    res.json({ reply, sonify });
  } catch (error) {
    logGeminiError(error);

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
