require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

app.use(cors());
app.use(express.json());

// ── HEALTH CHECK ──
app.get("/", (req, res) => {
  res.json({ status: "VacayHelper backend running ✅" });
});

// ── 1. CITY AUTOCOMPLETE ──
// Gets city suggestions from Google as user types
app.get("/api/autocomplete", async (req, res) => {
  const { input, country } = req.query;
  if (!input) return res.status(400).json({ error: "input required" });

  const components = country ? `&components=country:${country}` : "";
  const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&types=(cities)${components}&key=${GOOGLE_API_KEY}&language=en`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 2. SEARCH HOTELS ──
// Finds hotels in a city using Google Places
app.get("/api/hotels", async (req, res) => {
  const { city, country } = req.query;
  if (!city) return res.status(400).json({ error: "city required" });

  const query = `hotels in ${city}${country ? " " + country : ""}`;
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&type=lodging&key=${GOOGLE_API_KEY}&language=en`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    // Filter: minimum 80 Google reviews
    const filtered = (data.results || []).filter(h => h.user_ratings_total >= 80);
    res.json({ results: filtered, status: data.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 3. HOTEL DETAILS ──
// Gets full details, photos and reviews for a specific hotel
app.get("/api/hotel-details", async (req, res) => {
  const { placeId } = req.query;
  if (!placeId) return res.status(400).json({ error: "placeId required" });

  const fields = "name,rating,user_ratings_total,formatted_address,photos,website,price_level,reviews,types";
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=${fields}&key=${GOOGLE_API_KEY}&language=en`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 4. PHOTO URL ──
// Returns direct Google photo URL for a hotel image
app.get("/api/photo", async (req, res) => {
  const { photoRef, maxWidth = 800 } = req.query;
  if (!photoRef) return res.status(400).json({ error: "photoRef required" });

  const url = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${maxWidth}&photoreference=${photoRef}&key=${GOOGLE_API_KEY}`;

  try {
    const response = await fetch(url);
    res.set("Content-Type", response.headers.get("content-type"));
    response.body.pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 5. AI MATCH ANALYSIS ──
// Uses Claude to check if a hotel matches user preferences
// Reads Google reviews and hotel description to decide
app.post("/api/match", async (req, res) => {
  const { hotel, userPreferences } = req.body;
  if (!hotel || !userPreferences) {
    return res.status(400).json({ error: "hotel and userPreferences required" });
  }

  // Build prompt for Claude
  const reviewsText = (hotel.reviews || [])
    .slice(0, 5)
    .map(r => `"${r.text}"`)
    .join("\n");

  const prompt = `You are a hotel matching expert. Analyze if this hotel matches the user's preferences.

HOTEL: ${hotel.name}
LOCATION: ${hotel.formatted_address || ""}
GOOGLE RATING: ${hotel.rating} (${hotel.user_ratings_total} reviews)
HOTEL TYPES: ${(hotel.types || []).join(", ")}
PRICE LEVEL: ${hotel.price_level ? "★".repeat(hotel.price_level) : "unknown"}

RECENT GOOGLE REVIEWS:
${reviewsText || "No reviews available"}

USER PREFERENCES:
- Guest type: ${userPreferences.guestType || "not specified"}
- Meal plan: ${userPreferences.mealPlan || "not specified"}
- Hotel types wanted: ${(userPreferences.hotelTypes || []).join(", ") || "any"}
- Amenities wanted: ${(userPreferences.amenities || []).join(", ") || "none specified"}
- Budget: max ${userPreferences.budget} ${userPreferences.currency} per night
- Nights: ${userPreferences.nights}
- Adults: ${userPreferences.adults}, Children: ${userPreferences.children}, Infants: ${userPreferences.infants}

TASK:
1. Decide if this hotel is a GOOD MATCH, PARTIAL MATCH, or NO MATCH for the user's preferences.
2. For each preference the user selected, say if the hotel meets it or not.
3. Give a relevance score from 0-100.
4. Estimate the price per night for the requested room type and meal plan.

Respond ONLY with valid JSON in this exact format:
{
  "matchLevel": "great" | "good" | "no",
  "relevanceScore": 85,
  "estimatedPricePerNight": 220,
  "priceLabel": "Family room · All inclusive",
  "matchReasons": [
    "Has large family rooms based on reviews",
    "Pool mentioned frequently in reviews"
  ],
  "missingFeatures": [
    "No waterpark mentioned"
  ],
  "summary": "One sentence explaining why this hotel matches or doesn't match"
}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await response.json();
    const text = data.content[0].text;

    // Parse JSON from Claude's response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in response");
    const result = JSON.parse(jsonMatch[0]);

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`VacayHelper backend running on port ${PORT}`);
});
