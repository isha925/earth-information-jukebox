const talkButton = document.getElementById("talkButton");
const askForm = document.getElementById("askForm");
const askInput = document.getElementById("askInput");
const askButton = document.getElementById("askButton");
const kathmanduBtn = document.getElementById("kathmanduBtn");
const gistempBtn = document.getElementById("gistempBtn");
const statusMessage = document.getElementById("statusMessage");
const paMessage = document.getElementById("paMessage");
const dataDisplay = document.getElementById("dataDisplay");
const earthScene = document.getElementById("earthScene");
const citationLine = document.getElementById("citationLine");

const LANGUAGE = "en-US";
const REQUEST_TIMEOUT_MS = 20000;
const MAX_HISTORY_MESSAGES = 20;
const RAIN_DURATION_SEC = 8;

const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;

const synth = window.speechSynthesis || null;

const RECOGNITION_ERRORS = {
  "no-speech": "I didn't hear anything. Try Talk again, or type your question.",
  "audio-capture": "No microphone was found. Type your question instead.",
  "not-allowed": "Microphone access was blocked. Allow mic for localhost in Chrome, then try Talk again.",
  "service-not-allowed": "Speech recognition is blocked here. Use Chrome/Edge over http://localhost:3000.",
  network: "Speech recognition needs an internet connection (Chrome uses Google's speech service).",
  aborted: "Listening was stopped.",
  "language-not-supported": "That speech language isn't supported in this browser."
};

const history = [];
let recognition = null;
let state = "idle";
let recognitionOutcome = null;
let audioCtx = null;
let activeNoiseNode = null;
let rainGainNode = null;
let rainStopTimer = null;
let activeNodes = [];
let listeningWatchdog = null;

function formatNasaDate(raw) {
  if (raw == null) {
    return "";
  }

  const text = String(raw).trim();
  // POWER returns YYYYMMDD
  if (/^\d{8}$/.test(text)) {
    const year = text.slice(0, 4);
    const month = text.slice(4, 6);
    const day = text.slice(6, 8);
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (!Number.isNaN(date.getTime())) {
      return new Intl.DateTimeFormat("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC"
      }).format(date);
    }
    return `${year}-${month}-${day}`;
  }

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric"
    }).format(parsed);
  }

  return text;
}

function setBusy() {
  const thinking = state === "thinking";
  const listening = state === "listening";

  // Only block Ask/quick actions while the PA is working.
  // Listening must not freeze the rest of the UI if mic recognition stalls.
  [askButton, kathmanduBtn, gistempBtn].forEach((el) => {
    if (el) {
      el.disabled = thinking;
    }
  });
  if (askInput) {
    askInput.disabled = thinking;
  }
  if (talkButton) {
    const speechAvailable = Boolean(
      window.SpeechRecognition || window.webkitSpeechRecognition
    );
    talkButton.disabled = thinking || !speechAvailable;
    talkButton.textContent = listening ? "Listening… (click to stop)" : "Talk";
  }
}

function setState(nextState, status) {
  state = nextState;
  setBusy();
  if (status !== undefined) {
    statusMessage.textContent = status;
  }
}

function clearListeningWatchdog() {
  if (listeningWatchdog) {
    clearTimeout(listeningWatchdog);
    listeningWatchdog = null;
  }
}

async function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") {
    await audioCtx.resume();
  }
  return audioCtx;
}

function stopActiveAudio() {
  if (rainStopTimer) {
    clearTimeout(rainStopTimer);
    rainStopTimer = null;
  }

  for (const node of activeNodes) {
    try {
      node.stop();
    } catch (_error) {
      // already stopped
    }
  }
  activeNodes = [];

  if (activeNoiseNode) {
    try {
      activeNoiseNode.stop();
    } catch (_error) {
      // already stopped
    }
    activeNoiseNode = null;
  }
  rainGainNode = null;
}

async function playUnlockChirp() {
  const ctx = await ensureAudio();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = 660;
  gain.gain.value = 0.0001;
  gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.25);
  activeNodes.push(osc);
}

function speak(text) {
  if (!synth || !text) {
    return;
  }

  synth.cancel();

  const start = () => {
    const sentences = text.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) || [text];
    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (!trimmed) {
        continue;
      }
      const utterance = new SpeechSynthesisUtterance(trimmed);
      utterance.lang = LANGUAGE;
      utterance.rate = 1.02;
      utterance.volume = 1;
      synth.speak(utterance);
    }
  };

  const voices = synth.getVoices();
  if (!voices.length) {
    synth.addEventListener("voiceschanged", start, { once: true });
    setTimeout(start, 250);
  } else {
    start();
  }
}

