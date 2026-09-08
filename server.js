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
app.get("/api/autocomplete", async (req, res) => {
  const { input, country } = req.query;
  if (!input) return res.status(400).json({ error: "input required" });
  const components = country ? `&components=country:${country}` : "";
  const lang = req.query.language || "en";
  const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&types=(regions)${components}&key=${GOOGLE_API_KEY}&language=${lang}`;
  try {
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 2. PHOTO PROXY ──
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

// ── 3. SEASONAL PRICE ESTIMATE ──
// Based on price_level from Google + month + city popularity
function estimatePrice(priceLevel, month, city) {
  // Base price ranges per price_level
  const base = { 1: 75, 2: 150, 3: 280, 4: 500 };
  let price = base[priceLevel] || 150;

  // Seasonal multiplier
  const highSeason = [6, 7, 8, 9]; // Jun-Sep
  const midSeason = [3, 4, 5, 10, 12]; // Mar-May, Oct, Dec
  if (highSeason.includes(month)) price *= 1.3;
  else if (midSeason.includes(month)) price *= 1.1;

  // Popular city premium
  const premiumCities = ["paris", "rome", "london", "barcelona", "amsterdam", "tokyo", "new york", "venice"];
  if (premiumCities.some(c => city.toLowerCase().includes(c))) price *= 1.2;

  return Math.round(price);
}

// ── 4. MAIN SEARCH WITH FILTERING ──
app.post("/api/search", async (req, res) => {
  const { destination, filters, month } = req.body;

  if (!destination) return res.status(400).json({ error: "destination required" });

  try {
    // STEP 1: Get hotels from Google Places
    const query = `hotels in ${destination}`;
    const searchUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&type=lodging&key=${GOOGLE_API_KEY}&language=en`;
    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();

    if (!searchData.results || !searchData.results.length) {
      return res.json({ results: [], message: "No hotels found" });
    }

    // STEP 2: Hard filters — rating, reviews, budget
    const travelMonth = month || new Date().getMonth() + 1;
    const maxBudget = filters.budget || 9999;
    const minRating = filters.minRating || 0;
    const minReviews = 80;

    let candidates = searchData.results.filter(h => {
      if ((h.user_ratings_total || 0) < minReviews) return false;
      if ((h.rating || 0) < minRating) return false;
      const priceLevel = h.price_level || 2;
      const estimated = estimatePrice(priceLevel, travelMonth, destination);
      h._estimatedPrice = estimated;
      if (estimated > maxBudget * 1.1) return false; // 10% tolerance
      return true;
    });

    // Sort by rating, take top 15 candidates for AI analysis
    candidates = candidates
      .sort((a, b) => (b.rating || 0) - (a.rating || 0))
      .slice(0, 15);

    if (!candidates.length) {
      return res.json({ results: [], message: "No hotels match your basic criteria" });
    }

    // STEP 3: Get full details for each candidate
    const detailedHotels = await Promise.all(
      candidates.map(async (h) => {
        try {
          const fields = "name,rating,user_ratings_total,formatted_address,photos,website,price_level,reviews,types,editorial_summary";
          const detailUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${h.place_id}&fields=${fields}&key=${GOOGLE_API_KEY}&language=en`;
          const detailRes = await fetch(detailUrl);
          const detailData = await detailRes.json();
          return {
            ...h,
            ...detailData.result,
            _estimatedPrice: h._estimatedPrice
          };
        } catch {
          return h;
        }
      })
    );

    // STEP 4: If user has style filters — AI matching
    const styleFilters = [
      ...(filters.hotelTypes || []),
      ...(filters.amenities || []),
      ...(filters.mealPlan ? [filters.mealPlan] : []),
      ...(filters.guestType ? [filters.guestType] : [])
    ].filter(Boolean);

    let matchedHotels = [];

    if (styleFilters.length === 0) {
      // No style filters — return all that passed hard filters
      matchedHotels = detailedHotels.slice(0, 10).map(h => ({
        ...h,
        matchScore: 100,
        matchReasons: ["Matches your search criteria"],
        missingFeatures: []
      }));
    } else {
      // AI matching for each hotel in parallel
      const matchResults = await Promise.all(
        detailedHotels.map(h => analyzeHotelMatch(h, filters, styleFilters))
      );

      // Only include hotels that passed ALL filters
      matchedHotels = matchResults
        .filter(r => r !== null)
        .sort((a, b) => b.matchScore - a.matchScore)
        .slice(0, 10);
    }

    res.json({ results: matchedHotels, total: matchedHotels.length });

  } catch (err) {
    console.error("Search error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── AI MATCH ANALYSIS ──
async function analyzeHotelMatch(hotel, filters, styleFilters) {
  try {
    // Build context: reviews + website content
    const reviewsText = (hotel.reviews || [])
      .slice(0, 8)
      .map(r => r.text)
      .join("\n---\n");

    // Fetch hotel website if available
    let websiteContent = "";
    if (hotel.website) {
      try {
        const siteRes = await fetch(hotel.website, {
          signal: AbortSignal.timeout(5000),
          headers: { "User-Agent": "Mozilla/5.0" }
        });
        const html = await siteRes.text();
        // Extract text from HTML (basic)
        websiteContent = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .slice(0, 3000);
      } catch {
        websiteContent = "Website not accessible";
      }
    }

    const prompt = `You are a strict hotel matching expert for a travel recommendation system.

HOTEL: ${hotel.name}
ADDRESS: ${hotel.formatted_address || ""}
GOOGLE RATING: ${hotel.rating} (${hotel.user_ratings_total} reviews)
PRICE LEVEL: ${"$".repeat(hotel.price_level || 2)}
HOTEL TYPES FROM GOOGLE: ${(hotel.types || []).join(", ")}
EDITORIAL SUMMARY: ${hotel.editorial_summary?.overview || "none"}

GOOGLE REVIEWS (recent):
${reviewsText || "No reviews available"}

HOTEL WEBSITE CONTENT:
${websiteContent || "Not available"}

USER FILTERS TO CHECK:
${styleFilters.map((f, i) => `${i + 1}. ${f}`).join("\n")}

TASK:
For EACH filter listed above, determine if there is CLEAR EVIDENCE in the reviews or website content.

STRICT RULES:
- If a filter has NO clear evidence → the hotel FAILS
- Only pass a hotel if ALL filters have clear evidence
- "Boutique hotel" evidence: words like boutique, intimate, unique, small, charming, character, individually designed
- "Pool" evidence: pool, swimming, swim mentioned explicitly
- "All inclusive" evidence: all-inclusive, all inclusive, meals included mentioned explicitly
- "Kids club" evidence: kids club, children's club, childcare mentioned explicitly
- "Spa hotel" evidence: spa, wellness, massage, treatment mentioned explicitly
- "Pet friendly" evidence: pets, dogs, animals welcome mentioned explicitly
- "Adults only" evidence: adults only, no children, 18+ mentioned explicitly
- "Family hotel" evidence: family, families, kids, children welcome mentioned explicitly
- "Boutique hotel", "Large hotel", "City centre hotel", "Rural / countryside", "Near main road" — check location and type clues

Respond ONLY with valid JSON:
{
  "passed": true or false,
  "matchScore": 0-100,
  "filterResults": {
    "Filter name": { "passed": true/false, "evidence": "quote or description" }
  },
  "matchReasons": ["reason1", "reason2"],
  "missingFeatures": ["missing1"]
}`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 800,
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await response.json();
    if (!data.content || !data.content[0]) return null;

    const jsonMatch = data.content[0].text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const result = JSON.parse(jsonMatch[0]);

    if (!result.passed) return null;

    return {
      ...hotel,
      matchScore: result.matchScore || 80,
      matchReasons: result.matchReasons || [],
      missingFeatures: result.missingFeatures || [],
      filterResults: result.filterResults || {}
    };

  } catch (err) {
    console.error("Match error for", hotel.name, err.message);
    return null;
  }
}

app.listen(PORT, () => {
  console.log(`VacayHelper backend running on port ${PORT}`);
});
