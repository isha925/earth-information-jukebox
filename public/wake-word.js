/**
 * Opt-in wake phrase (like Siri): "Hey Jukebox" / "Okay Earth" starts Talk.
 * Uses Chrome SpeechRecognition only for the short wake listen; Talk itself
 * still prefers Gemini Live. Off by default — always-on mic is a privacy choice.
 */
(() => {
  const wakeCheckbox = document.getElementById("wakeWordEnabled");
  const statusMessage = document.getElementById("statusMessage");
  const voiceSupportNote = document.getElementById("voiceSupportNote");

  if (!wakeCheckbox) {
    return;
  }

  const WAKE_PATTERNS = [
    /\bhey\s+jukebox\b/i,
    /\bok(?:ay)?\s+jukebox\b/i,
    /\bhello\s+jukebox\b/i,
    /\bhey\s+earth\b/i,
    /\bok(?:ay)?\s+earth\b/i,
    /\bhey\s+kapsicum\b/i
  ];

  let wakeRec = null;
  let wakeArmed = false;
  let restartTimer = null;
  let startingTalk = false;

  function getCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function setStatus(text) {
    if (statusMessage && text) {
      statusMessage.textContent = text;
    }
  }

  function matchesWake(text) {
    const value = String(text || "").trim();
    if (!value) {
      return false;
    }
    return WAKE_PATTERNS.some((re) => re.test(value));
  }

  function stopWakeRecognition() {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (wakeRec) {
      try {
        wakeRec.onresult = null;
        wakeRec.onerror = null;
        wakeRec.onend = null;
        wakeRec.stop();
      } catch (_error) {
        // ignore
      }
      wakeRec = null;
    }
  }

  function scheduleRestart(ms = 700) {
    if (!wakeArmed || startingTalk || window.jukeboxLiveActive?.()) {
      return;
    }
    if (restartTimer) {
      clearTimeout(restartTimer);
    }
    restartTimer = setTimeout(() => {
      restartTimer = null;
      startWakeRecognition();
    }, ms);
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function extractTrailingPrompt(text) {
    const raw = String(text || "").trim();
    const stripped = raw
      .replace(
        /^(?:.*?\b)?(?:hey\s+jukebox|ok(?:ay)?\s+jukebox|hello\s+jukebox|hey\s+earth|ok(?:ay)?\s+earth|hey\s+kapsicum)\b[\s,.:;!?-]*/i,
        ""
      )
      .trim();
    return stripped.length >= 2 ? stripped : "";
  }

  async function triggerTalkFromWake(heard) {
    if (startingTalk || window.jukeboxLiveActive?.()) {
      return;
    }
    startingTalk = true;
    wakeArmed = true;
    stopWakeRecognition();
    const trailing = extractTrailingPrompt(heard);
    if (trailing) {
      setStatus(`Heard trigger word and prompt: “${trailing}”…`);
    } else {
      setStatus(`Heard “${heard}” — releasing mic, then starting Talk…`);
    }
    try {
      // Chrome SpeechRecognition keeps the mic briefly after stop(); Live
      // getUserMedia fails or the session dies ~3s later without this gap.
      await delay(900);
      if (typeof window.jukeboxStartTalk === "function") {
        await window.jukeboxStartTalk({ fromWake: true, question: trailing });
      } else {
        document.getElementById("talkButton")?.click();
      }
    } finally {
      startingTalk = false;
      // If Live did not start, resume wake listen later (don't fight the error UI).
      if (wakeCheckbox.checked && !window.jukeboxLiveActive?.() && !window.jukeboxIsActive?.()) {
        scheduleRestart(2500);
      }
    }
  }

  function startWakeRecognition() {
    const Ctor = getCtor();
    if (!Ctor || !wakeArmed || !wakeCheckbox.checked) {
      return;
    }
    if (window.jukeboxLiveActive?.() || startingTalk) {
      return;
    }

    stopWakeRecognition();
    const instance = new Ctor();
    wakeRec = instance;
    instance.lang = "en-US";
    instance.continuous = true;
    instance.interimResults = true;
    instance.maxAlternatives = 3;

    instance.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result?.[0]?.transcript || "";
        if (matchesWake(text)) {
          triggerTalkFromWake(text.trim());
          return;
        }
      }
    };

    instance.onerror = (event) => {
      // network/no-speech: keep trying; not-allowed: disarm with guidance
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        wakeCheckbox.checked = false;
        wakeArmed = false;
        setStatus(
          "Wake word needs microphone permission. Enable “Hey Jukebox” again after allowing the mic."
        );
        return;
      }
      scheduleRestart(event.error === "network" ? 2500 : 900);
    };

    instance.onend = () => {
      scheduleRestart(600);
    };

    try {
      instance.start();
      setStatus('Listening for “Hey Jukebox” or “Okay Earth”…');
      if (voiceSupportNote) {
        voiceSupportNote.textContent =
          "Wake word on (Chrome). Say Hey Jukebox — Talk still uses Gemini Live.";
      }
    } catch (_error) {
      scheduleRestart(1200);
    }
  }

  function enableWake() {
    if (!getCtor()) {
      wakeCheckbox.checked = false;
      setStatus(
        "Wake word needs Chrome or Edge speech for the trigger phrase. Talk itself can still use Gemini Live."
      );
      return;
    }
    wakeArmed = true;
    startWakeRecognition();
  }

  function disableWake() {
    wakeArmed = false;
    stopWakeRecognition();
    if (!window.jukeboxLiveActive?.()) {
      setStatus("Wake word off. Press Talk anytime.");
    }
  }

  wakeCheckbox.addEventListener("change", () => {
    if (wakeCheckbox.checked) {
      enableWake();
    } else {
      disableWake();
    }
  });

  // After Live Talk ends, resume wake listening if still opted in.
  window.jukeboxOnLiveEnded = () => {
    if (wakeCheckbox.checked) {
      wakeArmed = true;
      // Longer gap so Live fully releases the mic before wake grabs it again.
      scheduleRestart(1600);
    }
  };

  window.jukeboxStopWake = disableWake;
  window.jukeboxPauseWake = stopWakeRecognition;
  window.jukeboxWakeMatches = matchesWake;
})();
