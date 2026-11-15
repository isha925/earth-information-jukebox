const talkButton = document.getElementById("talkButton");
const askForm = document.getElementById("askForm");
const askInput = document.getElementById("askInput");
const askButton = document.getElementById("askButton");
const kathmanduBtn = document.getElementById("kathmanduBtn");
const tokyoBtn = document.getElementById("tokyoBtn");
const gistempBtn = document.getElementById("gistempBtn");
const stopAudioBtn = document.getElementById("stopAudioBtn");
const placeQuickButtons = [kathmanduBtn, tokyoBtn].filter(Boolean);
const statusMessage = document.getElementById("statusMessage");
const paMessage = document.getElementById("paMessage");
const dataDisplay = document.getElementById("dataDisplay");
const earthScene = document.getElementById("earthScene");
const citationLine = document.getElementById("citationLine");
const trackLabel = document.getElementById("trackLabel");
const intensityBar = document.getElementById("intensityBar");
const replyLanguageSelect = document.getElementById("replyLanguage");
const voiceSupportNote = document.getElementById("voiceSupportNote");
const keepTalkingCheckbox = document.getElementById("keepTalking");

const FALLBACK_LANGUAGE = "en-US";
const REQUEST_TIMEOUT_MS = 20000;
const MAX_HISTORY_MESSAGES = 20;
const RAIN_DURATION_SEC = 8;
const LISTEN_WATCHDOG_MS = 12000;

let conversationActive = false;
let suppressAutoListen = false;
// Bumped by Stop / new asks so in-flight speak / continue / listen awaits bail out.
let runToken = 0;
let geminiSpeechWaitResolve = null;

// Preferred reply language by country / place (BCP-47). Used when Speak = Auto.
const COUNTRY_REPLY_LANGUAGE = {
  Nepal: "ne-NP",
  Japan: "ja-JP",
  India: "hi-IN",
  Egypt: "ar-EG",
  "Saudi Arabia": "ar-SA",
  "United Arab Emirates": "ar-AE",
  Spain: "es-ES",
  Mexico: "es-MX",
  France: "fr-FR",
  Brazil: "pt-BR",
  Portugal: "pt-PT",
  China: "zh-CN",
  Kenya: "sw-KE",
  Tanzania: "sw-TZ",
  Nigeria: "en-NG",
  "United Kingdom": "en-GB",
  "United States": "en-US",
  Australia: "en-AU",
  Singapore: "en-SG",
  Bangladesh: "bn-BD"
};

const PLACE_REPLY_LANGUAGE = {
  kathmandu: "ne-NP",
  pokhara: "ne-NP",
  tokyo: "ja-JP",
  mumbai: "hi-IN",
  delhi: "hi-IN",
  "new delhi": "hi-IN",
  chennai: "hi-IN",
  cairo: "ar-EG",
  miami: "en-US",
  london: "en-GB",
  paris: "fr-FR",
  "sao paulo": "pt-BR",
  "mexico city": "es-MX",
  nairobi: "sw-KE",
  beijing: "zh-CN",
  dhaka: "bn-BD"
};

const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;

const synth = window.speechSynthesis || null;

const RECOGNITION_ERRORS = {
  "no-speech": "I didn't hear anything. Try Talk again, or type your question.",
  "audio-capture": "No microphone was found. Type your question instead.",
  "not-allowed": "Microphone access was blocked. Allow mic for localhost in Chrome, then try Talk again.",
  "service-not-allowed": "Speech recognition is blocked here. Use Chrome/Edge over http://localhost:3000.",
  network:
    "Chrome's built-in speech service failed. Talk normally uses Gemini Live instead — press Talk again, or type your question.",
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
  [askButton, gistempBtn, ...placeQuickButtons].forEach((el) => {
    if (el) {
      el.disabled = thinking;
    }
  });
  if (askInput) {
    askInput.disabled = thinking;
  }
  if (talkButton) {
    // Live Talk does not need Chrome SpeechRecognition; keep Talk clickable.
    const liveOn = Boolean(window.jukeboxLiveActive?.());
    talkButton.disabled = thinking && !liveOn;
    if (!liveOn) {
      talkButton.textContent = listening ? "Listening… (click to stop)" : "Talk";
      talkButton.classList.toggle("is-listening", listening);
      talkButton.setAttribute("aria-pressed", listening ? "true" : "false");
    }
  }
}

function keepTalkingEnabled() {
  return Boolean(keepTalkingCheckbox?.checked);
}

function bumpRunToken() {
  runToken += 1;
  return runToken;
}

function isCurrentRun(token) {
  return token === runToken;
}

/** Hard stop: sound, speech, mic, and conversation auto-listen. */
function stopEverything(statusText = "Stopped.") {
  bumpRunToken();
  suppressAutoListen = true;
  conversationActive = false;
  clearListeningWatchdog();
  recognitionOutcome = "aborted";
  if (recognition) {
    try {
      recognition.abort?.();
    } catch (_error) {
      // ignore
    }
    try {
      recognition.stop();
    } catch (_error) {
      // ignore
    }
  }
  if (typeof window.jukeboxStopLive === "function") {
    window.jukeboxStopLive();
  }
  stopActiveAudio();
  if (synth) {
    synth.cancel();
  }
  setIntensity(0.08);
  if (state === "listening" || state === "thinking") {
    setState("idle", statusText);
  } else if (statusMessage) {
    statusMessage.textContent = statusText;
  }
}

