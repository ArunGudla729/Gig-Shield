"""
Risk Prediction Engine
- Fetches real weather data from OpenWeather API
- Computes risk score using a trained ML model (GradientBoostingClassifier)
  with rule-based weighted formula as fallback
- Calculates dynamic weekly premium
"""
import os
import logging
import joblib
import numpy as np
from datetime import datetime
from ..config import settings

logger = logging.getLogger(__name__)

# ── City centre coordinates for AQI API lookup ────────────────────────────────
# Mirrors CITY_ZONES in geofence.py — kept here to avoid a circular import.
_CITY_COORDS: dict[str, tuple[float, float]] = {
    "mumbai":    (19.0760, 72.8777),
    "delhi":     (28.6139, 77.2090),
    "bangalore": (12.9716, 77.5946),
    "bengaluru": (12.9716, 77.5946),
    "chennai":   (13.0827, 80.2707),
    "hyderabad": (17.3850, 78.4867),
}

# ── Model path ────────────────────────────────────────────────────────────────
_MODEL_PATH = os.path.join(os.path.dirname(__file__), "../../../ml/risk_model.joblib")
_risk_model = None

def _get_risk_model():
    """Lazy-load the risk model once. Returns None if file is missing."""
    global _risk_model
    if _risk_model is None:
        path = os.path.abspath(_MODEL_PATH)
        if os.path.exists(path):
            _risk_model = joblib.load(path)
            logger.info("risk_model.joblib loaded from %s", path)
        else:
            logger.warning("risk_model.joblib not found at %s — using rule-based fallback", path)
    return _risk_model

# ── Thresholds ────────────────────────────────────────────────────────────────
RAIN_THRESHOLD_MM = 15.0
AQI_THRESHOLD = 200
TEMP_HEAT_THRESHOLD = 42.0

# ── Micro-Insurance Premium config ───────────────────────────────────────────
# Formula: Premium = trigger_prob × daily_income × exposure_days
# At trigger_prob=0.008, daily_income=850, exposure_days=5 → ₹34/week
# Scales naturally with the worker's actual avg_daily_income.
TRIGGER_PROBABILITY = 0.025   # parametric rain/disruption trigger probability
EXPOSURE_DAYS       = 6       # working days exposed per week (gig workers typically work 6 days)
COVERAGE_MULTIPLIER = 0.25     # coverage = 25% of weekly income

# ── Worker-type premium multipliers ──────────────────────────────────────────
# Food delivery workers operate outdoors on bikes — highest exposure to rain,
# heat, and AQI. Grocery (Q-commerce) workers have moderate outdoor exposure.
# E-commerce workers often work from warehouses or use vehicles — lowest exposure.
# Default multiplier = 1.0 for any unknown or missing worker type.
WORKER_TYPE_MULTIPLIER: dict[str, float] = {
    "food_delivery": 1.2,   # highest outdoor exposure (Zomato/Swiggy)
    "grocery":       1.1,   # moderate outdoor exposure (Zepto/Blinkit)
    "ecommerce":     0.9,   # lower outdoor exposure (Amazon/Flipkart)
}

# ── Women-specific benefit constants ─────────────────────────────────────────
# Applied additively on top of existing logic — no other workers are affected.
WOMEN_PREMIUM_DISCOUNT  = 0.92   # 8% lower premium for FEMALE workers
WOMEN_COVERAGE_BOOST    = 1.12   # 12% higher coverage for FEMALE workers

async def fetch_weather(city: str) -> dict:
    """
    Fetch current weather from OpenWeather using the city name.
    Falls back to deterministic mock on any error or missing key.
    Temperature is rounded to 1 decimal place.
    AQI uses a safe city-based static value (avoids a second API call).
    """
    if not settings.OPENWEATHER_API_KEY:
        return _mock_weather(city)
    try:
        import httpx
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(
                "https://api.openweathermap.org/data/2.5/weather",
                params={
                    "q": city + ",IN",
                    "appid": settings.OPENWEATHER_API_KEY,
                    "units": "metric",   # temp already in °C — no Kelvin conversion needed
                },
            )
            if r.status_code in (401, 403):
                logger.warning("OpenWeather API key issue (%d) — using mock", r.status_code)
                return _mock_weather(city)
            r.raise_for_status()
            data = r.json()
            # rain.1h preferred; fall back to rain.3h; 0.0 if no rain key (clear/cloudy)
            rain_mm = data.get("rain", {}).get("1h", data.get("rain", {}).get("3h", 0.0))
            temp_c  = round(data["main"]["temp"], 1)
            # AQI: try live Air Pollution API first; fall back to static if it fails.
            # Both use the same API key — no extra subscription needed.
            coords = _CITY_COORDS.get(city.lower())
            if coords:
                live_aqi = await _fetch_aqi(coords[0], coords[1], settings.OPENWEATHER_API_KEY)
            else:
                live_aqi = None
            aqi = live_aqi if live_aqi is not None else _static_aqi(city)
            return {"rain_mm": rain_mm, "temp_c": temp_c, "aqi": aqi}
    except Exception as exc:
        logger.warning("fetch_weather(%s) failed: %s — using mock", city, exc)
        return _mock_weather(city)


