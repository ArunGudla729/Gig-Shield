import logging
from datetime import datetime
from fastapi import FastAPI, Depends
from sqlalchemy.orm import Session
from sqlalchemy import text
from fastapi.middleware.cors import CORSMiddleware
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from .database import engine, Base, SessionLocal, get_db
from .models import GlobalSettings, Worker
from .auth import get_current_worker
from .routers import auth, workers, policies, claims, admin, notifications, payments, manual_claims, non_payment, policy_versions

logger = logging.getLogger(__name__)

# ── Schema bootstrap ──────────────────────────────────────────────────────────
# create_all() only creates missing tables; it never alters existing ones.
# Any column added to a model after the DB was first created must be migrated
# here with an idempotent ALTER TABLE so the server self-heals on restart.

def _run_safe_migrations() -> None:
    """
    Apply any pending schema changes that create_all() cannot handle.
    Each migration is guarded by a PRAGMA check so it is safe to run on
    every startup — it is a no-op if the column already exists.
    """
    migrations = [
        # (table, column, sql_type)
        ("workers", "last_location_update", "DATETIME"),
        ("workers", "zone_name",            "VARCHAR"),
        ("workers", "gender",               "VARCHAR"),
        ("claims",  "transaction_id",       "VARCHAR"),
        ("non_payment_cases", "admission_from", "DATETIME"),
        ("non_payment_cases", "admission_to",   "DATETIME"),
    ]
    with engine.connect() as conn:
        for table, column, col_type in migrations:
            rows = conn.execute(text(f"PRAGMA table_info({table})")).fetchall()
            existing = {r[1] for r in rows}   # r[1] is the column name
            if column not in existing:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {col_type}"))
                conn.commit()
                logger.info("[migration] Added column %s.%s (%s)", table, column, col_type)
            else:
                logger.debug("[migration] Column %s.%s already exists — skipping", table, column)

# Create all tables on startup, then apply any pending column migrations
Base.metadata.create_all(bind=engine)
_run_safe_migrations()

