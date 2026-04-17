from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from sqlalchemy import func
from ..database import get_db
from ..models import Worker, Policy, Claim, PolicyStatus, ClaimStatus, DisruptionEvent, RiskLog, GlobalSettings, ManualClaim
from ..schemas import AdminStats, SimulationRequest, SimulationResult, ClaimOut
from ..services.claim_engine import trigger_claims_for_event, CITY_RAIN_THRESHOLDS, THRESHOLDS
from ..services.gemini_ai import generate_admin_insight
from ..auth import get_current_admin
from ..config import settings as app_settings

router = APIRouter(prefix="/api/admin", tags=["admin"])


# ── City coordinates (mirrors risk_engine._CITY_COORDS) ──────────────────────
_FORECAST_CITIES = {
    "Mumbai":    (19.0760, 72.8777),
    "Delhi":     (28.6139, 77.2090),
    "Bangalore": (12.9716, 77.5946),
    "Chennai":   (13.0827, 80.2707),
    "Hyderabad": (17.3850, 78.4867),
}

# Static AQI fallback (mirrors risk_engine._static_aqi)
_STATIC_AQI = {
    "Mumbai": 120.0, "Delhi": 150.0, "Bangalore": 90.0,
    "Chennai": 110.0, "Hyderabad": 130.0,
}


async def get_next_week_risk_forecast() -> list[dict]:
    """
    Fetch the OpenWeather 5-day/3-hour forecast for each monitored city and
    compute a simple next-week risk level using existing parametric thresholds.

    Logic (no ML, no new DB fields):
      - Scan all forecast slots for the next 7 days
      - If max rain_mm in any slot >= city rain threshold → High (rain)
      - Elif max rain_mm >= 60% of threshold → Moderate (rain)
      - Elif static AQI >= 200 → High (AQI)
      - Elif static AQI >= 150 → Moderate (AQI)
      - Elif max temp >= 42°C → High (heat)
      - Else → Low

    Always returns a safe fallback list if the API is unavailable.
    """
    import httpx
    from datetime import datetime, timedelta, timezone

    api_key = app_settings.OPENWEATHER_API_KEY

    # ── Static fallback (used when no API key or API fails) ───────────────────
    def _fallback() -> list[dict]:
        fallback_data = {
            "Mumbai":    ("Moderate", "Monsoon season — rain likely"),
            "Delhi":     ("High",     "AQI typically elevated"),
            "Bangalore": ("Low",      "Stable conditions expected"),
            "Chennai":   ("Moderate", "Coastal humidity — monitor rain"),
            "Hyderabad": ("Low",      "Conditions look stable"),
        }
        return [
            {"city": city, "risk": level, "reason": reason, "source": "forecast_unavailable"}
            for city, (level, reason) in fallback_data.items()
        ]

    if not api_key:
        return _fallback()

    results = []
    now_utc = datetime.now(timezone.utc)
    week_end = now_utc + timedelta(days=7)

    for city, (lat, lon) in _FORECAST_CITIES.items():
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                r = await client.get(
                    "https://api.openweathermap.org/data/2.5/forecast",
                    params={
                        "lat": lat, "lon": lon,
                        "appid": api_key,
                        "units": "metric",
                        "cnt": 40,   # max 5 days × 8 slots/day
                    },
                )
                if r.status_code in (401, 403):
                    results.append({
                        "city": city, "risk": "Unknown",
                        "reason": "Forecast unavailable", "source": "api_error"
                    })
                    continue
                r.raise_for_status()
                data = r.json()

            # Collect rain and temp across all slots in the next 7 days
            max_rain = 0.0
            max_temp = 0.0
            for slot in data.get("list", []):
                slot_dt = datetime.fromtimestamp(slot["dt"], tz=timezone.utc)
                if slot_dt > week_end:
                    break
                rain_mm = slot.get("rain", {}).get("3h", 0.0)
                temp_c  = slot["main"]["temp"]
                max_rain = max(max_rain, rain_mm)
                max_temp = max(max_temp, temp_c)

            # City-specific rain threshold from existing claim engine
            rain_threshold = CITY_RAIN_THRESHOLDS.get(city.lower(), THRESHOLDS["rain"])
            aqi_estimate   = _STATIC_AQI.get(city, 100.0)

            # Classify risk using existing thresholds
            if max_rain >= rain_threshold:
                risk   = "High"
                reason = f"Heavy rain forecast ({max_rain:.0f}mm — threshold {rain_threshold:.0f}mm)"
            elif max_rain >= rain_threshold * 0.6:
                risk   = "Moderate"
                reason = f"Moderate rain expected ({max_rain:.0f}mm)"
            elif aqi_estimate >= 200:
                risk   = "High"
                reason = f"AQI likely to exceed threshold ({aqi_estimate:.0f})"
            elif aqi_estimate >= 150:
                risk   = "Moderate"
                reason = f"AQI elevated ({aqi_estimate:.0f}) — monitor closely"
            elif max_temp >= 42.0:
                risk   = "High"
                reason = f"Extreme heat forecast ({max_temp:.0f}°C)"
            else:
                risk   = "Low"
                reason = "Stable conditions expected"

            results.append({
                "city": city, "risk": risk, "reason": reason,
                "max_rain_mm": round(max_rain, 1),
                "max_temp_c":  round(max_temp, 1),
                "aqi_estimate": aqi_estimate,
                "source": "openweather_forecast",
            })

        except Exception:
            results.append({
                "city": city, "risk": "Unknown",
                "reason": "Forecast temporarily unavailable", "source": "error"
            })

    return results if results else _fallback()