function isStopListeningPhrase(text) {
  const value = String(text || "");
  return (
    /\b(stop listening|stop talking|goodbye|good bye|end conversation|cancel)\b/i.test(
      value
    ) ||
    / सुनन बन्द|बन्द गर|रोक|अलविदा/.test(value) ||
    /聞いて.*(止|や)|ストップ|会話を終|さようなら/.test(value) ||
    /बंद करो|सुनना बंद|अलविदा/.test(value)
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// SpeechRecognition language for Talk. Auto stays English so city names are reliable.
function selectedListenLanguage() {
  const selected = replyLanguageSelect?.value || "auto";
  if (selected === "auto") {
    return FALLBACK_LANGUAGE;
  }
  return selected;
}

// Chrome often lacks Nepali STT — prefer Hindi recognizer for Nepali answers.
function recognitionLanguageFor(lang) {
  const base = String(lang || FALLBACK_LANGUAGE).toLowerCase().split("-")[0];
  if (base === "ne") {
    return "hi-IN";
  }
  if (base === "zh") {
    return "zh-CN";
  }
  if (base === "sw") {
    return FALLBACK_LANGUAGE;
  }
  return lang || FALLBACK_LANGUAGE;
}

const LISTEN_PROMPTS = {
  "en-US": "I'm listening. Ask about rain in a city, or say global temperature.",
  "ne-NP": "म सुन्दैछु। कुनै सहरको वर्षा वा विश्व तापक्रम भन्नुहोस्।",
  "hi-IN": "मैं सुन रहा हूँ। किसी शहर की बारिश या वैश्विक तापमान कहें।",
  "ja-JP": "聞いています。都市の雨、または地球温暖化について話してください。",
  "es-ES": "Estoy escuchando. Pregunta por la lluvia en una ciudad, o di temperatura global.",
  "fr-FR": "J'écoute. Parlez de la pluie dans une ville, ou dites température mondiale.",
  "pt-BR": "Estou ouvindo. Fale da chuva em uma cidade, ou diga temperatura global.",
  "zh-CN": "我在听。请说某个城市的降雨，或者说全球气温。",
  "ar-EG": "أنا أستمع. اسأل عن المطر في مدينة، أو قل درجة الحرارة العالمية.",
  "sw-KE": "Ninasikiliza. Sema mvua katika jiji, au tempereture ya dunia."
};

const CONTINUE_PROMPTS = {
  "en-US": "I'm listening again. Ask another place, or say stop listening.",
  "ne-NP": "फेरि सुन्दैछु। अर्को ठाउँ भन्नुहोस्, वा सुनन बन्द भन्नुहोस्।",
  "hi-IN": "फिर से सुन रहा हूँ। दूसरा स्थान कहें, या सुनना बंद कहें।",
  "ja-JP": "もう一度聞いています。別の場所を言うか、ストップと言ってください。",
  "es-ES": "Escucho de nuevo. Di otro lugar, o di deja de escuchar.",
  "fr-FR": "J'écoute à nouveau. Donnez un autre lieu, ou dites arrête d'écouter.",
  "pt-BR": "Ouvindo de novo. Diga outro lugar, ou diga parar de ouvir.",
  "zh-CN": "我再次在听。请说另一个地方，或者说停止收听。",
  "ar-EG": "أستمع مرة أخرى. اذكر مكانًا آخر، أو قل توقف عن الاستماع.",
  "sw-KE": "Ninasikiliza tena. Sema mahali mengine, au sema acha kusikiliza."
};

const MISSED_PROMPTS = {
  "en-US":
    "I didn't catch that. Press Talk and ask about rain in a city, or global temperature.",
  "ne-NP": "मैले बुझिनँ। Talk थिचेर सहरको वर्षा वा विश्व तापक्रम भन्नुहोस्।",
  "hi-IN": "मैं समझ नहीं पाया। Talk दबाकर शहर की बारिश या वैश्विक तापमान कहें।",
  "ja-JP": "聞き取れませんでした。Talkを押して、都市の雨か地球温暖化を話してください。",
  "es-ES": "No te escuché. Pulsa Talk y pregunta por lluvia en una ciudad o temperatura global.",
  "fr-FR": "Je n'ai pas compris. Appuyez sur Talk et parlez de pluie ou de température mondiale.",
  "pt-BR": "Não entendi. Toque em Talk e fale sobre chuva em uma cidade ou temperatura global.",
  "zh-CN": "我没听清。请按 Talk，再说城市降雨或全球气温。",
  "ar-EG": "لم أسمع ذلك. اضغط Talk واسأل عن المطر أو درجة الحرارة العالمية.",
  "sw-KE": "Sikuelewa. Bonyeza Talk, sema mvua ya jiji au tempereture ya dunia."
};

function promptFor(map, lang) {
  return map[lang] || map[FALLBACK_LANGUAGE];
}

function setIntensity(fraction) {
  if (!intensityBar) {
    return;
  }
  const clamped = Math.max(0.08, Math.min(Number(fraction) || 0, 1));
  intensityBar.style.width = `${Math.round(clamped * 100)}%`;
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
  stopGeminiSpeech();
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

function getSynthVoices() {
  if (!synth) {
    return [];
  }
  return synth.getVoices() || [];
}

// Closest installed voices when the exact regional voice is missing.
// Nepali (ne) is rarely packaged; Hindi Devanagari voices can still speak Nepali text.
const RELATED_VOICE_LANGUAGES = {
  "ne-np": ["ne-NP", "ne", "hi-IN", "hi"],
  ne: ["ne-NP", "ne", "hi-IN", "hi"],
  "hi-in": ["hi-IN", "hi"],
  hi: ["hi-IN", "hi"],
  "ja-jp": ["ja-JP", "ja"],
  ja: ["ja-JP", "ja"],
  "bn-bd": ["bn-BD", "bn-IN", "bn", "hi-IN"],
  bn: ["bn-BD", "bn-IN", "bn", "hi-IN"],
  "ar-eg": ["ar-EG", "ar-SA", "ar"],
  "ar-sa": ["ar-SA", "ar-EG", "ar"],
  "ar-ae": ["ar-AE", "ar-SA", "ar"],
  "zh-cn": ["zh-CN", "zh-TW", "zh"],
  "sw-ke": ["sw-KE", "sw", "en-KE", "en-US"],
  "sw-tz": ["sw-TZ", "sw", "en-KE", "en-US"]
};

function findVoiceForLanguage(lang) {
  const voices = getSynthVoices();
  if (!voices.length || !lang) {
    return null;
  }
  const wanted = String(lang).toLowerCase();
  const base = wanted.split("-")[0];
  return (
    voices.find((voice) => voice.lang.toLowerCase() === wanted) ||
    voices.find((voice) => voice.lang.toLowerCase().replace("_", "-") === wanted) ||
    voices.find((voice) => voice.lang.toLowerCase().startsWith(`${base}-`)) ||
    voices.find((voice) => voice.lang.toLowerCase().startsWith(base)) ||
    voices.find((voice) => voice.lang.toLowerCase().replace("_", "-").startsWith(base)) ||
    null
  );
}

function pickSpeakVoice(lang) {
  const preferred = String(lang || FALLBACK_LANGUAGE);
  const key = preferred.toLowerCase();
  const base = key.split("-")[0];
  const candidates = RELATED_VOICE_LANGUAGES[key] ||
    RELATED_VOICE_LANGUAGES[base] ||
    [preferred, base, FALLBACK_LANGUAGE];

  for (const candidate of candidates) {
    const voice = findVoiceForLanguage(candidate);
    if (voice) {
      return {
        voice,
        voiceLang: voice.lang || candidate,
        exact: candidate.toLowerCase().startsWith(base),
        usedRelated: !candidate.toLowerCase().startsWith(base) && base !== "en"
      };
    }
  }

  const english = findVoiceForLanguage(FALLBACK_LANGUAGE);
  return {
    voice: english,
    voiceLang: FALLBACK_LANGUAGE,
    exact: false,
    usedRelated: false,
    fellBackToEnglish: true
  };
}

function preferredLanguageForPlace(placeName, country) {
  if (country && COUNTRY_REPLY_LANGUAGE[country]) {
    return COUNTRY_REPLY_LANGUAGE[country];
  }
  const key = String(placeName || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (key && PLACE_REPLY_LANGUAGE[key]) {
    return PLACE_REPLY_LANGUAGE[key];
  }
  return FALLBACK_LANGUAGE;
}

function resolveReplyLanguage(placeHint = {}) {
  const selected = replyLanguageSelect?.value || "auto";
  let preferred = selected;
  if (selected === "auto") {
    preferred = preferredLanguageForPlace(placeHint.name, placeHint.country);
  }

  // Content language stays preferred (e.g. Nepali). Voice may use a related pack.
  const spoken = pickSpeakVoice(preferred);
  return {
    preferred,
    effective: preferred,
    speakLang: spoken.fellBackToEnglish ? FALLBACK_LANGUAGE : preferred,
    voice: spoken.voice,
    voiceLang: spoken.voiceLang,
    usedRelatedVoice: Boolean(spoken.usedRelated),
    fellBackToEnglish: Boolean(spoken.fellBackToEnglish)
  };
}

function updateVoiceSupportNote(placeHint = {}) {
  if (!voiceSupportNote) {
    return;
  }
  const resolved = resolveReplyLanguage(placeHint);
  if (needsGeminiTts(resolved.preferred)) {
    voiceSupportNote.textContent =
      `Reply in ${resolved.preferred}; audio via Google Gemini TTS (device has no native ${resolved.preferred} voice).`;
  } else if (resolved.fellBackToEnglish && resolved.preferred !== FALLBACK_LANGUAGE) {
    voiceSupportNote.textContent =
      `No ${resolved.preferred} voice installed — reply will be English.`;
  } else if (resolved.usedRelatedVoice) {
    voiceSupportNote.textContent =
      `Reply in ${resolved.preferred}; speaking with ${resolved.voice?.name || resolved.voiceLang} (closest installed voice).`;
  } else if ((replyLanguageSelect?.value || "auto") === "auto") {
    voiceSupportNote.textContent =
      resolved.effective === FALLBACK_LANGUAGE
        ? "Auto: English"
        : `Auto: ${resolved.effective}`;
  } else {
    voiceSupportNote.textContent = `Reply + voice: ${resolved.effective}`;
  }
  return resolved;
}

let geminiSpeechUrl = null;
let geminiSpeechAudio = null;

function stopGeminiSpeech() {
  if (geminiSpeechWaitResolve) {
    const resolve = geminiSpeechWaitResolve;
    geminiSpeechWaitResolve = null;
    resolve({ stopped: true });
  }
  if (geminiSpeechAudio) {
    try {
      geminiSpeechAudio.onended = null;
      geminiSpeechAudio.onerror = null;
      geminiSpeechAudio.pause();
      geminiSpeechAudio.removeAttribute("src");
      geminiSpeechAudio.load();
    } catch (_error) {
      // ignore
    }
    geminiSpeechAudio = null;
  }
  if (geminiSpeechUrl) {
    URL.revokeObjectURL(geminiSpeechUrl);
    geminiSpeechUrl = null;
  }
}

function needsGeminiTts(lang) {
  const base = String(lang || "").toLowerCase().split("-")[0];
  // Browser packs rarely include Nepali; Gemini TTS does (and covers ja/hi/…).
  if (!base || base === "en") {
    return false;
  }
  if (base === "ne") {
    return true;
  }
  const picked = pickSpeakVoice(lang);
  return Boolean(picked.fellBackToEnglish || picked.usedRelatedVoice);
}

function speakWithBrowser(text, lang = FALLBACK_LANGUAGE) {
  if (!synth || !text) {
    return;
  }

  synth.cancel();

  const start = () => {
    const picked = pickSpeakVoice(lang);
    const utteranceLang = picked.fellBackToEnglish ? FALLBACK_LANGUAGE : lang;
    const sentences = text.match(/[^.!?।৷。！？]+[.!?।৷。！？]+["')\]]*|[^.!?।৷。！？]+$/g) || [
      text
    ];
    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (!trimmed) {
        continue;
      }
      const utterance = new SpeechSynthesisUtterance(trimmed);
      utterance.lang = utteranceLang;
      if (picked.voice) {
        utterance.voice = picked.voice;
      }
      utterance.rate = 1.02;
      utterance.volume = 1;
      synth.speak(utterance);
    }
  };

  const voices = getSynthVoices();
  if (!voices.length) {
    synth.addEventListener("voiceschanged", start, { once: true });
    setTimeout(start, 250);
  } else {
    start();
  }
}

function speakWithGeminiTts(text, lang, token = runToken) {
  return fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, language: lang })
  }).then(async (response) => {
    if (!isCurrentRun(token)) {
      return;
    }
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `TTS HTTP ${response.status}`);
    }
    const blob = await response.blob();
    if (!isCurrentRun(token)) {
      return;
    }
    stopGeminiSpeech();
    geminiSpeechUrl = URL.createObjectURL(blob);
    geminiSpeechAudio = new Audio(geminiSpeechUrl);
    geminiSpeechAudio.volume = 1;
    await new Promise((resolve, reject) => {
      geminiSpeechWaitResolve = () => resolve({ stopped: true });
      geminiSpeechAudio.onended = () => {
        geminiSpeechWaitResolve = null;
        resolve({ stopped: false });
      };
      geminiSpeechAudio.onerror = () => {
        geminiSpeechWaitResolve = null;
        if (!isCurrentRun(token)) {
          resolve({ stopped: true });
          return;
        }
        reject(new Error("Audio playback failed"));
      };
      geminiSpeechAudio.play().catch((error) => {
        geminiSpeechWaitResolve = null;
        if (!isCurrentRun(token)) {
          resolve({ stopped: true });
          return;
        }
        reject(error);
      });
    });
  });
}

