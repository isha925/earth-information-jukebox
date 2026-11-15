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

const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;

const synth = window.speechSynthesis || null;

const RECOGNITION_ERRORS = {
  "no-speech": "I didn't hear anything. Try Talk again, or type your question.",
  "audio-capture": "No microphone was found. Type your question instead.",
  "not-allowed": "Microphone access was blocked. Type your question instead.",
  "service-not-allowed": "Speech recognition is blocked here. Type your question instead.",
  network: "Speech recognition needs an internet connection.",
  aborted: "Listening was stopped."
};

const history = [];
let recognition = null;
let state = "idle";
let recognitionOutcome = null;
let audioCtx = null;
let activeNoiseNode = null;
let activeNodes = [];

function setBusy(isBusy) {
  [talkButton, askButton, kathmanduBtn, gistempBtn].forEach((el) => {
    if (el) {
      el.disabled = isBusy;
    }
  });
  if (askInput) {
    askInput.disabled = isBusy;
  }
}

function setState(nextState, status) {
  state = nextState;
  setBusy(nextState !== "idle");
  if (status !== undefined) {
    statusMessage.textContent = status;
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

  // Chrome sometimes needs voices to be loaded before first speak.
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

  const gainNode = ctx.createGain();
  // Keep rain audible even on dry days.
  gainNode.gain.value = Math.min(Math.max(0.35 + rainMm / 20, 0.35), 0.9);

  activeNoiseNode.connect(filter);
  filter.connect(gainNode);
  gainNode.connect(ctx.destination);
  activeNoiseNode.start();
  activeNodes.push(activeNoiseNode);
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
    dataDisplay.innerHTML =
      `<strong>NASA POWER · Kathmandu</strong><br>` +
      `Precipitation: <strong>${Number(sonify.rainfallMm).toFixed(2)} mm/day</strong><br>` +
      `Temperature: <strong>${Number(sonify.temperatureC).toFixed(1)} °C</strong><br>` +
      `Date: ${sonify.date}`;
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
        "Click “Hear Kathmandu rain” — you should hear a chirp, then rain noise and speech.";
    }
  } catch (error) {
    console.error("EIC track load failed:", error);
    statusMessage.textContent = "Could not load the EIC track list.";
  }
}

async function playNasaDirect(kind) {
  if (kind === "rain") {
    const response = await fetch("/api/nasa-weather");
    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error || "NASA POWER failed");
    }
    const sonify = {
      type: "power-rain",
      rainfallMm: data.rainfall,
      temperatureC: data.temperatureC,
      date: data.date,
      trackId: data.trackId,
      frameUrl: data.eicPairing?.frameUrl,
      citation: data.source?.citation
    };
    const reply =
      `NASA POWER reports Kathmandu rainfall at ${Number(data.rainfall).toFixed(1)} ` +
      `millimeters per day on ${data.date}, with air temperature around ` +
      `${Number(data.temperatureC).toFixed(0)} degrees Celsius.`;
    paMessage.textContent = reply;
    await applySonify(sonify);
    speak(reply);
    return { reply, sonify };
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
    `NASA GISTEMP version 4 shows a global annual temperature anomaly of ` +
    `${Number(data.anomalyC).toFixed(2)} degrees Celsius for ${data.latestYear}.`;
  paMessage.textContent = reply;
  await applySonify(sonify);
  speak(reply);
  return { reply, sonify };
}

async function askPA(question) {
  const trimmed = question.trim();
  if (!trimmed || state === "thinking") {
    return;
  }

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

  // Play NASA audio immediately so the demo is never silent while Gemini hangs.
  try {
    if (wantsRain) {
      await playNasaDirect("rain");
      statusMessage.textContent = `NASA soundscape playing. Enriching with PA for: “${trimmed}”`;
    } else if (wantsTemp) {
      await playNasaDirect("temp");
      statusMessage.textContent = `NASA soundscape playing. Enriching with PA for: “${trimmed}”`;
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

    paMessage.textContent = data.reply;
    statusMessage.textContent = data.fallback
      ? `NASA data ready (Gemini fallback). You asked: “${trimmed}”`
      : `You asked: “${trimmed}”`;

    if (data.sonify) {
      await applySonify(data.sonify);
    }
    speak(data.reply);
  } catch (error) {
    console.error("CHAT ERROR:", error);
    // If NASA audio already played, keep that result instead of a hard failure.
    if (!(wantsRain || wantsTemp)) {
      let message = error.message;
      if (error.name === "AbortError") {
        message = "That took too long. Please try again.";
      } else if (error instanceof TypeError) {
        message = "I can't reach the Jukebox server. Please check that it's running.";
      }
      statusMessage.textContent = message;
      speak(message);
    } else if (error.name === "AbortError") {
      statusMessage.textContent =
        "NASA soundscape is playing. Gemini took too long, so the spoken NASA summary was used.";
    }
  } finally {
    clearTimeout(timer);
    setState("idle");
  }
}

if (!SpeechRecognition) {
  talkButton.disabled = true;
  talkButton.title = "Speech recognition needs Chrome or Edge";
} else {
  recognition = new SpeechRecognition();
  recognition.lang = LANGUAGE;
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    recognitionOutcome = null;
    setState("listening", "Listening…");
  };

  recognition.onresult = (event) => {
    const text = event.results[0][0].transcript.trim();
    if (!text) {
      return;
    }
    recognitionOutcome = "result";
    setState("idle");
    askPA(text);
  };

  recognition.onerror = (event) => {
    console.error("RECOGNITION ERROR:", event.error);
    recognitionOutcome = "error";
    statusMessage.textContent =
      RECOGNITION_ERRORS[event.error] || `Speech error: ${event.error}`;
  };

  recognition.onend = () => {
    if (state !== "listening") {
      return;
    }
    setState("idle");
    if (!recognitionOutcome) {
      statusMessage.textContent = "I didn't catch that. Type a question or try Talk again.";
    }
  };
}

askForm.addEventListener("submit", (event) => {
  event.preventDefault();
  askPA(askInput.value);
});

talkButton.addEventListener("click", async () => {
  if (!recognition || state !== "idle") {
    return;
  }

  await playUnlockChirp();
  if (synth) {
    synth.cancel();
  }

  setState("listening", "Starting speech recognition…");

  try {
    recognition.start();
  } catch (error) {
    console.error("START ERROR:", error);
    setState("idle", `Couldn't start the microphone: ${error.name}`);
  }
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
