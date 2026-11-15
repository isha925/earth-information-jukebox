/**
 * Gemini Live (BidiGenerateContent) proxy for free-tier duplex demo.
 * Keeps the API key on the server; browser talks to /api/live only.
 */
const { WebSocketServer, WebSocket } = require("ws");

const LIVE_MODEL =
  process.env.GEMINI_LIVE_MODEL || "gemini-2.5-flash-native-audio-latest";
const GEMINI_LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const LIVE_SYSTEM = `You are the spoken PA for Earth Information Jukebox, a NASA Space Apps project.
You are in a live full-duplex voice conversation. Keep answers short: one to three spoken sentences.
Never use markdown, lists, emoji, or URLs.
When the user asks about rain, weather, or a city, call get_nasa_weather.
When they ask about global warming or global temperature, call get_gistemp.
Treat tool results as ground truth. If rainfall is zero, say it is a dry day.
If a preferred reply language is given, speak in that language.`;

function safeSend(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function friendlyGoogleBusyMessage(raw, statusCode) {
  const text = String(raw || "");
  const code = Number(statusCode) || 0;
  if (
    code === 429 ||
    code === 503 ||
    code === 500 ||
    /RESOURCE_EXHAUSTED|UNAVAILABLE|overloaded|high demand|quota|try again|deadline|timed out|timeout/i.test(
      text
    )
  ) {
    return "Google's servers look busy or not responding. Try again in a few minutes.";
  }
  if (/401|403|API key|PERMISSION|UNAUTHENTICATED/i.test(text)) {
    return "Gemini API key is missing or invalid on this machine. Check .env and restart the server.";
  }
  return text || "Talk Live failed. Try again in a few minutes.";
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
      safeSend(client, {
        type: "error",
        message: "GEMINI_API_KEY is not configured for Live duplex."
      });
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
          safeSend(client, {
            type: "error",
            message: friendlyGoogleBusyMessage(
              msg.error.message || "Live API error",
              code
            )
          });
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
          safeSend(client, {
            type: "error",
            message: friendlyGoogleBusyMessage(body, res.statusCode)
          });
          closeAll();
        });
      });

      gemini.on("error", (error) => {
        safeSend(client, {
          type: "error",
          message: friendlyGoogleBusyMessage(
            error.message || "Live WebSocket error"
          )
        });
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