function speakWithBrowserAndWait(text, lang = FALLBACK_LANGUAGE, token = runToken) {
  return new Promise((resolve) => {
    if (!synth || !text || !isCurrentRun(token)) {
      resolve();
      return;
    }
    synth.cancel();
    const picked = pickSpeakVoice(lang);
    const utteranceLang = picked.fellBackToEnglish ? FALLBACK_LANGUAGE : lang;
    const sentences = text.match(/[^.!?।৷。！？]+[.!?।৷。！？]+["')\]]*|[^.!?।৷。！？]+$/g) || [
      text
    ];
    const queue = sentences.map((s) => s.trim()).filter(Boolean);
    if (!queue.length) {
      resolve();
      return;
    }

    // Headless Chrome often never fires utterance onend — don't hang Talk forever.
    const safety = setTimeout(() => resolve(), Math.min(10000, 1800 * queue.length + 1500));
    let index = 0;
    const finish = () => {
      clearTimeout(safety);
      resolve();
    };
    const speakNext = () => {
      if (!isCurrentRun(token)) {
        finish();
        return;
      }
      if (index >= queue.length) {
        finish();
        return;
      }
      const utterance = new SpeechSynthesisUtterance(queue[index]);
      index += 1;
      utterance.lang = utteranceLang;
      if (picked.voice) {
        utterance.voice = picked.voice;
      }
      utterance.rate = 1.05;
      utterance.volume = 1;
      utterance.onend = () => {
        if (!isCurrentRun(token)) {
          finish();
          return;
        }
        speakNext();
      };
      // cancel/interrupted must end the chain — never keep speaking after Stop.
      utterance.onerror = () => finish();
      synth.speak(utterance);
    };

    const voices = getSynthVoices();
    if (!voices.length) {
      synth.addEventListener("voiceschanged", speakNext, { once: true });
      setTimeout(speakNext, 250);
    } else {
      speakNext();
    }
  });
}

async function speak(text, lang = FALLBACK_LANGUAGE) {
  if (!text) {
    return;
  }
  const token = runToken;

  stopGeminiSpeech();
  if (synth) {
    synth.cancel();
  }
  if (!isCurrentRun(token)) {
    return;
  }

  if (!needsGeminiTts(lang)) {
    await speakWithBrowserAndWait(text, lang, token);
    return;
  }

  try {
    await speakWithGeminiTts(text, lang, token);
  } catch (error) {
    if (!isCurrentRun(token)) {
      return;
    }
    console.error("Gemini TTS failed, using browser voice:", error);
    if (voiceSupportNote) {
      voiceSupportNote.textContent =
        `Cloud voice unavailable (${error.message}). Trying device voice.`;
    }
    await speakWithBrowserAndWait(text, lang, token);
  }
}

function setEicFrame(frameUrl, citation, label) {
  if (earthScene && frameUrl) {
    earthScene.style.backgroundImage = `url("${frameUrl}")`;
  }
  if (citationLine && citation) {
    citationLine.textContent = citation;
  }
  if (trackLabel && label) {
    trackLabel.textContent = label;
  }
}

function isDryPrecipitation(rainMm) {
  // NASA POWER PRECTOTCORR at 0 mm/day means no measurable rain —
  // never sonify that as rainfall.
  return !(Number(rainMm) > 0);
}

async function playDryDayCue() {
  const ctx = await ensureAudio();
  stopActiveAudio();

  // Soft open fifth — calm / dry, deliberately not rain noise.
  const now = ctx.currentTime;
  for (const [freq, delay, peak] of [
    [196, 0, 0.12],
    [294, 0.08, 0.1]
  ]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.value = 0.0001;
    gain.gain.exponentialRampToValueAtTime(peak, now + delay + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + 1.4);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now + delay);
    osc.stop(now + delay + 1.5);
    activeNodes.push(osc);
  }
}