function setEicFrame(frameUrl, citation) {
  if (earthScene && frameUrl) {
    earthScene.style.backgroundImage = `url("${frameUrl}")`;
  }
  if (citationLine && citation) {
    citationLine.textContent = citation;
  }
}

async function playRainSoundscape(rainMm) {
  const ctx = await ensureAudio();
  stopActiveAudio();

  const bufferSize = ctx.sampleRate * 2;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const output = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i += 1) {
    output[i] = Math.random() * 2 - 1;
  }

  activeNoiseNode = ctx.createBufferSource();
  activeNoiseNode.buffer = buffer;
  activeNoiseNode.loop = true;

  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = Math.max(400, Math.min(rainMm * 280 + 500, 4200));
  filter.Q.value = 1.4;

  rainGainNode = ctx.createGain();
  const peak = Math.min(Math.max(0.35 + rainMm / 20, 0.35), 0.9);
  rainGainNode.gain.value = peak;

  activeNoiseNode.connect(filter);
  filter.connect(rainGainNode);
  rainGainNode.connect(ctx.destination);
  activeNoiseNode.start();
  activeNodes.push(activeNoiseNode);

  // Fade out and stop so rain does not loop forever.
  const stopAt = ctx.currentTime + RAIN_DURATION_SEC;
  rainGainNode.gain.setValueAtTime(peak, ctx.currentTime + RAIN_DURATION_SEC - 1.2);
  rainGainNode.gain.linearRampToValueAtTime(0.0001, stopAt);

  rainStopTimer = setTimeout(() => {
    stopActiveAudio();
    if (statusMessage && /soundscape playing/i.test(statusMessage.textContent || "")) {
      statusMessage.textContent = "Rain soundscape finished.";
    }
  }, RAIN_DURATION_SEC * 1000 + 50);
}

async function playTemperatureTone(anomalyC) {
  const ctx = await ensureAudio();
  stopActiveAudio();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const clamped = Math.max(-1, Math.min(anomalyC, 2));
  osc.type = "sine";
  osc.frequency.value = 240 + (clamped + 1) * 160;
  gain.gain.value = 0.0001;
  gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.05);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 2.4);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 2.5);
  activeNodes.push(osc);
}

async function applySonify(sonify) {
  if (!sonify) {
    return;
  }

  if (sonify.frameUrl) {
    setEicFrame(
      sonify.frameUrl,
      `${sonify.citation || "NASA"} · track ${sonify.trackId}`
    );
  }

  if (sonify.type === "power-rain") {
    const niceDate = formatNasaDate(sonify.date);
    const note = sonify.availabilityNote
      ? `<br><span class="avail">${sonify.availabilityNote}</span>`
      : "";
    dataDisplay.innerHTML =
      `<strong>NASA POWER · Kathmandu</strong><br>` +
      `Precipitation: <strong>${Number(sonify.rainfallMm).toFixed(2)} mm/day</strong><br>` +
      `Temperature: <strong>${Number(sonify.temperatureC).toFixed(1)} °C</strong><br>` +
      `Date: <strong>${niceDate}</strong>${note}`;
    await playRainSoundscape(Number(sonify.rainfallMm) || 0);
  }

  if (sonify.type === "gistemp") {
    dataDisplay.innerHTML =
      `<strong>NASA GISTEMP v4</strong><br>` +
      `Year: <strong>${sonify.year}</strong><br>` +
      `Global anomaly: <strong>${Number(sonify.anomalyC).toFixed(2)} °C</strong>`;
    await playTemperatureTone(Number(sonify.anomalyC) || 0);
  }
}

async function loadDefaultTrack() {
  try {
    const response = await fetch("/api/eic-tracks");
    const data = await response.json();
    const track = data.tracks?.[0];
    if (track) {
      setEicFrame(
        track.frameUrl,
        `${track.eicSource} · ${track.numericSource}`
      );
      dataDisplay.textContent =
        "Click “Hear Kathmandu rain”, or Talk and say “Kathmandu rainfall”.";
    }
  } catch (error) {
    console.error("EIC track load failed:", error);
    statusMessage.textContent = "Could not load the EIC track list.";
  }
}

