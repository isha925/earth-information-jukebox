# Datasets and challenge alignment

This project targets **NASA Space Apps 2026 — The Earth Information Jukebox**.

Challenge intent: pair **NASA Earth Information Center (EIC) visual frames** with
**real-time sonification** driven by NASA Earth science data.

## Required visual layer (EIC)

| Asset | Why it counts | URL |
| --- | --- | --- |
| NASA SVS EIC gallery | Official EIC Hyperwall content gallery | https://svs.gsfc.nasa.gov/gallery/earth-information-center/ |
| SVS item 4960 atmospheric river | EIC water-resources story frame used as the default visual | https://svs.gsfc.nasa.gov/4960/ |
| Earth.gov | EIC public portal for climate/water themes | https://earth.gov/ |

Do **not** substitute decorative stock photos (for example Unsplash) for EIC frames.
That would break the challenge brief.

## Numeric drivers (NASA open data)

| Dataset | Parameters used | Access | Role in app |
| --- | --- | --- | --- |
| NASA POWER Agroclimatology API | `PRECTOTCORR`, `T2M` daily point for Kathmandu | No key | Local rainfall/temperature sonification paired with the atmospheric-river EIC frame |
| NASA GISS GISTEMP v4 | Annual global anomaly (`J-D`) from `GLB.Ts+dSST.csv` | No key | Global temperature sonification for the EIC climate theme |

Endpoints:

- POWER: `https://power.larc.nasa.gov/api/temporal/daily/point`
- GISTEMP: `https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv`

## Eligibility notes

- For Global Awards, use at least one NASA source listed in the challenge Resources tab and cite it.
- GO-team clarification (Space Apps Connect discussion #1844): either EIC-frame feature analysis **or** underlying NASA numeric datasets is acceptable, as long as the experience stays meaningfully connected to the EIC visualization and science story.
- This app keeps the EIC frame as the visual plane and maps NASA POWER / GISTEMP values to sound.

## Voice / LLM

Google Gemini (`GEMINI_API_KEY`, model `gemini-3.8-flash`) narrates the NASA numbers.
Gemini is not a NASA dataset; it only explains the NASA observations aloud.