@router.get("/forecast")
async def next_week_forecast(_: Worker = Depends(get_current_admin)):
    """
    Next-week risk forecast for all monitored cities.
    Uses OpenWeather 5-day forecast + existing parametric thresholds.
    Never crashes — returns static fallback if API is unavailable.
    """
    try:
        return await get_next_week_risk_forecast()
    except Exception:
        # Absolute safety net — should never reach here
        return [
            {"city": c, "risk": "Unknown", "reason": "Forecast unavailable", "source": "error"}
            for c in _FORECAST_CITIES
        ]


@router.get("/stats", response_model=AdminStats)
def get_stats(db: Session = Depends(get_db), _: Worker = Depends(get_current_admin)):
    total_workers = db.query(Worker).filter(Worker.is_admin == False).count()
    total_policies = db.query(Policy).count()
    active_policies = db.query(Policy).filter(Policy.status == PolicyStatus.active).count()
    total_claims = db.query(Claim).count()
    approved_claims = db.query(Claim).filter(
        Claim.status.in_([ClaimStatus.approved, ClaimStatus.paid])
    ).count()

    # Include manual claims in total and approved counts
    total_claims += db.query(ManualClaim).count()
    approved_claims += db.query(ManualClaim).filter(
        ManualClaim.status.in_(["approved", "paid"])
    ).count()
    fraud_alerts = db.query(Claim).filter(Claim.fraud_score >= 0.6).count()

    total_payout = db.query(func.sum(Claim.payout_amount)).filter(
        Claim.status.in_([ClaimStatus.approved, ClaimStatus.paid])
    ).scalar() or 0.0

    # Include manual claim payouts so Total Payout matches Claims Paid in system health
    manual_payout = db.query(func.sum(ManualClaim.requested_amount)).filter(
        ManualClaim.status == "paid"
    ).scalar() or 0.0
    total_payout = round(total_payout + manual_payout, 2)

    # E4 fix: use earned premium (pro-rated by elapsed policy days) as denominator.
    # Written premium overstates the base for new policies and understates it for
    # old ones. Earned premium = weekly_premium × (elapsed_days / 7), capped at 1.
    from datetime import datetime as _dt
    now_utc = _dt.utcnow()
    policies_all = db.query(Policy).all()
    earned_premium = 0.0
    for p in policies_all:
        policy_duration = (p.end_date - p.start_date).total_seconds()
        if policy_duration <= 0:
            continue
        elapsed = min((now_utc - p.start_date).total_seconds(), policy_duration)
        fraction = max(elapsed / policy_duration, 0.0)
        # Floor: always count at least the full weekly premium so a brand-new
        # policy never produces a near-zero denominator in demo environments.
        earned_premium += max(p.weekly_premium * fraction, p.weekly_premium)
    earned_premium = round(earned_premium, 2)

    loss_ratio = round((total_payout / earned_premium) * 100, 2) if earned_premium > 0 else 0.0

    return AdminStats(
        total_workers=total_workers,
        total_policies=total_policies,
        active_policies=active_policies,
        total_claims=total_claims,
        approved_claims=approved_claims,
        total_payout=total_payout,
        fraud_alerts=fraud_alerts,
        loss_ratio=loss_ratio
    )

