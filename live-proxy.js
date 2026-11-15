/**
 * Gemini Live (BidiGenerateContent) proxy for free-tier duplex demo.
 * Keeps the API key on the server; browser talks to /api/live only.
 */
const { WebSocketServer, WebSocket } = require("ws");

const LIVE_MODEL =
  process.env.GEMINI_LIVE_MODEL || "gemini-2.5-flash-native-audio-latest";
const GEMINI_LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const LIVE_SYSTEM = `You are the spoken PA for Earth Information Jukebox, a NASA Space Apps project designed for visually impaired listeners.
You help people hear Earth science through data-driven soundscapes.
You are in a live full-duplex voice conversation. Keep answers conversational, natural, and concise.
Never use markdown, lists, headings, emoji, or URLs.
When the user asks about rain, weather, or a city, call get_nasa_weather.
When they ask about global warming or global temperature, call get_gistemp.
Treat tool results as ground truth.

CRITICAL AUDIO-FIRST WORKFLOW FOR VISUALLY IMPAIRED LISTENERS:
When NASA tool data is received, the browser automatically plays the real data soundscape (e.g. rain sound, calm dry day cue, or warming tone).
1. Do NOT immediately read out the full text report or numbers.
2. Follow this exact sequence:
   Step 1: First say: "Here is the soundscape for [Place]." (e.g., for rain: "Here is the rain soundscape for [Place].", for dry days with 0 mm rain: "Dry day for [Place] with zero millimeters of rain. Here is the calm soundscape.", for temperature: "Here is the global warming soundscape.")
   Step 2: Allow the soundscape to play and be heard by the listener.
   Step 3: Then ask: "Would you like additional info?"
3. If the user says "yes", "sure", "tell me more", or asks for more details, THEN provide the full spoken audio report explaining the NASA observation, precipitation numbers, and temperature.
4. If the user says "no", acknowledge briefly: "Okay."
If a preferred reply language is given, speak in that language.`;

