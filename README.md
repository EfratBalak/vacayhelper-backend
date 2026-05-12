# VacayHelper Backend

Hotel search backend for VacayHelper — finds and matches hotels to user preferences using Google Places API and Claude AI.

## What it does

1. **City autocomplete** — suggests cities as user types
2. **Hotel search** — finds hotels in a city via Google Places
3. **Hotel details** — gets ratings, reviews, photos
4. **AI matching** — uses Claude to analyze if a hotel matches user preferences

## Setup

### Required API Keys

- `GOOGLE_API_KEY` — from [console.cloud.google.com](https://console.cloud.google.com)
- `ANTHROPIC_API_KEY` — from [console.anthropic.com](https://console.anthropic.com)

### Run locally

```bash
npm install
cp .env.example .env
# Fill in your API keys in .env
npm start
```

### Deploy to Railway

1. Connect this GitHub repo to Railway
2. Add environment variables in Railway dashboard
3. Railway will auto-deploy on every push

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/` | GET | Health check |
| `/api/autocomplete?input=tel&country=il` | GET | City suggestions |
| `/api/hotels?city=Rome&country=Italy` | GET | Search hotels |
| `/api/hotel-details?placeId=...` | GET | Hotel details |
| `/api/photo?photoRef=...` | GET | Hotel photo |
| `/api/match` | POST | AI match analysis |
