# Earth Information Jukebox

NASA Space Apps 2026 project: pair Earth Information Center visuals with
NASA-data sonification and a Gemini voice PA.

## Quick start

```bash
cd ~/github/earth-information-jukebox
cp .env.example .env   # set GEMINI_API_KEY + GEMINI_MODEL=gemini-3.8-flash
npm install
npm start
```

Open http://localhost:3000 in Chrome.

## What to try

1. Click **Talk with me** and allow the microphone.
2. Say **Kathmandu rainfall** — loads NASA POWER precipitation/temperature and plays a rain soundscape against the SVS EIC atmospheric-river frame.
3. Say **global temperature** — loads NASA GISTEMP v4 and plays a tone mapped to the anomaly.

## Data rules

See `DATASETS.md`. The UI must show NASA EIC/SVS frames, not stock imagery.
NASA POWER and GISTEMP need no API keys.

## API

- `GET /api/health`
- `GET /api/eic-tracks`
- `GET /api/nasa-weather` — NASA POWER Kathmandu window
- `GET /api/gistemp` — NASA GISTEMP v4 annual anomalies
- `POST /api/chat` — Gemini PA; attaches NASA context when the question matches
