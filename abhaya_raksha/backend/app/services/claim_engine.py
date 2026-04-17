"""
Parametric Claim Engine
Automatically triggers claims when disruption thresholds are breached.
No manual filing needed – pure parametric insurance.
"""
import logging
from datetime import datetime, timedelta
from sqlalchemy import func
from sqlalchemy.orm import Session
from ..models import Worker, Policy, Claim, PolicyStatus, ClaimStatus, DisruptionEvent, GlobalSettings
from .fraud_detector import check_fraud

logger = logging.getLogger(__name__)

# ── Parametric Thresholds ─────────────────────────────────────────────────────
THRESHOLDS = {
    "rain":   15.0,   # mm/3h — default; overridden per city by CITY_RAIN_THRESHOLDS
    "aqi":    200.0,  # AQI index
    "heat":   42.0,   # °C
    "curfew": 1.0,    # boolean as float
    "flood":  1.0,
}

# City-specific rain thresholds (mm/3h) based on IMD climatological normals.
# A uniform 15mm threshold is actuarially unfair: it fires constantly in monsoon
# Mumbai while almost never firing in arid Delhi.
CITY_RAIN_THRESHOLDS = {
    "mumbai":    35.0,  # IMD "heavy rainfall" category; 15mm is a routine Mumbai shower
    "chennai":   25.0,  # moderate monsoon city
    "bangalore": 20.0,  # moderate
    "hyderabad": 15.0,  # default
    "delhi":     12.0,  # semi-arid; 12mm is genuinely disruptive here
}

def _get_rain_threshold(city: str) -> float:
    """Return the city-appropriate rain threshold, falling back to the default."""
    return CITY_RAIN_THRESHOLDS.get(city.lower(), THRESHOLDS["rain"])

# Payout % of coverage per trigger type
# Coverage is now 1× weekly income, so these rates represent days of income replaced:
#   0.167 ≈ 1/6 weekly income = 1 lost working day
#   0.333 ≈ 2 lost working days
#   0.500 ≈ 3 lost working days
PAYOUT_RATES = {
    "rain":   0.080,  # ~1/3 of a lost working day
    "aqi":    0.080,  # ~1/3 of a lost working day
    "heat":   0.080,  # ~1/3 of a lost working day
    "curfew": 0.150,  # ~2/3 of a lost working day (curfew typically lasts longer)
    "flood":  0.220,  # ~1 lost working day (severe event)
}

