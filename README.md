# Earth Information Jukebox

A small web app for the **NASA Space Apps Challenge 2026** challenge *The Earth Information Jukebox*.

It lets you **see** a NASA Earth Information Center picture, **hear** real NASA rainfall or global temperature as sound, and **ask** questions by typing or talking.

Open locally after setup: [http://localhost:3000](http://localhost:3000)

---

## What this project is (in plain words)

Weather and climate data are usually charts. This app turns them into something you can listen to.

Example: ask about rain in Kathmandu or Tokyo. The app:

1. Finds that place on a map (latitude / longitude)
2. Downloads NASA POWER rainfall and temperature for that spot
3. Plays a rain sound if there was rain (or a calm sound if it was dry — **0 mm is not played as rain**)
4. Keeps a real NASA science image on screen (not a random stock photo)
5. Speaks a short summary out loud (you can pick Nepali, Japanese, etc.)

You can also ask about **global temperature** — that uses NASA GISTEMP and plays a tone that rises with the warming number.

---

## What is in this folder

| Item | What it is |
| --- | --- |
| `server.js` | The backend. Talks to NASA and Gemini, serves the web page |
| `public/` | The website you see in the browser (`index.html`, `app.js`, `styles.css`) |
| `.env.example` | Template for your secret keys (copy this to `.env`) |
| `.env` | Your real keys (do **not** commit this; it stays on your computer) |
| `DATASETS.md` | Which NASA datasets we use and why they count for the challenge |
| `package.json` | Node project settings and scripts (`npm start`, `npm test`) |
| `scripts/` | Automated checks so the demo path keeps working |
| `README.md` | This guide |

You do **not** need to edit the code to run a demo. You mainly need Node.js, a Gemini key, and Chrome.

---

## How it works (simple flow)

```
You ask “rain in Tokyo”
        ↓
Browser sends the question to our server
        ↓
Server finds Tokyo’s coordinates
        ↓
Server asks NASA POWER for rain + temperature there
        ↓
Browser plays sound (rain if mm > 0, calm if dry)
        ↓
Gemini (or a local NASA sentence if Gemini is busy) speaks a short answer
```

**Important honesty rules built in:**

- Background image = NASA SVS / Earth Information Center (see `DATASETS.md`)
- Numbers = NASA POWER or GISTEMP
- If rainfall is **0**, you hear a dry cue — not fake rain
- NASA POWER often lags a few days; the UI says “latest available day”
- If Nepali (or another language) has no matching system voice, the app tries a close voice (for Nepali, often Hindi) before falling back to English

---

## Before you start (checklist)

1. A Mac or PC with a terminal
2. [Node.js](https://nodejs.org/) installed (version 18 or newer is fine)
3. [Google Chrome](https://www.google.com/chrome/) or Edge (needed for Talk / microphone)
4. A free Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)
5. (Optional) a NASA API key from [api.nasa.gov](https://api.nasa.gov/) — **not required** for the main rain / temperature demo

---

## Step-by-step: run the app for the first time

### Step 1 — Open the project folder

In Terminal:

```bash
cd /path/to/earth-information-jukebox
```

(Use the real path on your machine.)

### Step 2 — Create your secret key file

```bash
cp .env.example .env
```

Open `.env` in any text editor and set:

```bash
GEMINI_API_KEY=paste-your-key-here
GEMINI_MODEL=gemini-3.8-flash
```

Save the file.

Optional later:

```bash
NASA_API_KEY=paste-nasa-key-here
```

### Step 3 — Install dependencies

```bash
npm install
```

Wait until it finishes. You only need this again if `package.json` changes.

### Step 4 — Start the server

```bash
env -u GEMINI_API_KEY -u GOOGLE_API_KEY npm start
```

Why `env -u ...`? Sometimes your Terminal already has an old Gemini key. Clearing those names makes the app use the key inside `.env`.

You should see something like “listening on port 3000”.

### Step 5 — Open the app

In Chrome, go to:

**http://localhost:3000**

Do a hard refresh the first time (`Cmd+Shift+R` on Mac) so you get the latest page.

### Step 6 — Try a 60-second demo

1. Click **Hear Kathmandu rain**  
   - You should hear a short chirp, then rain (or a dry cue if that day was 0 mm)  
   - Numbers appear under the buttons
2. Type `rain in Tokyo` and click **Ask**
3. Click **Hear global warming tone**
4. (Optional) Set **Speak reply in** to Nepali or Japanese, then Ask again
5. (Optional) Click **Talk**, allow the mic, and say `Kathmandu rainfall`

Click **Stop sound** anytime.

---

## What each button / control does

| Control | What happens |
| --- | --- |
| **Ask** | Sends your typed question to the server |
| **Talk** | Listens with the mic (Chrome), then asks the same way |
| **Hear Kathmandu rain** | Quick demo for Kathmandu NASA POWER rain |
| **Hear Tokyo rain** | Same idea for Tokyo |
| **Hear global warming tone** | Plays NASA GISTEMP as a tone |
| **Stop sound** | Stops rain / tone / speech |
| **Speak reply in** | Chooses the spoken language (Auto picks from the place when it can) |

---

## Things that often confuse beginners

**“It says latest day is a few days ago.”**  
That is normal. NASA POWER daily data is not instant. The app shows the newest day NASA has published.

**“I chose Nepali but it used another voice.”**  
Many Macs/Chrome installs do not ship a Nepali voice. The app will still ask for a Nepali **text** reply when Gemini works, and may speak it with the closest installed voice (often Hindi). Only if nothing usable is installed does it fall back to English.

**“Talk does nothing.”**  
Use Chrome or Edge, stay on `http://localhost:3000`, and allow microphone access.

**“I hear NASA… NASA… twice.”**  
That bug was fixed — you should hear one spoken answer per ask.

**“Gemini error / timeout.”**  
The rain/temperature sound still plays from NASA. The spoken line may use a short local NASA sentence instead of Gemini.

---

## NASA data we use

Details and challenge notes: **[DATASETS.md](./DATASETS.md)**

| What you see / hear | NASA source |
| --- | --- |
| Big background picture | [NASA SVS Earth Information Center](https://svs.gsfc.nasa.gov/gallery/earth-information-center/) (item [4960](https://svs.gsfc.nasa.gov/4960/)) |
| Local rain + temperature | [NASA POWER](https://power.larc.nasa.gov/) daily point data |
| Global warming tone | [NASA GISTEMP v4](https://data.giss.nasa.gov/gistemp/) |

Gemini is only the narrator. It is **not** the science source.

---

## Project layout (for when you are ready to peek at code)

```
Browser (Chrome)
  ├─ NASA EIC image on screen
  ├─ Web Audio (rain / dry cue / tone)
  ├─ Speech (Talk + spoken reply)
  └─ talks to Express server
        ├─ /api/nasa-weather?place=&date=  → NASA POWER
        ├─ /api/gistemp                   → GISTEMP
        ├─ /api/eic-tracks                → which EIC images we pair
        └─ /api/chat                      → Gemini + NASA context
```

---

## Tests (optional)

With the server already running:

```bash
npm test
```

That runs small automated checks for dates, NASA responses, Talk wiring, and rain stop behavior.

---

## Challenge fit (one sentence)

We pair official NASA EIC visuals with live sonification of NASA POWER / GISTEMP numbers, so people can ask about a place and **hear** honest Earth data.

## Repository

https://github.com/isha925/earth-information-jukebox