app = FastAPI(
    title="AbhayaRaksha API",
    description="AI-powered parametric income insurance for India's gig delivery workers",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(workers.router)
app.include_router(policies.router)
app.include_router(claims.router)
app.include_router(admin.router)
app.include_router(notifications.router)
app.include_router(payments.router)
app.include_router(manual_claims.router)
app.include_router(non_payment.router)
app.include_router(policy_versions.router)

# ── Parametric Heart — Background Scheduler ───────────────────────────────────
# Polls weather every 15 minutes for all key cities and auto-triggers claims
# when parametric thresholds are breached. This is the zero-touch core of the
# platform — no admin or worker action required.

MONITORED_CITIES = ["Mumbai", "Delhi", "Bangalore", "Chennai", "Hyderabad"]

# Map weather keys to claim engine event types
_WEATHER_EVENT_MAP = {
    "rain_mm": "rain",
    "aqi":     "aqi",
    "temp_c":  "heat",
}

async def poll_and_trigger():
    """
    Fetch live weather for each monitored city and fire parametric claims
    for any threshold breach. Runs every 15 minutes via APScheduler.
    Each city gets its own DB session that is always closed, even on error.
    """
    from .services.risk_engine import fetch_weather
    from .services.claim_engine import trigger_claims_for_event, THRESHOLDS, _get_rain_threshold

    for city in MONITORED_CITIES:
        db = SessionLocal()
        try:
            weather = await fetch_weather(city)
            logger.info(
                "[scheduler] %s — rain=%.1fmm  aqi=%.0f  temp=%.1f°C",
                city, weather["rain_mm"], weather["aqi"], weather["temp_c"]
            )

            for weather_key, event_type in _WEATHER_EVENT_MAP.items():
                value = weather.get(weather_key, 0.0)
                # BUG-H04 fix: use city-aware rain threshold, not the flat global default
                threshold = _get_rain_threshold(city) if event_type == "rain" else THRESHOLDS.get(event_type, 0)
                if value >= threshold:
                    from .services.notification_service import notify_admin
                    notify_admin(
                        db,
                        f"Weather alert: {event_type}={value:.2f} in {city} (threshold: {threshold})",
                        "weather_alert",
                    )
                    triggered = trigger_claims_for_event(
                        city=city,
                        zone="",          # city-wide event
                        event_type=event_type,
                        value=value,
                        db=db,
                    )
                    if triggered:
                        logger.info(
                            "[scheduler] %s %s=%.2f breached threshold %.2f → %d claims created",
                            city, event_type, value, threshold, len(triggered)
                        )
        except Exception as exc:
            # Log and continue — never let one city failure stop the whole poll
            logger.error("[scheduler] Error processing %s: %s", city, exc)
            try:
                from .services.notification_service import notify_admin
                notify_admin(db, f"Weather API fetch failed for {city}: {exc}", "weather_api_failure")
            except Exception:
                pass
        finally:
            db.close()

async def check_expiry_reminders():
    """Daily job: notify workers whose policy expires within the next 24 hours."""
    from datetime import timedelta
    from .models import Policy, PolicyStatus
    from .services.notification_service import notify_worker

    db = SessionLocal()
    try:
        now = datetime.utcnow()
        tomorrow = now + timedelta(hours=24)
        expiring = db.query(Policy).filter(
            Policy.status == PolicyStatus.active,
            Policy.end_date <= tomorrow,
            Policy.end_date > now,
        ).all()
        for policy in expiring:
            worker = policy.worker
            notify_worker(
                db, worker,
                "Your policy expires tomorrow. Renew to stay protected.",
                "policy_expiry_reminder",
            )
        logger.info("[scheduler] Expiry reminders sent for %d policies", len(expiring))
    except Exception as exc:
        logger.error("[scheduler] Expiry reminder job failed: %s", exc)
    finally:
        db.close()


_scheduler = AsyncIOScheduler()

async def check_payment_overdue():
    """Daily job: send overdue payment reminders (Wednesday only)."""
    from .routers.payments import check_overdue_payments
    db = SessionLocal()
    try:
        check_overdue_payments(db)
    except Exception as exc:
        logger.error("[scheduler] Payment overdue check failed: %s", exc)
    finally:
        db.close()


async def check_adoption_irregularity():
    """Daily job: flag irregular adopters of new policy versions."""
    from .routers.policy_versions import check_adoption_irregularity as _check
    db = SessionLocal()
    try:
        _check(db)
    except Exception as exc:
        logger.error("[scheduler] Adoption irregularity check failed: %s", exc)
    finally:
        db.close()

@app.on_event("startup")
async def start_scheduler():
    _scheduler.add_job(
        poll_and_trigger,
        trigger="interval",
        minutes=15,
        id="parametric_heart",
        replace_existing=True,
    )
    _scheduler.add_job(
        check_expiry_reminders,
        trigger="interval",
        hours=24,
        id="expiry_reminders",
        replace_existing=True,
    )
    _scheduler.add_job(
        check_payment_overdue,
        trigger="interval",
        hours=24,
        id="payment_overdue_check",
        replace_existing=True,
    )
    _scheduler.add_job(
        check_adoption_irregularity,
        trigger="interval",
        hours=24,
        id="adoption_irregularity_check",
        replace_existing=True,
    )
    _scheduler.start()
    logger.info("[scheduler] Parametric Heart started — polling every 15 minutes")

@app.on_event("shutdown")
async def stop_scheduler():
    _scheduler.shutdown(wait=False)
    logger.info("[scheduler] Parametric Heart stopped")

# ── Health & Root ─────────────────────────────────────────────────────────────

@app.get("/api/system/status")
def system_status(
    db: Session = Depends(get_db),
    _: Worker = Depends(get_current_worker),   # any logged-in worker or admin
):
    """
    Public (worker-accessible) read of platform-wide settings.
    Returns the systemic pause state so the worker dashboard can show the
    emergency banner without needing admin credentials.
    """
    settings = db.query(GlobalSettings).filter(GlobalSettings.id == 1).first()
    return {
        "is_systemic_pause": settings.is_systemic_pause if settings else False,
    }


@app.get("/")
def root():
    return {
        "name": "AbhayaRaksha",
        "tagline": "Parametric income insurance for gig workers",
        "docs": "/docs",
        "scheduler": "running" if _scheduler.running else "stopped",
    }

@app.get("/health")
def health():
    return {
        "status": "ok",
        "scheduler": "running" if _scheduler.running else "stopped",
    }
