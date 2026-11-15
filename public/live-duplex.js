/**
 * Gemini Live duplex engine for Talk (free-tier native audio).
 * Talk calls window.jukeboxStartLiveTalk() so Chrome SpeechRecognition
 * is no longer required on the happy path.
 */
(() => {
  const talkButton = document.getElementById("talkButton");
  const statusMessage = document.getElementById("statusMessage");
  const paMessage = document.getElementById("paMessage");
  const dataDisplay = document.getElementById("dataDisplay");
  const replyLanguageSelect = document.getElementById("replyLanguage");
  const voiceSupportNote = document.getElementById("voiceSupportNote");
  const processCue = document.getElementById("liveProcessCue");
  const processCueText = document.getElementById("liveProcessCueText");

  const INPUT_RATE = 16000;
  const OUTPUT_RATE = 24000;
  const ANSWER_WATCHDOG_MS = 22000;
  const BUSY_MESSAGE =
    "Google's servers look busy or not responding. Try again in a few minutes.";

  let ws = null;
  let liveActive = false;
  let mediaStream = null;
  let captureCtx = null;
  let captureNode = null;
  let captureSource = null;
  let playbackCtx = null;
  let nextPlayTime = 0;
  let activeSources = [];
  let modelTranscript = "";
  let liveAvailable = null; // null = unknown, boolean after health probe
  let answerWatchdog = null;
  let awaitingAnswer = false;

  function setStatus(text) {
    if (statusMessage) {
      statusMessage.textContent = text;
    }
  }

  function setProcessCue(phase, message) {
    if (!processCue || !processCueText) {
      return;
    }
    if (!phase || phase === "idle") {
      processCue.hidden = true;
      processCue.classList.remove("is-error", "is-listening");
      processCueText.textContent = "";
      return;
    }
    processCue.hidden = false;
    processCue.classList.toggle("is-error", phase === "error");
    processCue.classList.toggle("is-listening", phase === "listening");
    processCueText.textContent = message || "Working…";
    processCue.dataset.phase = phase;
  }

  function clearAnswerWatchdog() {
    if (answerWatchdog) {
      clearTimeout(answerWatchdog);
      answerWatchdog = null;
    }
  }

  function armAnswerWatchdog() {
    clearAnswerWatchdog();
    awaitingAnswer = true;
    answerWatchdog = setTimeout(() => {
      if (!liveActive || !awaitingAnswer) {
        return;
      }
      setProcessCue("error", BUSY_MESSAGE);
      setStatus(BUSY_MESSAGE);
    }, ANSWER_WATCHDOG_MS);
  }

  function friendlyClientError(raw) {
    const text = String(raw || "");
    if (
      /busy|not responding|RESOURCE_EXHAUSTED|UNAVAILABLE|429|503|quota|overloaded|timed out|timeout/i.test(
        text
      )
    ) {
      return BUSY_MESSAGE;
    }
    if (/API key|401|403|UNAUTHENTICATED|invalid/i.test(text)) {
      return "Gemini API key is missing or invalid on this machine. Check .env and restart the server.";
    }
    return text || BUSY_MESSAGE;
  }

  function setTalkLiveUi(on) {
    liveActive = on;
    if (!talkButton) {
      return;
    }
    talkButton.classList.toggle("is-listening", on);
    talkButton.classList.toggle("is-live", on);
    talkButton.setAttribute("aria-pressed", on ? "true" : "false");
    talkButton.textContent = on ? "Live… (click to stop)" : "Talk";
    if (!on) {
      clearAnswerWatchdog();
      awaitingAnswer = false;
      setProcessCue("idle");
    }
  }

  function clearPlayback() {
    for (const source of activeSources) {
      try {
        source.stop();
      } catch (_error) {
        // ignore
      }
    }
    activeSources = [];
    nextPlayTime = 0;
  }

  function base64ToInt16(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Int16Array(bytes.buffer);
  }

  function int16ToBase64(int16) {
    const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  async function ensurePlaybackCtx() {
    if (!playbackCtx) {
      playbackCtx = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: OUTPUT_RATE
      });
    }
    if (playbackCtx.state === "suspended") {
      await playbackCtx.resume();
    }
    return playbackCtx;
  }

  async function playPcmBase64(base64, mimeType) {
    const ctx = await ensurePlaybackCtx();
    const rateMatch = String(mimeType || "").match(/rate=(\d+)/i);
    const sampleRate = rateMatch ? Number(rateMatch[1]) : OUTPUT_RATE;
    const samples = base64ToInt16(base64);
    if (!samples.length) {
      return;
    }
    const buffer = ctx.createBuffer(1, samples.length, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) {
      channel[i] = samples[i] / 32768;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime + 0.02, nextPlayTime || ctx.currentTime + 0.02);
    source.start(startAt);
    nextPlayTime = startAt + buffer.duration;
    activeSources.push(source);
    source.onended = () => {
      activeSources = activeSources.filter((s) => s !== source);
      if (liveActive && activeSources.length === 0 && !awaitingAnswer) {
        setProcessCue(
          "listening",
          "Listening — ask another place, or press Stop"
        );
      }
    };
  }

  async function startCapture() {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    captureCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: INPUT_RATE
    });
    if (captureCtx.state === "suspended") {
      await captureCtx.resume();
    }
    captureSource = captureCtx.createMediaStreamSource(mediaStream);
    const bufferSize = 4096;
    captureNode = captureCtx.createScriptProcessor(bufferSize, 1, 1);
    captureNode.onaudioprocess = (event) => {
      if (!ws || ws.readyState !== WebSocket.OPEN || !liveActive) {
        return;
      }
      const input = event.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(input.length);
      for (let i = 0; i < input.length; i += 1) {
        const s = Math.max(-1, Math.min(1, input[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      ws.send(
        JSON.stringify({
          type: "audio",
          mimeType: "audio/pcm;rate=16000",
          data: int16ToBase64(int16)
        })
      );
    };
    captureSource.connect(captureNode);
    // Keep the processor graph alive without monitoring through speakers.
    const mute = captureCtx.createGain();
    mute.gain.value = 0;
    captureNode.connect(mute);
    mute.connect(captureCtx.destination);
  }

  function stopCapture() {
    try {
      captureNode?.disconnect();
    } catch (_error) {
      // ignore
    }
    try {
      captureSource?.disconnect();
    } catch (_error) {
      // ignore
    }
    captureNode = null;
    captureSource = null;
    if (captureCtx) {
      captureCtx.close().catch(() => {});
      captureCtx = null;
    }
    if (mediaStream) {
      for (const track of mediaStream.getTracks()) {
        track.stop();
      }
      mediaStream = null;
    }
  }

  function stopLive(reason = "Talk stopped.") {
    const wasActive = liveActive;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "audio_stream_end" }));
      } catch (_error) {
        // ignore
      }
    }
    try {
      ws?.close();
    } catch (_error) {
      // ignore
    }
    ws = null;
    stopCapture();
    clearPlayback();
    setTalkLiveUi(false);
    setStatus(reason);
    if (wasActive && typeof window.jukeboxOnLiveEnded === "function") {
      window.jukeboxOnLiveEnded();
    }
  }

  function handleNasa(message) {
    const data = message.data || {};
    if (message.kind === "rain") {
      if (dataDisplay) {
        dataDisplay.textContent =
          `NASA POWER · ${data.place || "?"}\n` +
          `Precipitation: ${Number(data.rainfallMmPerDay).toFixed(2)} mm/day\n` +
          `Temperature: ${Number(data.temperatureC).toFixed(1)} °C\n` +
          `Date: ${data.date || "?"}`;
      }
      if (typeof window.jukeboxApplyLiveSonify === "function") {
        window.jukeboxApplyLiveSonify({
          type: "rain",
          rainfallMm: data.rainfallMmPerDay,
          placeLabel: data.place,
          date: data.date
        });
      }
    } else if (message.kind === "gistemp") {
      if (dataDisplay) {
        dataDisplay.textContent =
          `NASA GISTEMP · ${data.latestYear}\n` +
          `Anomaly: ${Number(data.anomalyC).toFixed(2)} °C`;
      }
      if (typeof window.jukeboxApplyLiveSonify === "function") {
        window.jukeboxApplyLiveSonify({
          type: "gistemp",
          anomalyC: data.anomalyC,
          year: data.latestYear
        });
      }
    }
  }

  async function probeLiveAvailable() {
    if (liveAvailable !== null) {
      return liveAvailable;
    }
    try {
      const health = await fetch("/api/health").then((r) => r.json());
      liveAvailable = Boolean(health.liveDuplex);
      return liveAvailable;
    } catch (_error) {
      liveAvailable = false;
      return false;
    }
  }

  /**
   * @returns {Promise<boolean>} true if Live Talk started (or toggled off while active)
   */
  async function startLiveTalk() {
    if (liveActive) {
      stopLive("Talk stopped.");
      return true;
    }

    const available = await probeLiveAvailable();
    if (!available) {
      return false;
    }

    if (typeof window.jukeboxPauseWake === "function") {
      window.jukeboxPauseWake();
    }
    if (typeof window.jukeboxStopEverything === "function") {
      window.jukeboxStopEverything("Starting Talk (Live)…");
    }

    modelTranscript = "";
    setTalkLiveUi(true);
    setProcessCue("connecting", "Connecting to Google Live…");
    setStatus("Connecting Talk over Gemini Live…");

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const started = await new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(ok);
      };

      ws = new WebSocket(`${proto}://${location.host}/api/live`);

      const failTimer = setTimeout(() => {
        const message = BUSY_MESSAGE;
        setProcessCue("error", message);
        stopLive(message);
        finish(false);
      }, 15000);

      ws.onopen = async () => {
        const language = replyLanguageSelect?.value || "en-US";
        setProcessCue("connecting", "Connected — starting microphone…");
        ws.send(JSON.stringify({ type: "start", language }));
        try {
          await startCapture();
        } catch (error) {
          clearTimeout(failTimer);
          stopLive(`Microphone blocked: ${error.message}`);
          finish(false);
        }
      };

      ws.onmessage = async (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch (_error) {
          return;
        }

        if (msg.type === "ready") {
          clearTimeout(failTimer);
          setProcessCue(
            "listening",
            "Listening — ask about rain in a city or global temperature"
          );
          setStatus(
            msg.message ||
              "Talk is live — speak anytime; you can interrupt. NASA tools stay on."
          );
          if (paMessage) {
            paMessage.textContent =
              "I'm listening live. Ask about rain in a city or global temperature.";
          }
          if (voiceSupportNote) {
            voiceSupportNote.textContent =
              `Talk uses Gemini Live (${msg.model || "native audio"}) — not Chrome speech.`;
          }
          finish(true);
          return;
        }
        if (msg.type === "phase") {
          setProcessCue(msg.phase || "thinking", msg.message || "Working…");
          setStatus(msg.message || "Working…");
          if (msg.phase === "thinking" || msg.phase === "nasa") {
            armAnswerWatchdog();
          }
          return;
        }
        if (msg.type === "audio") {
          awaitingAnswer = false;
          clearAnswerWatchdog();
          setProcessCue("speaking", "Speaking your NASA answer…");
          await playPcmBase64(msg.data, msg.mimeType);
          return;
        }
        if (msg.type === "interrupted") {
          clearPlayback();
          awaitingAnswer = false;
          clearAnswerWatchdog();
          setProcessCue("listening", "Interrupted — still listening…");
          setStatus("Interrupted — still listening…");
          return;
        }
        if (msg.type === "transcript") {
          if (msg.role === "user" && msg.text) {
            setProcessCue(
              "heard",
              `Heard you — processing: “${String(msg.text).trim().slice(0, 80)}”`
            );
            setStatus("Heard you — fetching answer…");
            armAnswerWatchdog();
          }
          if (msg.role === "model" && msg.text) {
            modelTranscript += msg.text;
            if (paMessage) {
              paMessage.textContent = modelTranscript.trim();
            }
          }
          return;
        }
        if (msg.type === "nasa") {
          setProcessCue("nasa", "NASA data received — preparing spoken answer…");
          handleNasa(msg);
          armAnswerWatchdog();
          return;
        }
        if (msg.type === "error") {
          clearTimeout(failTimer);
          clearAnswerWatchdog();
          const message = friendlyClientError(msg.message);
          setProcessCue("error", message);
          stopLive(message);
          finish(false);
          return;
        }
        if (msg.type === "closed") {
          clearTimeout(failTimer);
          if (liveActive) {
            stopLive("Talk Live closed.");
          }
          finish(false);
        }
      };

      ws.onerror = () => {
        clearTimeout(failTimer);
        const message = BUSY_MESSAGE;
        setProcessCue("error", message);
        stopLive(message);
        finish(false);
      };

      ws.onclose = () => {
        clearTimeout(failTimer);
        if (liveActive) {
          stopLive("Talk Live closed.");
        }
      };
    });

    return started;
  }

  window.jukeboxStartLiveTalk = startLiveTalk;
  window.jukeboxStopLive = () => {
    if (liveActive) {
      stopLive("Stopped.");
    }
  };
  window.jukeboxLiveActive = () => liveActive;
  window.jukeboxLiveAvailable = probeLiveAvailable;

  // Warm the health probe so Talk can decide quickly.
  probeLiveAvailable().then((ok) => {
    if (ok && voiceSupportNote && !voiceSupportNote.textContent) {
      voiceSupportNote.textContent =
        "Talk uses Gemini Live (free-tier duplex). Chrome speech is only a fallback.";
    }
  });
})();