def trigger_claims_for_event(
    city: str,
    zone: str,
    event_type: str,
    value: float,
    db: Session
) -> list[Claim]:
    """
    Called by the scheduler or simulation endpoint.
    Finds all active policies in the affected city/zone and creates claims.
    """
    threshold = _get_rain_threshold(city) if event_type == "rain" else THRESHOLDS.get(event_type, 0)
    if value < threshold:
        return []

    # ── Systemic pause kill-switch ────────────────────────────────────────────
    # Checked before any DB writes. If a Force Majeure event (war, pandemic,
    # nuclear) has been declared by an admin, all automated payouts are suspended
    # to prevent fund insolvency.
    settings = db.query(GlobalSettings).filter(GlobalSettings.id == 1).first()
    if settings and settings.is_systemic_pause:
        logger.warning(
            "SYSTEMIC PAUSE: Payouts suspended for fund sustainability during a "
            "Force Majeure event. Event %s/%s=%s not processed.",
            city, event_type, value
        )
        return []

    # Record disruption event
    event = DisruptionEvent(
        city=city, zone=zone,
        event_type=event_type,
        value=value,
        threshold=threshold,
        triggered=True
    )
    db.add(event)
    db.flush()

    # Find affected workers with active policies
    workers = db.query(Worker).filter(
        Worker.city.ilike(f"%{city}%"),
        Worker.is_active == True
    ).all()

    created_claims = []
    for worker in workers:
        # Get active policy — must be within its coverage window AND past underwriting period
        policy = db.query(Policy).filter(
            Policy.worker_id == worker.id,
            Policy.status == PolicyStatus.active,
            Policy.start_date <= datetime.utcnow(),
            Policy.end_date >= datetime.utcnow(),
            # BUG-H02 fix: never fire claims during the underwriting waiting period
            (Policy.underwriting_start_date == None) |
            (Policy.underwriting_start_date <= datetime.utcnow()),
        ).first()
        if not policy:
            continue

        today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        week_start  = datetime.utcnow() - timedelta(days=7)

        # ── Double-dip guard: one payout per worker per calendar day ─────────
        # Blocks Rain + AQI same-day stacking — any approved/paid claim today
        # means the worker has already been compensated for this disruption day.
        today_paid = db.query(func.sum(Claim.payout_amount)).filter(
            Claim.worker_id == worker.id,
            Claim.created_at >= today_start,
            Claim.status.in_([ClaimStatus.approved, ClaimStatus.paid]),
        ).scalar() or 0.0

        if today_paid >= worker.avg_daily_income:
            continue  # daily cap reached — worker already compensated for today

        # ── Weekly aggregate cap: total payouts cannot exceed weekly income ──
        weekly_paid = db.query(func.sum(Claim.payout_amount)).filter(
            Claim.worker_id == worker.id,
            Claim.created_at >= week_start,
            Claim.status.in_([ClaimStatus.approved, ClaimStatus.paid]),
        ).scalar() or 0.0

        weekly_income = worker.avg_daily_income * 6
        if weekly_paid >= weekly_income:
            continue  # weekly cap exhausted — no further payouts this policy week

        # Fraud check — use live GPS if available, fall back to registered coords.
        # live GPS is captured by the browser on dashboard mount and stored in
        # last_lat/last_lng via POST /workers/location. Using registered coords
        # (worker.lat/lng) would make the GPS mismatch check compare a point to
        # itself (always 0 km) and never flag out-of-zone claims.
        has_live_gps = worker.last_lat is not None and worker.last_lng is not None
        live_lat = worker.last_lat if has_live_gps else worker.lat
        live_lng = worker.last_lng if has_live_gps else worker.lng
        fraud_result = check_fraud(
            worker=worker,
            claim_lat=live_lat,
            claim_lng=live_lng,
            trigger_type=event_type,
            db=db
        )

        payout = round(policy.coverage_amount * PAYOUT_RATES.get(event_type, 0.167), 2)
        # Moral hazard cap: no single trigger can pay more than 1.2× a day's income.
        # This ensures the worker is never financially better off by not working.
        daily_income_cap = round(worker.avg_daily_income * 1.2, 2)
        payout = min(payout, daily_income_cap)
        claim_status = ClaimStatus.rejected if fraud_result["is_fraud"] else ClaimStatus.approved

        # Auto-payout: generate Razorpay order ID immediately for approved claims
        # so workers never need to manually withdraw.
        auto_txn_id = None
        if claim_status == ClaimStatus.approved:
            try:
                from .payment_service import create_razorpay_order
                order = create_razorpay_order(
                    amount_inr=payout,
                    reference_id=f"auto_claim_{worker.id}_{int(datetime.utcnow().timestamp())}"
                )
                auto_txn_id = order["order_id"]
                claim_status = ClaimStatus.paid   # mark paid immediately
            except Exception as pay_exc:
                logger.warning("Auto-payout failed for worker #%d: %s — leaving as approved", worker.id, pay_exc)

        claim = Claim(
            worker_id=worker.id,
            policy_id=policy.id,
            trigger_type=event_type,
            trigger_value=value,
            trigger_threshold=threshold,
            payout_amount=payout,
            status=claim_status,
            fraud_score=fraud_result["fraud_score"],
            fraud_flags=fraud_result["fraud_flags"],
            transaction_id=auto_txn_id,
            approved_at=datetime.utcnow() if claim_status in (ClaimStatus.approved, ClaimStatus.paid) else None
        )
        db.add(claim)
        # E5 fix: flush immediately so subsequent iterations of this loop can see
        # this claim in the today_paid / weekly_paid guard queries above.
        # Without flush(), all claims in the same batch are invisible to the guard
        # (they are in the session but not yet in the DB read path), allowing
        # multiple same-day claims for the same worker to slip through.
        db.flush()
        created_claims.append(claim)

    db.commit()
    for c in created_claims:
        db.refresh(c)

    # ── Notifications ─────────────────────────────────────────────────────────
    from .notification_service import notify_worker, notify_admin
    FRAUD_ALERT_THRESHOLD = 0.7
    for claim in created_claims:
        worker = db.query(Worker).filter(Worker.id == claim.worker_id).first()
        if not worker:
            continue
        if claim.status == ClaimStatus.approved:
            notify_worker(
                db, worker,
                f"Your claim of \u20b9{claim.payout_amount:.0f} has been approved. Withdraw via app.",
                "claim_approved",
            )
        elif claim.status == ClaimStatus.paid:
            notify_worker(
                db, worker,
                f"\u20b9{claim.payout_amount:.0f} credited automatically due to disruption. TXN: {claim.transaction_id}",
                "claim_approved",
            )
        elif claim.status == ClaimStatus.rejected:
            notify_worker(
                db, worker,
                f"Your claim was flagged for review (fraud score: {claim.fraud_score:.2f}).",
                "claim_rejected",
            )
        if claim.fraud_score >= FRAUD_ALERT_THRESHOLD:
            notify_admin(
                db,
                f"High fraud score {claim.fraud_score:.2f} for worker #{worker.id} in {city}",
                "fraud_alert",
            )

    return created_claims