async function playRainSoundscape(rainMm) {
  const ctx = await ensureAudio();
  stopActiveAudio();

  const mm = Math.max(0, Number(rainMm) || 0);
  if (isDryPrecipitation(mm)) {
    await playDryDayCue();
    return;
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
  // Louder / brighter rain maps to higher precipitation.
  filter.frequency.value = Math.min(500 + mm * 280, 4200);
  filter.Q.value = 1.4;

  rainGainNode = ctx.createGain();
  // Gain scales with mm — no artificial floor that invents rain on dry days.
  const peak = Math.min(0.18 + mm / 18, 0.9);
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
    if (statusMessage && /soundscape playing|Playing rain/i.test(statusMessage.textContent || "")) {
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
    const label =
      sonify.type === "gistemp"
        ? "EIC visual: Global temperature · paired with GISTEMP"
        : "EIC visual: Atmospheric river · SVS 4960 · POWER rain";
    setEicFrame(
      sonify.frameUrl,
      `${sonify.citation || "NASA"} · track ${sonify.trackId}`,
      label
    );
  }

  if (sonify.type === "power-rain") {
    const niceDate = formatNasaDate(sonify.date);
    const rainMm = Number(sonify.rainfallMm) || 0;
    const dry = isDryPrecipitation(rainMm);
    const placeLabel = sonify.placeLabel || sonify.place || "Selected place";
    const note = sonify.availabilityNote
      ? `<br><span class="avail">${sonify.availabilityNote}</span>`
      : "";
    const soundNote = dry
      ? `<br><span class="avail">Dry day (0 mm) — calm cue, not rain noise.</span>`
      : "";
    const coords =
      sonify.lat != null && sonify.lon != null
        ? `<br><span class="avail">${Number(sonify.lat).toFixed(2)}°, ${Number(sonify.lon).toFixed(2)}°</span>`
        : "";
    dataDisplay.innerHTML =
      `<strong>NASA POWER · ${placeLabel}</strong><br>` +
      `Precipitation: <strong>${rainMm.toFixed(2)} mm/day</strong>` +
      `${dry ? " · no measurable rain" : ""}<br>` +
      `Temperature: <strong>${Number(sonify.temperatureC).toFixed(1)} °C</strong><br>` +
      `Date: <strong>${niceDate}</strong>${coords}${note}${soundNote}`;
    setIntensity(dry ? 0.08 : Math.min(rainMm / 20, 1));
    await playRainSoundscape(rainMm);
  }

  if (sonify.type === "gistemp") {
    dataDisplay.innerHTML =
      `<strong>NASA GISTEMP v4</strong><br>` +
      `Year: <strong>${sonify.year}</strong><br>` +
      `Global anomaly: <strong>${Number(sonify.anomalyC).toFixed(2)} °C</strong>`;
    setIntensity(Math.min(Math.max((Number(sonify.anomalyC) || 0) / 1.5, 0.15), 1));
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
        `${track.eicSource} · ${track.numericSource}`,
        `EIC visual: ${track.title || track.id} · SVS science frame`
      );
      dataDisplay.textContent =
        "Ask any city (rain in Tokyo), tap a quick place, or Talk and say a place name.";
      setIntensity(0.12);
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

function extractPlaceFromQuestion(question) {
  let text = String(question || "");
  text = text
    .replace(/\b(20\d{2})[-/]?(\d{2})[-/]?(\d{2})\b/gi, " ")
    .replace(
      /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}(?:,?\s*20\d{2})?\b/gi,
      " "
    )
    .replace(/\b(yesterday|today|tomorrow|now|current|latest|last\s+week)\b/gi, " ");

  const patterns = [
    /\b(?:rain|rainfall|precip(?:itation)?|weather|climate|temperature|monsoon|flood)\s+(?:in|for|at|around|near)\s+(.+)$/i,
    /\b(?:in|for|at|around|near)\s+(.+?)\s+(?:rain|rainfall|precip(?:itation)?|weather|climate|temperature|monsoon)\b/i,
    /^(.+?)\s+(?:rain|rainfall|precip(?:itation)?|weather|monsoon|flood)\b/i,
    /\b(?:rain|rainfall|precip(?:itation)?|weather|monsoon)\s+(.+)$/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const cleaned = match[1]
        .replace(/\b(please|tell me|about|the|a|an)\b/gi, " ")
        .replace(/[?!.]+$/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (cleaned.length >= 2) {
        return cleaned;
      }
    }
  }
  return null;
}

async function playNasaDirect(kind, question = "") {
  if (kind === "rain") {
    const date = extractRequestedDate(question);
    const place = extractPlaceFromQuestion(question) || "Kathmandu";
    const params = new URLSearchParams();
    if (date) {
      params.set("date", date);
    }
    params.set("place", place);
    const response = await fetch(`/api/nasa-weather?${params.toString()}`);
    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error || "NASA POWER failed");
    }
    const niceDate = formatNasaDate(data.date);
    const placeLabel = data.location?.label || data.location?.name || place;
    const sonify = {
      type: "power-rain",
      rainfallMm: data.rainfall,
      temperatureC: data.temperatureC,
      date: data.date,
      requestedDate: data.requestedDate,
      selection: data.selection,
      availabilityNote: data.availabilityNote,
      place: data.location?.name,
      placeLabel,
      country: data.location?.country || "",
      lat: data.location?.lat,
      lon: data.location?.lon,
      trackId: data.trackId,
      frameUrl: data.eicPairing?.frameUrl,
      citation: data.source?.citation
    };
    // One short spoken line only — chat must not speak a second overlapping summary.
    // English factual line; Gemini may localize the spoken reply when a regional voice exists.
    const rainMm = Number(data.rainfall) || 0;
    const reply = isDryPrecipitation(rainMm)
      ? `For ${placeLabel} on ${niceDate}, NASA POWER shows no measurable rainfall — zero millimeters per day — ` +
        `with air temperature around ${Number(data.temperatureC).toFixed(0)} degrees Celsius. Soft dry cue only; not rain.`
      : `For ${placeLabel} on ${niceDate}, rainfall was ${rainMm.toFixed(1)} ` +
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
  const token = bumpRunToken();
  stopActiveAudio();
  if (synth) {
    synth.cancel();
  }
  clearListeningWatchdog();
  setState("thinking", `Working on: “${trimmed}”…`);
  await playUnlockChirp();
  if (!isCurrentRun(token)) {
    setState("idle", "Stopped.");
    return;
  }

  const lower = trimmed.toLowerCase();
  const wantsTemp =
    lower.includes("global temperature") ||
    lower.includes("gistemp") ||
    (lower.includes("warming") && !lower.includes("rain"));
  const wantsRain =
    !wantsTemp &&
    (lower.includes("rain") ||
      lower.includes("precip") ||
      lower.includes("weather") ||
      lower.includes("monsoon") ||
      Boolean(extractPlaceFromQuestion(trimmed)));

  let direct = null;
  try {
    if (wantsRain) {
      direct = await playNasaDirect("rain", trimmed);
      const dry = isDryPrecipitation(direct?.sonify?.rainfallMm);
      const where = direct?.sonify?.placeLabel || "place";
      statusMessage.textContent = dry
        ? `Dry day in ${where} (0 mm) — calm cue, not rain. Fetching spoken summary…`
        : `Playing rain for ${where} (~${RAIN_DURATION_SEC}s). Fetching spoken summary…`;
    } else if (wantsTemp) {
      direct = await playNasaDirect("temp", trimmed);
      statusMessage.textContent = "Playing temperature tone. Fetching spoken summary…";
    }
  } catch (error) {
    console.error("NASA direct play failed:", error);
    statusMessage.textContent = error.message;
  }

  const placeHint = {
    name: direct?.sonify?.place || extractPlaceFromQuestion(trimmed) || "",
    country: direct?.sonify?.country || ""
  };
  const langPlan = updateVoiceSupportNote(placeHint) || resolveReplyLanguage(placeHint);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: trimmed,
        history,
        // Ask Gemini for the selected language even if we must borrow a related voice.
        replyLanguage: langPlan.fellBackToEnglish ? FALLBACK_LANGUAGE : langPlan.preferred
      }),
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

    // Prefer a single spoken answer. Server fallback is now localized to replyLanguage.
    let finalReply = data.reply;
    let speakLang = data.replyLanguage || langPlan.speakLang || langPlan.preferred;
    const replyLooksEnglishOnly =
      data.fallback &&
      (!data.replyLanguage || /^en([-_]|$)/i.test(data.replyLanguage)) &&
      direct?.reply;
    if (replyLooksEnglishOnly && langPlan.preferred && !/^en([-_]|$)/i.test(langPlan.preferred)) {
      // Should be rare after server localization; keep NASA numbers rather than silence.
      finalReply = direct.reply;
      speakLang = FALLBACK_LANGUAGE;
    }

    paMessage.textContent = finalReply;
    const langNote = langPlan.fellBackToEnglish
      ? ` · no regional voice installed, English`
      : langPlan.usedRelatedVoice
        ? ` · ${langPlan.preferred} via ${langPlan.voice?.name || langPlan.voiceLang}`
        : speakLang && !/^en([-_]|$)/i.test(speakLang)
          ? ` · speaking ${speakLang}`
          : "";
    statusMessage.textContent = data.fallback
      ? `Latest available POWER data. You asked: “${trimmed}”${langNote}`
      : `You asked: “${trimmed}”${langNote}`;

    if (!isCurrentRun(token)) {
      return;
    }

    // Don't restart rain/tone if already playing from the direct NASA path.
    if (data.sonify && !(direct && data.sonify.type === direct.sonify?.type)) {
      await applySonify(data.sonify);
    }
    if (!isCurrentRun(token)) {
      return;
    }

    await speak(finalReply, speakLang);
    if (!isCurrentRun(token) || suppressAutoListen) {
      return;
    }
    await maybeContinueConversation(speakLang);
  } catch (error) {
    console.error("CHAT ERROR:", error);
    if (!isCurrentRun(token)) {
      return;
    }
    if (direct?.reply) {
      statusMessage.textContent =
        "Played the latest available POWER day. Spoken summary used English NASA text.";
      await speak(direct.reply, FALLBACK_LANGUAGE);
      if (isCurrentRun(token) && !suppressAutoListen) {
        await maybeContinueConversation(FALLBACK_LANGUAGE);
      }
    } else {
      let message = error.message;
      if (error.name === "AbortError") {
        message = "That took too long. Please try again.";
      } else if (error instanceof TypeError) {
        message = "I can't reach the Jukebox server. Please check that it's running.";
      }
      statusMessage.textContent = message;
      await speak(message, FALLBACK_LANGUAGE);
    }
  } finally {
    clearTimeout(timer);
    if (state === "thinking") {
      setState("idle");
    }
  }
}