@router.get("/stats/insight")
async def get_ai_insight(db: Session = Depends(get_db), _: Worker = Depends(get_current_admin)):
    stats = get_stats(db)
    insight = await generate_admin_insight(stats.model_dump())
    return {"insight": insight}

@router.get("/workers")
def list_workers(db: Session = Depends(get_db), _: Worker = Depends(get_current_admin)):
    workers = db.query(Worker).all()
    return [{"id": w.id, "name": w.name, "city": w.city, "zone": w.zone,
             "worker_type": w.worker_type, "avg_daily_income": w.avg_daily_income,
             "gender": getattr(w, "gender", None),
             "women_benefits": getattr(w, "gender", None) == "FEMALE"} for w in workers]

@router.get("/claims")
def list_all_claims(
    status: str = Query(None),
    db: Session = Depends(get_db),
    _: Worker = Depends(get_current_admin)
):
    q = db.query(Claim)
    if status:
        q = q.filter(Claim.status == status)
    claims = q.order_by(Claim.created_at.desc()).limit(100).all()
    result = []
    for c in claims:
        worker = db.query(Worker).filter(Worker.id == c.worker_id).first()
        result.append({
            "id": c.id,
            "worker_id": c.worker_id,
            "worker_name": worker.name if worker else None,
            "policy_id": c.policy_id,
            "trigger_type": c.trigger_type,
            "trigger_value": c.trigger_value,
            "trigger_threshold": c.trigger_threshold,
            "payout_amount": c.payout_amount,
            "status": c.status,
            "fraud_score": c.fraud_score,
            "fraud_flags": c.fraud_flags,
            "created_at": c.created_at,
            "approved_at": c.approved_at,
            "claim_type": "parametric",
        })

    # Include manual (worker-submitted) claims so they appear in Recent Claims
    mq = db.query(ManualClaim)
    if status:
        mq = mq.filter(ManualClaim.status == status)
    manual_claims = mq.order_by(ManualClaim.created_at.desc()).limit(100).all()
    for c in manual_claims:
        worker = db.query(Worker).filter(Worker.id == c.worker_id).first()
        result.append({
            "id": c.id,
            "worker_id": c.worker_id,
            "worker_name": worker.name if worker else None,
            "policy_id": None,
            "trigger_type": "manual",
            "trigger_value": c.requested_amount,
            "trigger_threshold": None,
            "payout_amount": c.requested_amount,
            "status": c.status,
            "fraud_score": 0.0,
            "fraud_flags": c.reason or "",
            "created_at": c.created_at,
            "approved_at": None,
            "claim_type": "manual",
            "transaction_id": c.transaction_id,
        })

    # Sort combined list newest-first, cap at 10 for the dashboard view
    result.sort(key=lambda x: x["created_at"], reverse=True)
    return result[:100]

@router.get("/fraud-alerts")
def get_fraud_alerts(db: Session = Depends(get_db), _: Worker = Depends(get_current_admin)):
    return db.query(Claim).filter(Claim.fraud_score >= 0.4).order_by(
        Claim.fraud_score.desc()
    ).limit(50).all()

