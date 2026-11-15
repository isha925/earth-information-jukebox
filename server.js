const express = require("express");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.static("."));

// Unified Endpoint: Calls NASA API and Gemini API simultaneously
app.get("/api/climate-sonification-insights", async (req, res) => {
  const lat = "27.7172"; // Kathmandu latitude
  const lon = "85.3240"; // Kathmandu longitude
  
  const nasaApiKey = process.env.NASA_API_KEY || "DEMO_KEY";
  const geminiApiKey = process.env.GEMINI_API_KEY;

  if (!geminiApiKey) {
    return res.status(500).json({ error: "Gemini API key is missing from environment variables." });
  }

  try {
    const nasaUrl = `https://power.larc.nasa.gov/api/temporal/daily/point?parameters=PRECTOTCORR,T2M&community=RE&longitude=${lon}&latitude=${lat}&start=20240101&end=20240107&format=JSON&api_key=${nasaApiKey}`;
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`;

    // 1. Fetch NASA Data
    const nasaResponse = await fetch(nasaUrl);
    const nasaData = await nasaResponse.json();

    if (!nasaData.properties || !nasaData.properties.parameter) {
      return res.status(500).json({ error: "Invalid response structure from NASA API." });
    }

    const precipitationData = nasaData.properties.parameter.PRECTOTCORR;
    const dates = Object.keys(precipitationData);
    const latestDate = dates[dates.length - 1];
    const rainfallMm = precipitationData[latestDate] !== undefined ? precipitationData[latestDate] : 0;

    // 2. Prepare prompt for Gemini based on live climate data
    const aiPrompt = `We are converting live NASA climate data into a weather soundscape. For Kathmandu on ${latestDate}, the daily precipitation is ${rainfallMm.toFixed(2)} mm/day. Provide a short, engaging 1-sentence atmospheric description of this weather condition for an audio PA system.`;

    const geminiPayload = {
      contents: [{
        parts: [{ text: aiPrompt }]
      }]
    };

    // 3. Call Gemini API
    const geminiResponse = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiPayload)
    });

    const geminiResult = await geminiResponse.json();
    console.log("Gemini Raw Response:", JSON.stringify(geminiResult, null, 2));
    
    let aiCommentary = "Live climate data loaded successfully for sonification.";
    try {
      if (geminiResult.candidates?.[0]?.content?.parts?.[0]?.text) {
        aiCommentary = geminiResult.candidates[0].content.parts[0].text.trim();
      } else if (geminiResult.error) {
        aiCommentary = `AI Error: ${geminiResult.error.message}`;
      }
    } catch (e) {
      console.error("Error parsing Gemini response:", e);
    }

    console.log(`[Dual API Success] NASA Rain: ${rainfallMm} mm | AI Insight: ${aiCommentary}`);

    // Send combined payload back to frontend
    res.json({
      location: "Kathmandu",
      date: latestDate,
      rainfall: rainfallMm,
      aiInsight: aiCommentary
    });

  } catch (error) {
    console.error("Dual API Execution Error:", error);
    res.status(500).json({ error: "Failed to fetch data from NASA and Gemini APIs simultaneously." });
  }
});

app.listen(3000, () => console.log("Server running at http://localhost:3000 with Dual API integration."));