async function maybeContinueConversation(speakLang) {
  const token = runToken;
  if (!conversationActive || !keepTalkingEnabled() || suppressAutoListen) {
    return;
  }
  if (state === "listening" || state === "thinking") {
    return;
  }
  const listenLang = selectedListenLanguage();
  const promptLang = listenLang === "auto" ? FALLBACK_LANGUAGE : listenLang;
  await delay(350);
  if (!isCurrentRun(token) || !conversationActive || suppressAutoListen) {
    return;
  }
  await speak(promptFor(CONTINUE_PROMPTS, promptLang), promptLang);
  if (!isCurrentRun(token) || !conversationActive || suppressAutoListen) {
    return;
  }
  await delay(250);
  if (!isCurrentRun(token) || !conversationActive || suppressAutoListen) {
    return;
  }
  await startTalking({ prompted: true, fromConversation: true });
}

function getSpeechRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function createRecognition() {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) {
    return null;
  }

  const listenLang = selectedListenLanguage();
  const sttLang = recognitionLanguageFor(listenLang);
  const promptLang = listenLang === "auto" ? FALLBACK_LANGUAGE : listenLang;

  const instance = new Ctor();
  instance.lang = sttLang;
  instance.continuous = false;
  instance.interimResults = false;
  instance.maxAlternatives = 3;

  instance.onstart = () => {
    recognitionOutcome = null;
    setState(
      "listening",
      `Listening (${sttLang})… speak now`
    );
    if (voiceSupportNote) {
      voiceSupportNote.textContent =
        listenLang === "auto"
          ? "Talk language: English (Auto). Answers still follow the place."
          : `Talk language: ${sttLang}` +
            (sttLang !== listenLang ? ` (for ${listenLang} answers)` : "");
    }
    clearListeningWatchdog();
    listeningWatchdog = setTimeout(() => {
      try {
        instance.stop();
      } catch (_error) {
        // ignore
      }
    }, LISTEN_WATCHDOG_MS);
  };

  instance.onresult = (event) => {
    clearListeningWatchdog();
    const text = event.results[0][0].transcript.trim();
    if (!text) {
      recognitionOutcome = "error";
      setState("idle", "I didn't catch that. Try Talk again.");
      speak(promptFor(MISSED_PROMPTS, promptLang), promptLang);
      return;
    }
    recognitionOutcome = "result";
    askInput.value = text;
    setState("idle");

    if (isStopListeningPhrase(text)) {
      conversationActive = false;
      statusMessage.textContent = "Conversation paused.";
      const pause =
        promptLang === "ne-NP"
          ? "ठीक छ। कुराकानी रोकियो। जारी राख्न Talk थिच्नुहोस्।"
          : promptLang === "ja-JP"
            ? "わかりました。会話を一時停止しました。続けるときはTalkを押してください。"
            : promptLang === "hi-IN"
              ? "ठीक है। बातचीत रोक दी गई। जारी रखने के लिए Talk दबाएँ।"
              : "Okay. Conversation paused. Press Talk whenever you want to continue.";
      speak(pause, promptLang);
      return;
    }

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
    const message =
      RECOGNITION_ERRORS[event.error] || `Speech error: ${event.error}`;
    setState("idle", message);
    // Keep error details in English for troubleshooting; also nudge in selected language.
    speak(`${message} ${promptFor(MISSED_PROMPTS, promptLang)}`, promptLang);
  };

  instance.onend = () => {
    clearListeningWatchdog();
    if (recognitionOutcome === "aborted") {
      if (state === "listening") {
        setState("idle");
      }
      return;
    }
    if (state === "listening") {
      setState("idle");
      if (!recognitionOutcome) {
        statusMessage.textContent =
          "I didn't catch that. Try Talk again, or type your question.";
        speak(promptFor(MISSED_PROMPTS, promptLang), promptLang);
      }
    }
  };

  return instance;
}

