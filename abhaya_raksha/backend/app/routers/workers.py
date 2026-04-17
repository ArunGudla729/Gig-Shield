import logging
from datetime import datetime, timezone
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from ..database import get_db
from ..models import Worker, RiskLog
from ..schemas import WorkerOut, RiskResponse, LocationUpdate, WorkerLocationOut
from ..auth import get_current_worker, get_current_admin
from ..services.risk_engine import get_risk_for_location
from ..services.gemini_ai import generate_risk_summary
from ..services.fraud_detector import update_worker_position
from ..services.weather import get_shift_advice
from ..services.geofence import get_worker_location_status
from ..config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/workers", tags=["workers"])


@router.get("/me", response_model=WorkerOut)
def get_me(current_worker: Worker = Depends(get_current_worker)):
    return current_worker


@router.get("/risk", response_model=RiskResponse)
async def get_my_risk(
    curfew: bool = False,
    db: Session = Depends(get_db),
    current_worker: Worker = Depends(get_current_worker),
):
    """
    Return the live risk score and dynamic weekly premium for the logged-in worker.
    Also persists a RiskLog entry so the Admin heatmap has real data points.
    """
    risk_data = await get_risk_for_location(
        city=current_worker.city,
        zone=current_worker.zone,
        avg_daily_income=current_worker.avg_daily_income,
        curfew=curfew,
        worker_type=current_worker.worker_type,
        gender=getattr(current_worker, "gender", None),
    )

    # ── Persist to RiskLog for Admin heatmap ──────────────────────────────────
    try:
        log = RiskLog(
            city=risk_data["city"],
            zone=risk_data["zone"],
            risk_score=risk_data["risk_score"],
            rain_mm=risk_data["rain_mm"],
            aqi=risk_data["aqi"],
            temp_c=risk_data["temp_c"],
            curfew=risk_data["curfew"],
        )
        db.add(log)
        db.commit()
    except Exception as exc:
        logger.warning("Failed to write RiskLog for %s: %s", current_worker.city, exc)
        db.rollback()

    # ── Update last known position for teleportation fraud detection ──────────
    update_worker_position(current_worker, current_worker.lat, current_worker.lng, db)

    return risk_data


@router.get("/shift-advice")
async def get_shift_advice_endpoint(
    current_worker: Worker = Depends(get_current_worker),
):
    """
    Return a Smart-Shift Planner recommendation for tomorrow based on the
    OpenWeather 5-day forecast for the worker's registered coordinates.
    """
    try:
        advice = await get_shift_advice(
            lat=current_worker.lat,
            lon=current_worker.lng,
            api_key=settings.OPENWEATHER_API_KEY,
        )
    except ValueError as exc:
        if str(exc) == "API_KEY_ACTIVATING":
            advice = (
                "Smart-Shift is syncing with local weather stations... "
                "Check back shortly."
            )
        else:
            advice = "Shift advice temporarily unavailable."
    except Exception as exc:
        logger.warning("Shift advice error for worker #%d: %s", current_worker.id, exc)
        advice = "Shift advice temporarily unavailable."

    return {"shift_advice": advice}


@router.get("/risk/summary")
async def get_risk_summary(
    curfew: bool = False,
    current_worker: Worker = Depends(get_current_worker),
):
    """Return an AI-generated plain-language risk summary for the worker."""
    risk_data = await get_risk_for_location(
        city=current_worker.city,
        zone=current_worker.zone,
        avg_daily_income=current_worker.avg_daily_income,
        curfew=curfew,
        worker_type=current_worker.worker_type,
        gender=getattr(current_worker, "gender", None),
    )
    summary = await generate_risk_summary(risk_data)
    return {"summary": summary, "risk_data": risk_data}


@router.post("/location")
def update_location(
    payload: LocationUpdate,
    db: Session = Depends(get_db),
    current_worker: Worker = Depends(get_current_worker),
):
    """Store the worker's latest GPS coordinates (called silently from the worker dashboard)."""
    current_worker.last_lat = payload.lat
    current_worker.last_lng = payload.lng
    current_worker.last_location_update = datetime.now(timezone.utc)
    db.commit()
    geo = get_worker_location_status(
        current_worker.city, payload.lat, payload.lng,
        zone_name=getattr(current_worker, "zone_name", None),
    )
    return {"status": "ok", "location_status": geo["status"], "distance_km": geo["distance"]}


@router.get("/location-status", response_model=list[WorkerLocationOut])
def get_all_worker_locations(
    db: Session = Depends(get_db),
    _admin: Worker = Depends(get_current_admin),
):
    """Admin-only: return all non-admin workers with live GPS and city-based zone status."""
    workers = db.query(Worker).filter(Worker.is_admin == False).all()
    result = []
    for w in workers:
        geo = get_worker_location_status(
            w.city, w.last_lat, w.last_lng,
            zone_name=getattr(w, "zone_name", None),
        )
        result.append(WorkerLocationOut(
            id=w.id,
            name=w.name,
            city=w.city,
            latitude=w.last_lat,
            longitude=w.last_lng,
            last_location_update=w.last_location_update,
            status=geo["status"],
            distance=geo["distance"],
            zone_center=list(geo["zone_center"]) if geo["zone_center"] else None,
            fraud_flag="OUT_OF_ZONE" if geo["status"] == "OUTSIDE" else None,
            zone_name=geo["zone_name"],
            radius_km=geo["radius_km"],
        ))
    return result
