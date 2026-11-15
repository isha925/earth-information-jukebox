const talkButton = document.getElementById("talkButton");
const statusMessage = document.getElementById("statusMessage");
const paMessage = document.getElementById("paMessage");
const dataDisplay = document.getElementById("dataDisplay");
const earthScene = document.getElementById("earthScene");
const citationLine = document.getElementById("citationLine");

const LANGUAGE = "en-US";
const REQUEST_TIMEOUT_MS = 45000;
const MAX_HISTORY_MESSAGES = 20;

const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;

const synth = window.speechSynthesis || null;

const RECOGNITION_ERRORS = {
  "no-speech": "I didn't hear anything. Click “Talk with me” and try again.",
  "audio-capture": "No microphone was found. Please check that one is connected.",
  "not-allowed": "Microphone access was blocked. Please allow it in your browser settings.",
  "service-not-allowed": "Speech recognition is blocked in this browser.",
  network: "Speech recognition needs an internet connection.",
  aborted: "Listening was stopped."
};

const history = [];
let recognition = null;
let state = "idle";
let recognitionOutcome = null;
let audioCtx = null;
let activeNoiseNode = null;

function setState(nextState, status) {
  state = nextState;
  talkButton.disabled = nextState !== "idle";
  if (status !== undefined) {
    statusMessage.textContent = status;
  }
}

function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
  return audioCtx;
}

function speak(text) {
  if (!synth || !text) {
    return;
  }

  synth.cancel();
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) || [text];

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) {
      continue;
    }
    const utterance = new SpeechSynthesisUtterance(trimmed);
    utterance.lang = LANGUAGE;
    synth.speak(utterance);
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

function playRainSoundscape(rainMm) {
  const ctx = ensureAudio();
  if (activeNoiseNode) {
    try {
      activeNoiseNode.stop();
    } catch (_error) {
      // already stopped
    }
  }

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
  filter.frequency.value = Math.max(300, Math.min(rainMm * 250 + 300, 4500));
  filter.Q.value = 2.5;

  const gainNode = ctx.createGain();
  gainNode.gain.value = Math.min(Math.max(rainMm / 25, 0.2), 1.0);

  activeNoiseNode.connect(filter);
  filter.connect(gainNode);
  gainNode.connect(ctx.destination);
  activeNoiseNode.start();
}

function playTemperatureTone(anomalyC) {
  const ctx = ensureAudio();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  // Map anomaly (-0.5 .. 1.5 C-ish modern range) to audible pitch.
  const clamped = Math.max(-1, Math.min(anomalyC, 2));
  osc.frequency.value = 220 + (clamped + 1) * 180;
  gain.gain.value = 0.08;
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 2.5);
}

function applySonify(sonify) {
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
      `NASA POWER Kathmandu<br>` +
      `Precipitation: <strong>${Number(sonify.rainfallMm).toFixed(2)} mm/day</strong><br>` +
      `Temperature: <strong>${Number(sonify.temperatureC).toFixed(1)} °C</strong><br>` +
      `Date: ${sonify.date}`;
    playRainSoundscape(Number(sonify.rainfallMm) || 0);
  }

  if (sonify.type === "gistemp") {
    dataDisplay.innerHTML =
      `NASA GISTEMP v4<br>` +
      `Year: <strong>${sonify.year}</strong><br>` +
      `Global anomaly: <strong>${Number(sonify.anomalyC).toFixed(2)} °C</strong>`;
    playTemperatureTone(Number(sonify.anomalyC) || 0);
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
        "Say Kathmandu rainfall or global temperature to hear NASA data.";
    }
  } catch (error) {
    console.error("EIC track load failed:", error);
  }
}

async function askPA(question) {
  setState("thinking", `You said: “${question}” — thinking…`);
  ensureAudio();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: question, history }),
      signal: controller.signal
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.reply) {
      throw new Error(data.error || "The PA could not respond. Please try again.");
    }

    history.push(
      { role: "user", text: question },
      { role: "model", text: data.reply }
    );
    history.splice(0, Math.max(0, history.length - MAX_HISTORY_MESSAGES));

    paMessage.textContent = data.reply;
    statusMessage.textContent = `You said: “${question}”`;
    applySonify(data.sonify);
    speak(data.reply);
  } catch (error) {
    console.error("CHAT ERROR:", error);

    let message = error.message;
    if (error.name === "AbortError") {
      message = "The PA took too long to answer. Please try again.";
    } else if (error instanceof TypeError) {
      message = "I can't reach the Jukebox server. Please check that it's running.";
    }

    statusMessage.textContent = message;
    speak(message);
  } finally {
    clearTimeout(timer);
    setState("idle");
  }
}

if (!SpeechRecognition) {
  talkButton.disabled = true;
  statusMessage.textContent =
    "Speech recognition is not available in this browser. Please try Chrome or Edge.";
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
      statusMessage.textContent = "I didn't catch that. Please try again.";
    }
  };
}

talkButton.addEventListener("click", () => {
  if (!recognition || state !== "idle") {
    return;
  }

  ensureAudio();
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

loadDefaultTrack();