async function startTalking(options = {}) {
  const prompted = Boolean(options.prompted);
  const fromConversation = Boolean(options.fromConversation);

  if (state === "thinking") {
    return;
  }

  // Prefer Gemini Live duplex Talk — avoids Chrome SpeechRecognition "network" flakes.
  if (!fromConversation && typeof window.jukeboxStartLiveTalk === "function") {
    const liveOk =
      typeof window.jukeboxLiveAvailable === "function"
        ? await window.jukeboxLiveAvailable()
        : true;
    if (liveOk || window.jukeboxLiveActive?.()) {
      const started = await window.jukeboxStartLiveTalk();
      if (started || window.jukeboxLiveActive?.()) {
        conversationActive = true;
        suppressAutoListen = true; // Live session owns turn-taking
        setState("idle");
        return;
      }
      setState(
        "idle",
        "Live Talk could not start. Falling back to Chrome speech, or type a question."
      );
    }
  }

  if (!getSpeechRecognitionCtor()) {
    const message =
      "Talk needs Gemini Live (API key) or Chrome/Edge speech. You can still type a question and press Ask.";
    setState("idle", message);
    await speak(message, FALLBACK_LANGUAGE);
    return;
  }

  // Conversation auto-listen must honor Stop.
  if (fromConversation && (suppressAutoListen || !conversationActive)) {
    return;
  }

  // If already listening, stop cleanly (silent — do not speak over Stop).
  if (state === "listening" && recognition) {
    stopEverything("Stopped listening.");
    return;
  }

  // New Talk cancels any in-flight answer / continue chain.
  const token = bumpRunToken();
  conversationActive = true;
  suppressAutoListen = false;

  // Stop any playing answer before opening the mic — overlapping audio breaks Talk.
  stopActiveAudio();
  if (synth) {
    synth.cancel();
  }

  const listenLang = selectedListenLanguage();
  const promptLang = listenLang === "auto" ? FALLBACK_LANGUAGE : listenLang;

  if (!prompted && !fromConversation) {
    await speak(promptFor(LISTEN_PROMPTS, promptLang), promptLang);
    if (!isCurrentRun(token) || suppressAutoListen) {
      return;
    }
    await delay(280);
  } else {
    await delay(180);
  }
  if (!isCurrentRun(token) || suppressAutoListen) {
    return;
  }

  // Soft cue after the prompt finishes — never during recognition.
  await playUnlockChirp();
  await delay(220);
  if (!isCurrentRun(token) || suppressAutoListen) {
    return;
  }

  // Fresh instance avoids Chrome "already started" dead ends.
  recognition = createRecognition();
  if (!recognition) {
    setState("idle", "Speech recognition unavailable in this browser.");
    return;
  }
  setState(
    "listening",
    `Starting microphone (${recognitionLanguageFor(listenLang)})…`
  );

  try {
    recognition.start();
  } catch (error) {
    console.error("START ERROR:", error);
    // Retry once with a brand-new instance.
    try {
      if (!isCurrentRun(token) || suppressAutoListen) {
        return;
      }
      recognition = createRecognition();
      recognition.start();
      return;
    } catch (retryError) {
      console.error("START RETRY ERROR:", retryError);
      const message =
        `Couldn't start the microphone (${retryError.name}). Check Chrome mic permission for localhost.`;
      setState("idle", message);
      await speak(message, FALLBACK_LANGUAGE);
    }
  }
}

