# Earth Information Jukebox

**NASA Space Apps Challenge 2026** — *The Earth Information Jukebox*

Turn NASA Earth science into something you can **see, hear, and ask**.

Demo (local): [http://localhost:3000](http://localhost:3000)

---

## The problem

Monsoon rainfall and climate risk are often locked behind charts, dashboards, and jargon.
In places like **Kathmandu**, families, students, journalists, and emergency planners need a faster gut-check:

> Is rainfall rising? How unusual is this season against the planetary warming story?

Sight-only tools also shut out people who learn better by listening — or who cannot easily read dense visual dashboards.

## The solution

**Earth Information Jukebox** pairs official **NASA Earth Information Center (EIC)** visualizations with **real-time sonification** of NASA observation data, plus a short spoken answer.

1. An EIC / SVS science frame fills the screen (not stock photography).
2. NASA POWER rainfall/temperature for Kathmandu drives a rain soundscape.
3. NASA GISTEMP v4 global temperature anomaly drives a pitch-mapped tone.
4. Ask or Talk: Gemini narrates the numbers (with a local NASA fallback if Gemini is overloaded).

That is the challenge brief, solved for a concrete human need: **hearing water risk and climate context together**.

## Why this can win

| Prize signal | How we hit it |
| --- | --- |
| Solves a real problem | Kathmandu monsoon / flood awareness + accessible Earth literacy |
| Uses required NASA path | EIC/SVS frames + POWER + GISTEMP (see `DATASETS.md`) |
| Multi-sensory | Sight (EIC) + sound (sonify) + voice (Ask/Talk) |
| Demoable in 60 seconds | One click → rain; one phrase → dated POWER; one click → GISTEMP |
| Honest science | Shows POWER lag (“latest available day”) instead of faking “live now” |

## NASA datasets used

Full citations and eligibility notes: **[`DATASETS.md`](./DATASETS.md)**

| Layer | Source | Role |
| --- | --- | --- |
| Visual | [NASA SVS EIC gallery](https://svs.gsfc.nasa.gov/gallery/earth-information-center/) · [SVS 4960 atmospheric river](https://svs.gsfc.nasa.gov/4960/) | Dominant on-screen Earth story |
| Local water | [NASA POWER daily point](https://power.larc.nasa.gov/) `PRECTOTCORR`, `T2M` for Kathmandu | Rain sonification + spoken summary |
| Global climate | [NASA GISS GISTEMP v4](https://data.giss.nasa.gov/gistemp/) | Temperature anomaly tone |
| Optional key check | [api.nasa.gov](https://api.nasa.gov/) | Validates `NASA_API_KEY` (not required for POWER/GISTEMP/SVS) |

**Compliance:** We keep EIC frames as the visual plane and map underlying NASA numeric series to sound — aligned with Space Apps Connect GO-team guidance (#1844).

## Demo script (for judges)

1. Open Chrome → `http://localhost:3000`
2. Click **Hear Kathmandu monsoon rain**  
   - EIC atmospheric-river frame stays on screen  
   - Rain noise maps to POWER precipitation  
   - One short spoken summary (no double-talk)
3. Ask: `Kathmandu rain on November 10` or `Kathmandu rainfall yesterday`  
   - Dated POWER query; UI explains lag / nearest available day
4. Click **Hear global warming tone**  
   - GISTEMP anomaly → pitch
5. Optional: **Talk** → say `Kathmandu rainfall` (Chrome mic)

## How to run

```bash
cd /Users/amit/github/earth-information-jukebox
cp .env.example .env
# Required: GEMINI_API_KEY + GEMINI_MODEL=gemini-3.8-flash
# Optional: NASA_API_KEY (api.nasa.gov)
npm install
env -u GEMINI_API_KEY -u GOOGLE_API_KEY npm start
```

Open **http://localhost:3000** in Chrome or Edge.

### Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | Yes for Gemini narration | Google AI Studio key |
| `GEMINI_MODEL` | Recommended `gemini-3.8-flash` | Model id |
| `NASA_API_KEY` | No for core demo | api.nasa.gov probe only |
| `PORT` | No (default `3000`) | Server port |

> Tip: if your shell exports a stale `GEMINI_API_KEY`, start with `env -u GEMINI_API_KEY` so project `.env` wins.

## Architecture

```
Browser (Chrome)
  ├─ EIC/SVS frame (CSS background from NASA SVS)
  ├─ Web Audio sonification (rain / tone)
  ├─ SpeechRecognition (Talk) + speechSynthesis (reply)
  └─ fetch → Express API
        ├─ GET  /api/nasa-weather[?date=]  → NASA POWER
        ├─ GET  /api/gistemp              → GISTEMP v4
        ├─ GET  /api/eic-tracks           → curated EIC pairings
        ├─ GET  /api/nasa-key-check       → api.nasa.gov NEO probe
        └─ POST /api/chat                 → Gemini + NASA context
              └─ on 503/timeout → local NASA spoken fallback
```

## Tests

```bash
npm test
# equivalent to:
npm run test:unit && npm run test:api && npm run test:browser && npm run live-check
```

These benches assert EIC frame URLs, POWER/GISTEMP payloads, dated queries, spoken-date formatting, Talk wiring, and rain stop timing.

## Space Apps challenge fit

Challenge: *build an Earth Jukebox that pairs EIC visual frames with dynamic sonifications generated in real time.*

We do that, and ground it in a civic use case (Kathmandu water awareness) so the science is not abstract. Gemini is assistive narration only — the science truth is NASA POWER / GISTEMP / EIC.

## Team / fork

Working fork branch: `amitach/earth-information-jukebox` · `cursor/gemini-nasa-restore-822d`  
Upstream challenge repo: `isha925/earth-information-jukebox`