function extractRequestedDate(question) {
  const lower = question.toLowerCase();
  if (/\byesterday\b/.test(lower)) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  if (/\blast\s+week\b/.test(lower)) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 7);
    return d.toISOString().slice(0, 10);
  }
  const iso = lower.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) {
    return `${iso[1]}-${iso[2]}-${iso[3]}`;
  }
  const compact = lower.match(/\b(20\d{2})(\d{2})(\d{2})\b/);
  if (compact) {
    return `${compact[1]}-${compact[2]}-${compact[3]}`;
  }
  const months = {
    january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
    july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
    jan: "01", feb: "02", mar: "03", apr: "04", jun: "06", jul: "07", aug: "08",
    sep: "09", oct: "10", nov: "11", dec: "12"
  };
  const named = lower.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})(?:,\s*(20\d{2}))?\b/
  );
  if (named) {
    const year = named[3] || String(new Date().getUTCFullYear());
    const day = String(named[2]).padStart(2, "0");
    return `${year}-${months[named[1]]}-${day}`;
  }
  return null;
}

async function playNasaDirect(kind, question = "") {
  if (kind === "rain") {
    const date = extractRequestedDate(question);
    const qs = date ? `?date=${encodeURIComponent(date)}` : "";
    const response = await fetch(`/api/nasa-weather${qs}`);
    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error || "NASA POWER failed");
    }
    const niceDate = formatNasaDate(data.date);
    const sonify = {
      type: "power-rain",
      rainfallMm: data.rainfall,
      temperatureC: data.temperatureC,
      date: data.date,
      requestedDate: data.requestedDate,
      selection: data.selection,
      availabilityNote: data.availabilityNote,
      trackId: data.trackId,
      frameUrl: data.eicPairing?.frameUrl,
      citation: data.source?.citation
    };
    // One short spoken line only — chat must not speak a second overlapping summary.
    const reply =
      `For Kathmandu on ${niceDate}, rainfall was ${Number(data.rainfall).toFixed(1)} ` +
      `millimeters per day, temperature around ${Number(data.temperatureC).toFixed(0)} degrees Celsius.`;
    paMessage.textContent = reply;
    await applySonify(sonify);
    return { reply, sonify, spoke: false };
  }

  const response = await fetch("/api/gistemp");
  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(data.error || "GISTEMP failed");
  }
  const sonify = {
    type: "gistemp",
    anomalyC: data.anomalyC,
    year: data.latestYear,
    trackId: data.trackId,
    frameUrl: data.eicPairing?.frameUrl,
    citation: data.source?.citation
  };
  const reply =
    `Global temperature anomaly for ${data.latestYear} was ` +
    `${Number(data.anomalyC).toFixed(2)} degrees Celsius.`;
  paMessage.textContent = reply;
  await applySonify(sonify);
  return { reply, sonify, spoke: false };
}

async function askPA(question) {
  const trimmed = question.trim();
  if (!trimmed || state === "thinking") {
    return;
  }

  // Stop previous rain + any queued speech so we never stack "NASA… NASA…"
  stopActiveAudio();
  if (synth) {
    synth.cancel();
  }
  clearListeningWatchdog();
  setState("thinking", `Working on: “${trimmed}”…`);
  await playUnlockChirp();

  const lower = trimmed.toLowerCase();
  const wantsRain =
    lower.includes("kathmandu") ||
    lower.includes("rain") ||
    lower.includes("precip") ||
    lower.includes("weather");
  const wantsTemp =
    lower.includes("global temperature") ||
    lower.includes("gistemp") ||
    lower.includes("warming") ||
    lower.includes("climate");

  let direct = null;
  try {
    if (wantsRain) {
      direct = await playNasaDirect("rain", trimmed);
      statusMessage.textContent = `Playing rain (~${RAIN_DURATION_SEC}s). Fetching spoken summary…`;
    } else if (wantsTemp) {
      direct = await playNasaDirect("temp", trimmed);
      statusMessage.textContent = "Playing temperature tone. Fetching spoken summary…";
    }
  } catch (error) {
    console.error("NASA direct play failed:", error);
    statusMessage.textContent = error.message;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: trimmed, history }),
      signal: controller.signal
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.reply) {
      throw new Error(data.error || "The PA could not respond. Please try again.");
    }

    history.push(
      { role: "user", text: trimmed },
      { role: "model", text: data.reply }
    );
    history.splice(0, Math.max(0, history.length - MAX_HISTORY_MESSAGES));

    // Prefer a single spoken answer. If Gemini only repeats the POWER facts we
    // already have, keep the shorter direct line to avoid laggy double-talk.
    let finalReply = data.reply;
    if (direct?.reply && data.fallback) {
      finalReply = direct.reply;
    }

    paMessage.textContent = finalReply;
    statusMessage.textContent = data.fallback
      ? `Latest available POWER data. You asked: “${trimmed}”`
      : `You asked: “${trimmed}”`;

    // Don't restart rain/tone if already playing from the direct NASA path.
    if (data.sonify && !(direct && data.sonify.type === direct.sonify?.type)) {
      await applySonify(data.sonify);
    }

    if (synth) {
      synth.cancel();
    }
    speak(finalReply);
  } catch (error) {
    console.error("CHAT ERROR:", error);
    if (direct?.reply) {
      statusMessage.textContent =
        "Played the latest available POWER day. Spoken summary used local NASA text.";
      if (synth) {
        synth.cancel();
      }
      speak(direct.reply);
    } else {
      let message = error.message;
      if (error.name === "AbortError") {
        message = "That took too long. Please try again.";
      } else if (error instanceof TypeError) {
        message = "I can't reach the Jukebox server. Please check that it's running.";
      }
      statusMessage.textContent = message;
      speak(message);
    }
  } finally {
    clearTimeout(timer);
    setState("idle");
  }
}

function getSpeechRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function createRecognition() {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) {
    return null;
  }

  const instance = new Ctor();
  instance.lang = LANGUAGE;
  instance.continuous = false;
  instance.interimResults = false;
  instance.maxAlternatives = 1;

  instance.onstart = () => {
    recognitionOutcome = null;
    setState("listening", "Listening… speak now");
    clearListeningWatchdog();
    listeningWatchdog = setTimeout(() => {
      try {
        instance.stop();
      } catch (_error) {
        // ignore
      }
    }, 8000);
  };

  instance.onresult = (event) => {
    clearListeningWatchdog();
    const text = event.results[0][0].transcript.trim();
    if (!text) {
      recognitionOutcome = "error";
      setState("idle", "I didn't catch that. Try Talk again.");
      return;
    }
    recognitionOutcome = "result";
    askInput.value = text;
    setState("idle");
    askPA(text);
  };

  instance.onerror = (event) => {
    clearListeningWatchdog();
    console.error("RECOGNITION ERROR:", event.error);
    recognitionOutcome = "error";
    // 'aborted' happens when we restart; don't alarm the user.
    if (event.error === "aborted") {
      return;
    }
    setState(
      "idle",
      RECOGNITION_ERRORS[event.error] || `Speech error: ${event.error}`
    );
  };

  instance.onend = () => {
    clearListeningWatchdog();
    if (state === "listening") {
      setState("idle");
      if (!recognitionOutcome) {
        statusMessage.textContent =
          "I didn't catch that. Try Talk again, or type your question.";
      }
    }
  };

  return instance;
}

async function startTalking() {
  if (!getSpeechRecognitionCtor()) {
    setState(
      "idle",
      "Speech recognition needs Chrome or Edge. Ask still works by typing."
    );
    return;
  }

  if (state === "thinking") {
    return;
  }

  // If already listening, stop cleanly so a second click can restart.
  if (state === "listening" && recognition) {
    try {
      recognition.stop();
    } catch (_error) {
      // ignore
    }
    clearListeningWatchdog();
    recognitionOutcome = "aborted";
    setState("idle", "Stopped listening.");
    return;
  }

  stopActiveAudio();
  if (synth) {
    synth.cancel();
  }
  await playUnlockChirp();

  // Fresh instance avoids Chrome "already started" dead ends.
  recognition = createRecognition();
  if (!recognition) {
    setState("idle", "Speech recognition unavailable in this browser.");
    return;
  }
  setState("listening", "Starting microphone…");

  try {
    recognition.start();
  } catch (error) {
    console.error("START ERROR:", error);
    // Retry once with a brand-new instance.
    try {
      recognition = createRecognition();
      recognition.start();
      return;
    } catch (retryError) {
      console.error("START RETRY ERROR:", retryError);
      setState(
        "idle",
        `Couldn't start the microphone (${retryError.name}). Check Chrome mic permission for localhost.`
      );
    }
  }
}

if (!getSpeechRecognitionCtor()) {
  talkButton.disabled = true;
  talkButton.title = "Speech recognition needs Chrome or Edge";
  statusMessage.textContent =
    "Talk needs Chrome/Edge. You can still use Ask or the Kathmandu button.";
} else {
  recognition = createRecognition();
  setBusy();
}

askForm.addEventListener("submit", (event) => {
  event.preventDefault();
  askPA(askInput.value);
});

talkButton.addEventListener("click", () => {
  startTalking();
});

[kathmanduBtn, gistempBtn].forEach((button) => {
  button.addEventListener("click", () => {
    const question = button.getAttribute("data-question");
    if (question) {
      askInput.value = question;
      askPA(question);
    }
  });
});

loadDefaultTrack();