function safeSend(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function explainLiveProblem(raw, statusCode) {
  const text = String(raw || "");
  const code = Number(statusCode) || 0;
  if (
    code === 429 ||
    /RESOURCE_EXHAUSTED|quota exceeded|rate limit/i.test(text)
  ) {
    return {
      code: "live_quota",
      what: "Gemini Live could not stay connected.",
      why: "This Google Cloud project's free daily Gemini quota is used up (shared by every API key in the same project).",
      next: "Type a city rain question (NASA still works), wait until midnight Pacific, or use a GEMINI_API_KEY from a different Google account/project and restart."
    };
  }
  if (
    code === 503 ||
    code === 500 ||
    /UNAVAILABLE|overloaded|high demand|try again|deadline|timed out|timeout/i.test(
      text
    )
  ) {
    return {
      code: "live_busy",
      what: "Google Live is busy or not responding.",
      why: "Gemini Live returned a temporary server error.",
      next: "Wait a minute and press Talk again. Or type “rain in Tokyo” — NASA POWER answers without Live."
    };
  }
  if (/401|403|API key|PERMISSION|UNAUTHENTICATED/i.test(text)) {
    return {
      code: "live_auth",
      what: "Gemini Live rejected this project's API key.",
      why: "The key is missing, invalid, or not allowed for Live audio.",
      next: "Put a valid GEMINI_API_KEY in .env and restart with: env -u GEMINI_API_KEY -u GOOGLE_API_KEY npm start"
    };
  }
  const short = (text || "Talk Live failed.").slice(0, 180);
  return {
    code: "live_failed",
    what: "Talk Live failed.",
    why: short,
    next: "Press Talk again, or type your question. If wake word is on, untick it once and retry Talk (mic handoff)."
  };
}

function friendlyGoogleBusyMessage(raw, statusCode) {
  const problem = explainLiveProblem(raw, statusCode);
  return [problem.what, problem.why, problem.next].filter(Boolean).join(" ");
}

function sendLiveError(client, raw, statusCode) {
  const problem = explainLiveProblem(raw, statusCode);
  safeSend(client, {
    type: "error",
    message: [problem.what, problem.why, problem.next].filter(Boolean).join(" "),
    ...problem
  });
}

function attachLiveProxy(httpServer, deps) {
  const { apiKey, fetchNasaPower, fetchGistempAnnual } = deps;
  const wss = new WebSocketServer({ server: httpServer, path: "/api/live" });

  wss.on("connection", (client) => {
    let gemini = null;
    let closed = false;

    const closeAll = () => {
      if (closed) {
        return;
      }
      closed = true;
      try {
        gemini?.close();
      } catch (_error) {
        // ignore
      }
      try {
        client.close();
      } catch (_error) {
        // ignore
      }
    };

    if (!apiKey) {
      sendLiveError(
        client,
        "GEMINI_API_KEY is not configured for Live duplex.",
        401
      );
      closeAll();
      return;
    }

    const connectGemini = (language) => {
      const url = `${GEMINI_LIVE_URL}?key=${encodeURIComponent(apiKey)}`;
      gemini = new WebSocket(url);

      gemini.on("open", () => {
        const lang = String(language || "en-US");
        const instruction =
          /^en([-_]|$)/i.test(lang)
            ? LIVE_SYSTEM
            : `${LIVE_SYSTEM}\nPreferred reply language BCP-47: ${lang}.`;

        gemini.send(
          JSON.stringify({
            setup: {
              model: `models/${LIVE_MODEL}`,
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: "Kore" }
                  }
                }
              },
              // So the UI can show “heard you / answering” while latency is high.
              inputAudioTranscription: {},
              outputAudioTranscription: {},
              systemInstruction: {
                parts: [{ text: instruction }]
              },
              tools: [
                {
                  functionDeclarations: [
                    {
                      name: "get_nasa_weather",
                      description:
                        "Fetch NASA POWER daily rainfall and temperature for a place.",
                      parameters: {
                        type: "OBJECT",
                        properties: {
                          place: {
                            type: "STRING",
                            description: "City or place name, e.g. Kathmandu or Tokyo"
                          },
                          date: {
                            type: "STRING",
                            description: "Optional YYYY-MM-DD observation date"
                          }
                        },
                        required: ["place"]
                      }
                    },
                    {
                      name: "get_gistemp",
                      description:
                        "Fetch the latest NASA GISTEMP global temperature anomaly."
                    }
                  ]
                }
              ]
            }
          })
        );
      });

      gemini.on("message", async (raw) => {
        let msg;
        try {
          msg = JSON.parse(String(raw));
        } catch (_error) {
          return;
        }

        if (msg.error) {
          const code = msg.error.code || msg.error.status;
          sendLiveError(client, msg.error.message || "Live API error", code);
          return;
        }

        if (msg.setupComplete) {
          safeSend(client, {
            type: "ready",
            model: LIVE_MODEL,
            message: "Live duplex ready. Speak anytime; you can interrupt."
          });
          return;
        }

        const sc = msg.serverContent;
        if (sc?.interrupted) {
          safeSend(client, { type: "interrupted" });
        }

        const parts = sc?.modelTurn?.parts || [];
        for (const part of parts) {
          if (part.inlineData?.data) {
            safeSend(client, {
              type: "audio",
              mimeType: part.inlineData.mimeType || "audio/pcm;rate=24000",
              data: part.inlineData.data
            });
          }
          if (part.text) {
            safeSend(client, { type: "transcript", role: "model", text: part.text });
          }
        }

        if (sc?.outputTranscription?.text) {
          safeSend(client, {
            type: "transcript",
            role: "model",
            text: sc.outputTranscription.text
          });
        }
        if (sc?.inputTranscription?.text) {
          safeSend(client, {
            type: "transcript",
            role: "user",
            text: sc.inputTranscription.text
          });
        }

        const toolCall = msg.toolCall;
        if (toolCall?.functionCalls?.length) {
          safeSend(client, {
            type: "phase",
            phase: "nasa",
            message: "Fetching NASA data for your question…"
          });
          const functionResponses = [];
          for (const call of toolCall.functionCalls) {
            try {
              let result;
              if (call.name === "get_nasa_weather") {
                const args = call.args || {};
                const payload = await fetchNasaPower({
                  place: args.place,
                  date: args.date
                });
                result = {
                  place: payload.location?.label || args.place,
                  country: payload.location?.country,
                  date: payload.date,
                  rainfallMmPerDay: payload.rainfall,
                  temperatureC: payload.temperatureC,
                  lat: payload.location?.lat,
                  lon: payload.location?.lon,
                  source: "NASA POWER"
                };
                safeSend(client, {
                  type: "nasa",
                  kind: "rain",
                  data: result
                });
              } else if (call.name === "get_gistemp") {
                const payload = await fetchGistempAnnual();
                result = {
                  latestYear: payload.latestYear,
                  anomalyC: payload.anomalyC,
                  source: "NASA GISTEMP v4"
                };
                safeSend(client, {
                  type: "nasa",
                  kind: "gistemp",
                  data: result
                });
              } else {
                result = { error: `Unknown tool ${call.name}` };
              }
              functionResponses.push({
                id: call.id,
                name: call.name,
                response: { result }
              });
            } catch (error) {
              functionResponses.push({
                id: call.id,
                name: call.name,
                response: { error: error.message || "Tool failed" }
              });
            }
          }
          if (gemini?.readyState === WebSocket.OPEN) {
            safeSend(client, {
              type: "phase",
              phase: "thinking",
              message: "NASA data ready — Google is preparing your spoken answer…"
            });
            gemini.send(
              JSON.stringify({
                toolResponse: { functionResponses }
              })
            );
          }
        }
      });

      gemini.on("unexpected-response", (_req, res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          sendLiveError(client, body, res.statusCode);
          closeAll();
        });
      });

      gemini.on("error", (error) => {
        sendLiveError(client, error.message || "Live WebSocket error");
      });

      gemini.on("close", () => {
        safeSend(client, { type: "closed" });
        if (!closed) {
          try {
            client.close();
          } catch (_error) {
            // ignore
          }
        }
      });
    };

    client.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch (_error) {
        return;
      }

      if (msg.type === "start") {
        if (gemini) {
          try {
            gemini.close();
          } catch (_error) {
            // ignore
          }
        }
        connectGemini(msg.language || "en-US");
        return;
      }

      if (!gemini || gemini.readyState !== WebSocket.OPEN) {
        return;
      }

      if (msg.type === "audio" && msg.data) {
        gemini.send(
          JSON.stringify({
            realtimeInput: {
              audio: {
                data: msg.data,
                mimeType: msg.mimeType || "audio/pcm;rate=16000"
              }
            }
          })
        );
        return;
      }

      if (msg.type === "audio_stream_end") {
        gemini.send(
          JSON.stringify({
            realtimeInput: { audioStreamEnd: true }
          })
        );
        return;
      }

      if (msg.type === "text" && msg.text) {
        gemini.send(
          JSON.stringify({
            clientContent: {
              turns: [
                {
                  role: "user",
                  parts: [{ text: String(msg.text).slice(0, 500) }]
                }
              ],
              turnComplete: true
            }
          })
        );
      }
    });

    client.on("close", closeAll);
    client.on("error", closeAll);
  });

  return wss;
}

module.exports = { attachLiveProxy, LIVE_MODEL };
