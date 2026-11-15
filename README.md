# Earth Information Jukebox: Climate Sonification & AI PA

A browser-native web application that transforms live NASA climate data into organic weather soundscapes (rain simulation via Brownian noise), paired with AI-powered atmospheric commentary using the Gemini API.

## 🚀 Features
- **NASA POWER API Integration:** Fetches live precipitation and temperature data.
- **Organic Rain Soundscape:** Uses the Web Audio API with Brownian noise and dynamic biquad filtering to replicate natural rainfall intensity.
- **Gemini AI Insights (`gemini-1.5-flash`):** Generates real-time conversational commentary and atmospheric descriptions based on live climate metrics.
- **Voice PA Assistant:** Built-in Speech Recognition and Speech Synthesis to command and listen to your Earth audio experience.

## 🛠️ Tech Stack
- **Backend:** Node.js, Express, `dotenv`
- **Frontend:** HTML5, CSS3, Vanilla JavaScript, Web Audio API, Web Speech API
- **APIs:** NASA POWER API, Google Gemini API

## ⚙️ Setup & Installation
1. Clone the repository and switch to `branch_1`:
   ```bash
   git checkout branch_1