// Talk stays enabled: Live path does not need Chrome SpeechRecognition.
talkButton.disabled = false;
talkButton.title =
  "Talk uses Gemini Live duplex when available (fallback: Chrome speech)";
if (getSpeechRecognitionCtor()) {
  recognition = createRecognition();
}
setBusy();
statusMessage.textContent =
  "Ready. Press Talk for live conversation (Gemini), or type a question.";

askForm.addEventListener("submit", (event) => {
  event.preventDefault();
  conversationActive = false;
  askPA(askInput.value);
});

talkButton.addEventListener("click", () => {
  startTalking();
});

[kathmanduBtn, tokyoBtn, gistempBtn].forEach((button) => {
  if (!button) {
    return;
  }
  button.addEventListener("click", () => {
    const question = button.getAttribute("data-question");
    if (question) {
      conversationActive = false;
      askInput.value = question;
      askPA(question);
    }
  });
});

if (stopAudioBtn) {
  stopAudioBtn.addEventListener("click", () => {
    stopEverything("Stopped.");
  });
}

if (replyLanguageSelect) {
  replyLanguageSelect.addEventListener("change", () => {
    updateVoiceSupportNote({});
  });
}

if (synth) {
  synth.addEventListener("voiceschanged", () => {
    updateVoiceSupportNote({});
  });
}

document.addEventListener("keydown", (event) => {
  if (event.altKey && (event.key === "t" || event.key === "T")) {
    event.preventDefault();
    startTalking();
  }
  if (event.altKey && (event.key === "s" || event.key === "S")) {
    event.preventDefault();
    stopAudioBtn?.click();
  }
});

updateVoiceSupportNote({});
loadDefaultTrack();
// Spoken orientation for screen-reader / voice-first users who land on the page.
statusMessage.textContent =
  "Ready. Press Talk, or Alt+T, and ask about rain in a city or global temperature.";

// Hooks for the optional Live duplex demo (live-duplex.js).
window.jukeboxStopEverything = stopEverything;
window.jukeboxApplyLiveSonify = (sonify) => {
  applySonify(sonify).catch((error) => {
    console.error("Live sonify failed:", error);
  });
};