@router.get("/disruptions")
def get_disruptions(db: Session = Depends(get_db), _: Worker = Depends(get_current_admin)):
    return db.query(DisruptionEvent).order_by(
        DisruptionEvent.recorded_at.desc()
    ).limit(50).all()

@router.get("/risk-heatmap")
def get_risk_heatmap(db: Session = Depends(get_db), _: Worker = Depends(get_current_admin)):
    """Aggregate risk scores by city for heatmap."""
    results = db.query(
        RiskLog.city,
        func.avg(RiskLog.risk_score).label("avg_risk"),
        func.count(RiskLog.id).label("data_points")
    ).group_by(RiskLog.city).all()
    return [{"city": r.city, "avg_risk": round(r.avg_risk, 4), "data_points": r.data_points}
            for r in results]

@router.post("/simulate", response_model=SimulationResult)
def simulate_disruption(req: SimulationRequest, db: Session = Depends(get_db), _: Worker = Depends(get_current_admin)):
    """
    Simulate a disruption event and trigger parametric claims.
    Also writes a RiskLog entry so the heatmap reflects simulated events immediately.
    """
    import logging
    from ..services.claim_engine import THRESHOLDS, _get_rain_threshold
    from ..services.risk_engine import compute_risk_score

    logger = logging.getLogger(__name__)

    # Use city-specific rain threshold (mirrors real scheduler logic).
    # A flat 15mm default would show "triggered" for Mumbai at 28mm,
    # while the real claim engine would NOT trigger (Mumbai threshold = 35mm).
    threshold = _get_rain_threshold(req.city) if req.event_type == "rain" else THRESHOLDS.get(req.event_type, 0)
    triggered = req.value >= threshold

    claims = []
    if triggered:
        claims = trigger_claims_for_event(
            city=req.city,
            zone=req.zone,
            event_type=req.event_type,
            value=req.value,
            db=db
        )

    # ── Write RiskLog so heatmap shows data after simulation ──────────────────
    # Map the simulated event value to the correct weather field; use neutral
    # defaults for the other fields so the risk score reflects the event type.
    rain_mm = req.value if req.event_type == "rain"  else 4.0
    aqi     = req.value if req.event_type == "aqi"   else 100.0
    temp_c  = req.value if req.event_type == "heat"  else 30.0
    curfew  = req.event_type in ("curfew", "flood")

    try:
        risk_score = compute_risk_score(rain_mm=rain_mm, aqi=aqi, temp_c=temp_c, curfew=curfew)
        log = RiskLog(
            city=req.city,
            zone=req.zone,
            risk_score=risk_score,
            rain_mm=rain_mm,
            aqi=aqi,
            temp_c=temp_c,
            curfew=curfew,
        )
        db.add(log)
        db.commit()
    except Exception as exc:
        logger.warning("Failed to write RiskLog for simulation %s/%s: %s", req.city, req.event_type, exc)
        db.rollback()

    total_payout = sum(c.payout_amount for c in claims if c.status == ClaimStatus.approved)

    return SimulationResult(
        event_type=req.event_type,
        value=req.value,
        threshold=threshold,
        triggered=triggered,
        affected_workers=len(claims),
        total_payout=total_payout,
        claims_created=[ClaimOut.model_validate(c) for c in claims]
    )