async def fetch_weather_by_coords(lat: float, lon: float) -> dict:
    """
    Fetch current weather by lat/lon — used by the Smart-Shift planner and
    any future location-aware features. Same fallback behaviour as fetch_weather.
    """
    if not settings.OPENWEATHER_API_KEY:
        return {"rain_mm": 4.0, "temp_c": 30.0, "aqi": 100.0}
    try:
        import httpx
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(
                "https://api.openweathermap.org/data/2.5/weather",
                params={
                    "lat": lat,
                    "lon": lon,
                    "appid": settings.OPENWEATHER_API_KEY,
                    "units": "metric",
                },
            )
            if r.status_code in (401, 403):
                return {"rain_mm": 4.0, "temp_c": 30.0, "aqi": 100.0}
            r.raise_for_status()
            data = r.json()
            rain_mm = data.get("rain", {}).get("1h", data.get("rain", {}).get("3h", 0.0))
            temp_c  = round(data["main"]["temp"], 1)
            return {"rain_mm": rain_mm, "temp_c": temp_c, "aqi": 100.0}
    except Exception as exc:
        logger.warning("fetch_weather_by_coords(%.4f,%.4f) failed: %s", lat, lon, exc)
        return {"rain_mm": 4.0, "temp_c": 30.0, "aqi": 100.0}


def _pm25_to_naqi(pm25: float) -> float:
    """
    Convert PM2.5 concentration (µg/m³) to Indian NAQI (0–500 scale).
    Breakpoints follow the Central Pollution Control Board (CPCB) standard.
    This keeps the existing AQI threshold of 200 valid without any downstream changes.
    """
    if pm25 <= 30:
        return pm25 * (50 / 30)
    elif pm25 <= 60:
        return 50 + (pm25 - 30) * (50 / 30)
    elif pm25 <= 90:
        return 100 + (pm25 - 60) * (50 / 30)
    elif pm25 <= 120:
        return 150 + (pm25 - 90) * (50 / 30)
    elif pm25 <= 250:
        return 200 + (pm25 - 120) * (100 / 130)
    else:
        return 300 + (pm25 - 250) * (100 / 130)


async def _fetch_aqi(lat: float, lon: float, api_key: str) -> float | None:
    """
    Fetch live AQI from the OpenWeather Air Pollution API (free tier, same key).
    Returns NAQI-scale float on success, None on any failure.
    Caller falls back to _static_aqi() when None is returned.
    Timeout is intentionally short (5s) so a slow API never blocks the scheduler.
    """
    try:
        import httpx
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.get(
                "https://api.openweathermap.org/data/2.5/air_pollution",
                params={"lat": lat, "lon": lon, "appid": api_key},
            )
            response.raise_for_status()
            data = response.json()
            pm25 = data["list"][0]["components"]["pm2_5"]
            return round(_pm25_to_naqi(pm25), 1)
    except Exception as exc:
        logger.debug("_fetch_aqi(%.4f,%.4f) failed: %s — using static fallback", lat, lon, exc)
        return None


def _static_aqi(city: str) -> float:
    """
    Climatologically realistic static AQI per city.
    Avoids a second API call while keeping values meaningful for risk scoring.
    """
    mapping = {
        "mumbai":    120.0,
        "delhi":     150.0,
        "bangalore": 90.0,
        "bengaluru": 90.0,
        "chennai":   110.0,
        "hyderabad": 130.0,
    }
    return mapping.get(city.lower(), 100.0)

def _mock_weather(city: str) -> dict:
    """Deterministic mock based on city name for demo."""
    city_lower = city.lower()
    if "mumbai" in city_lower:
        return {"rain_mm": 18.0, "temp_c": 29.0, "aqi": 120.0}
    elif "delhi" in city_lower:
        return {"rain_mm": 2.0, "temp_c": 38.0, "aqi": 150.0}
    elif "bangalore" in city_lower or "bengaluru" in city_lower:
        return {"rain_mm": 8.0, "temp_c": 26.0, "aqi": 90.0}
    elif "chennai" in city_lower:
        return {"rain_mm": 5.0, "temp_c": 35.0, "aqi": 110.0}
    elif "hyderabad" in city_lower:
        return {"rain_mm": 3.0, "temp_c": 33.0, "aqi": 130.0}
    return {"rain_mm": 4.0, "temp_c": 30.0, "aqi": 100.0}

