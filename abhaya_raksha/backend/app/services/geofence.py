"""
Geofencing utilities — hyperlocal zones + city-level fallback.

Priority:
  1. If worker.zone_name is set and matches a HYPERLOCAL_ZONES key → use that
     zone centre with HYPERLOCAL_RADIUS_KM (1.5 km).
  2. Otherwise fall back to CITY_ZONES with CITY_RADIUS_KM (5 km).

All lookups are case-insensitive.
Existing callers that pass only (city, lat, lng) continue to work unchanged.
"""
import math
from typing import Optional

# ── Hyperlocal zone definitions (1.5 km radius) ───────────────────────────────
HYPERLOCAL_ZONES: dict[str, tuple[float, float]] = {
    "Andheri":       (19.1136, 72.8697),
    "Gachibowli":    (17.4401, 78.3489),
    "Whitefield":    (12.9698, 77.7499),
    "T Nagar":       (13.0418, 80.2341),
    "Delhi Central": (28.6139, 77.2090),
}

HYPERLOCAL_RADIUS_KM: float = 1.5

# ── City-level fallback zones (5 km radius) ───────────────────────────────────
# Keys must match worker.city values (case-insensitive lookup applied in helpers)
CITY_ZONES: dict[str, tuple[float, float]] = {
    "Chennai":   (13.0827, 80.2707),
    "Mumbai":    (19.0760, 72.8777),
    "Hyderabad": (17.3850, 78.4867),
    "Delhi":     (28.6139, 77.2090),
    "Bangalore": (12.9716, 77.5946),
}

CITY_RADIUS_KM: float = 5.0

# Keep ZONES as an alias for backward compatibility with any code that imports it
ZONES = CITY_ZONES
ZONE_RADIUS_KM = CITY_RADIUS_KM


def distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Return the great-circle distance in kilometres between two GPS points."""
    R = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi    = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _case_insensitive_lookup(
    name: str,
    mapping: dict[str, tuple[float, float]],
) -> Optional[tuple[float, float]]:
    """Return the coords for `name` from `mapping`, ignoring case. None if not found."""
    for key, coords in mapping.items():
        if key.lower() == name.lower():
            return coords
    return None


def get_worker_location_status(
    city: str,
    latitude: Optional[float],
    longitude: Optional[float],
    zone_name: Optional[str] = None,
) -> dict:
    """
    Return a status dict for a worker given their city, optional hyperlocal
    zone_name, and live GPS coordinates.

    Resolution order:
      1. zone_name set and found in HYPERLOCAL_ZONES → hyperlocal check (1.5 km)
      2. city found in CITY_ZONES → city-level check (5 km)
      3. Neither found → status UNKNOWN

    Possible statuses:
      NO_DATA  — latitude/longitude not yet recorded
      UNKNOWN  — neither zone_name nor city matched any known zone
      INSIDE   — within the applicable radius
      OUTSIDE  — beyond the applicable radius

    Returned dict always includes:
      status, distance, zone_center, city, zone_name, radius_km
    """
    if latitude is None or longitude is None:
        return {
            "status": "NO_DATA",
            "distance": None,
            "zone_center": None,
            "city": city,
            "zone_name": zone_name,
            "radius_km": None,
        }

    # ── Priority 1: hyperlocal zone ───────────────────────────────────────────
    if zone_name:
        hyperlocal_center = _case_insensitive_lookup(zone_name, HYPERLOCAL_ZONES)
        if hyperlocal_center:
            dist = distance_km(latitude, longitude, hyperlocal_center[0], hyperlocal_center[1])
            status = "INSIDE" if dist <= HYPERLOCAL_RADIUS_KM else "OUTSIDE"
            return {
                "status": status,
                "distance": round(dist, 3),
                "zone_center": hyperlocal_center,
                "city": city,
                "zone_name": zone_name,
                "radius_km": HYPERLOCAL_RADIUS_KM,
            }

    # ── Priority 2: city-level fallback ──────────────────────────────────────
    city_center = _case_insensitive_lookup(city, CITY_ZONES)
    if city_center:
        dist = distance_km(latitude, longitude, city_center[0], city_center[1])
        status = "INSIDE" if dist <= CITY_RADIUS_KM else "OUTSIDE"
        return {
            "status": status,
            "distance": round(dist, 3),
            "zone_center": city_center,
            "city": city,
            "zone_name": None,   # no hyperlocal zone assigned
            "radius_km": CITY_RADIUS_KM,
        }

    # ── Neither matched ───────────────────────────────────────────────────────
    return {
        "status": "UNKNOWN",
        "distance": None,
        "zone_center": None,
        "city": city,
        "zone_name": zone_name,
        "radius_km": None,
    }