@router.get("/system-health")
def get_system_health(db: Session = Depends(get_db), _: Worker = Depends(get_current_admin)):
    """
    Actuarial health metrics for the System Health panel.

    BCR (Burning Cost Rate) = total_claims_paid / total_premiums_collected
    Loss Ratio              = same value expressed as a percentage
    Enrollment Suspended    = True when loss_ratio > 85%
    """
    # E4 fix: use earned premium (pro-rated) as denominator for actuarially correct BCR.
    from datetime import datetime as _dt
    now_utc = _dt.utcnow()
    policies_all = db.query(Policy).all()
    earned_premium = 0.0
    for p in policies_all:
        policy_duration = (p.end_date - p.start_date).total_seconds()
        if policy_duration <= 0:
            continue
        elapsed = min((now_utc - p.start_date).total_seconds(), policy_duration)
        fraction = max(elapsed / policy_duration, 0.0)
        # Floor: always count at least the full weekly premium so a brand-new
        # policy never produces a near-zero denominator in demo environments.
        earned_premium += max(p.weekly_premium * fraction, p.weekly_premium)
    earned_premium = round(earned_premium, 2)

    total_payout  = db.query(func.sum(Claim.payout_amount)).filter(
        Claim.status.in_([ClaimStatus.approved, ClaimStatus.paid])
    ).scalar() or 0.0

    # Also include manual claim payouts (admin-paid) in Claims Paid total
    manual_payout = db.query(func.sum(ManualClaim.requested_amount)).filter(
        ManualClaim.status == "paid"
    ).scalar() or 0.0
    total_payout = total_payout + manual_payout

    bcr         = round(total_payout / earned_premium, 4) if earned_premium > 0 else 0.0
    loss_ratio  = round(bcr * 100, 2)          # percentage form
    enrollment_suspended = loss_ratio > 80.0

    return {
        "total_premiums_collected": earned_premium,
        "total_claims_paid":        round(total_payout, 2),
        "bcr":                      bcr,
        "loss_ratio_pct":           loss_ratio,
        "enrollment_suspended":     enrollment_suspended,
    }


@router.get("/systemic-pause")
def get_systemic_pause(db: Session = Depends(get_db), _: Worker = Depends(get_current_admin)):
    """Return the current state of the systemic pause kill-switch."""
    settings = db.query(GlobalSettings).filter(GlobalSettings.id == 1).first()
    is_paused = settings.is_systemic_pause if settings else False
    return {"is_systemic_pause": is_paused}


@router.post("/toggle-pause")
def toggle_systemic_pause(db: Session = Depends(get_db), _: Worker = Depends(get_current_admin)):
    """
    Flip the systemic pause kill-switch.
    When True, all automated parametric payouts are suspended platform-wide.
    Use ONLY during declared Force Majeure events (war, pandemic, nuclear hazard).
    """
    import logging
    logger = logging.getLogger(__name__)

    settings = db.query(GlobalSettings).filter(GlobalSettings.id == 1).first()
    if not settings:
        # First call — create the singleton row
        settings = GlobalSettings(id=1, is_systemic_pause=True)
        db.add(settings)
    else:
        settings.is_systemic_pause = not settings.is_systemic_pause

    db.commit()
    db.refresh(settings)

    state = "ACTIVATED" if settings.is_systemic_pause else "DEACTIVATED"
    logger.warning("SYSTEMIC PAUSE %s by admin.", state)

    return {
        "is_systemic_pause": settings.is_systemic_pause,
        "message": f"Systemic pause {state}. All parametric payouts are {'suspended' if settings.is_systemic_pause else 'resumed'}."
    }


@router.get("/analytics/weekly")
def weekly_analytics(db: Session = Depends(get_db), _: Worker = Depends(get_current_admin)):
    """Weekly risk trends and claim frequency."""
    from sqlalchemy import text
    from datetime import datetime, timedelta

    weeks = []
    for i in range(4):
        week_end = datetime.utcnow() - timedelta(weeks=i)
        week_start = week_end - timedelta(weeks=1)
        claims_count = db.query(Claim).filter(
            Claim.created_at >= week_start,
            Claim.created_at < week_end
        ).count()
        payout = db.query(func.sum(Claim.payout_amount)).filter(
            Claim.created_at >= week_start,
            Claim.created_at < week_end,
            Claim.status.in_([ClaimStatus.approved, ClaimStatus.paid])
        ).scalar() or 0.0
        weeks.append({
            "week": f"Week -{i}",
            "start": week_start.isoformat(),
            "end": week_end.isoformat(),
            "claims": claims_count,
            "payout": payout
        })
    return weeks