def compute_risk_score(rain_mm: float, aqi: float, temp_c: float, curfew: bool = False) -> float:
    """
    Compute risk score (0.0–1.0) using the trained GradientBoostingClassifier.
    Falls back to a weighted rule-based formula if the model is unavailable.

    ML features: [rain_mm, aqi, temp_c, hour, day_of_week, is_monsoon]
    Curfew penalty: +0.3 added on top of ML score (capped at 1.0).
    """
    now = datetime.utcnow()
    hour = now.hour
    day_of_week = now.weekday()          # 0 = Monday … 6 = Sunday
    is_monsoon = 1 if now.month in (6, 7, 8, 9) else 0

    model = _get_risk_model()
    if model is not None:
        import pandas as pd
        features = pd.DataFrame([[rain_mm, aqi, temp_c, hour, day_of_week, is_monsoon]],
                                columns=["rain_mm", "aqi", "temp_c", "hour", "day_of_week", "is_monsoon"])
        ml_prob = float(model.predict_proba(features)[0][1])  # P(disruption)
        score = ml_prob + (0.3 if curfew else 0.0)
        return round(min(score, 1.0), 4)

    # ── Rule-based fallback ───────────────────────────────────────────────────
    rain_risk = min(rain_mm / 50.0, 1.0)
    aqi_risk = min(max(aqi - 100, 0) / 300.0, 1.0)
    heat_risk = min(max(temp_c - 35, 0) / 15.0, 1.0)
    curfew_risk = 1.0 if curfew else 0.0
    score = (
        0.40 * rain_risk +
        0.30 * aqi_risk +
        0.20 * heat_risk +
        0.10 * curfew_risk
    )
    return round(min(score, 1.0), 4)

def calculate_premium(
    risk_score: float,
    avg_daily_income: float,
    worker_type: str | None = None,
    gender: str | None = None,
) -> dict:
    """
    Micro-insurance weekly premium using the parametric formula:
        Premium = trigger_prob × daily_income × exposure_days × worker_type_multiplier

    Women workers (gender=FEMALE) receive:
      - 8% lower premium  (WOMEN_PREMIUM_DISCOUNT = 0.92)
      - 12% higher coverage (WOMEN_COVERAGE_BOOST = 1.12)
    These are additive benefits — no other workers are affected.
    """
    effective_trigger_prob = TRIGGER_PROBABILITY * (1.0 + risk_score)
    base_premium = effective_trigger_prob * avg_daily_income * EXPOSURE_DAYS

    multiplier = WORKER_TYPE_MULTIPLIER.get(str(worker_type).lower() if worker_type else "", 1.0)
    weekly_premium = round(base_premium * multiplier, 2)

    weekly_income   = avg_daily_income * EXPOSURE_DAYS
    coverage_amount = round(weekly_income * COVERAGE_MULTIPLIER, 2)

    # Apply women-specific benefits
    is_female = str(gender).upper() == "FEMALE" if gender else False
    if is_female:
        weekly_premium  = round(weekly_premium * WOMEN_PREMIUM_DISCOUNT, 2)
        coverage_amount = round(coverage_amount * WOMEN_COVERAGE_BOOST, 2)

    return {
        "weekly_premium":         weekly_premium,
        "coverage_amount":        coverage_amount,
        "premium_rate":           round(effective_trigger_prob, 6),
        "worker_type_multiplier": multiplier,
        "women_benefits_active":  is_female,
    }

async def get_risk_for_location(
    city: str,
    zone: str,
    avg_daily_income: float,
    curfew: bool = False,
    worker_type: str | None = None,
    gender: str | None = None,
) -> dict:
    weather = await fetch_weather(city)
    risk_score = compute_risk_score(
        rain_mm=weather["rain_mm"],
        aqi=weather["aqi"],
        temp_c=weather["temp_c"],
        curfew=curfew,
    )
    pricing = calculate_premium(risk_score, avg_daily_income, worker_type=worker_type, gender=gender)
    return {
        "city": city,
        "zone": zone,
        "risk_score": risk_score,
        **weather,
        "curfew": curfew,
        **pricing,
    }
