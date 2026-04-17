"""
Premium Payment Router
Handles worker premium payments: current week, advance, and past-due clearing.
Uses the existing notification system for all payment events.
"""
import logging
from datetime import datetime, timedelta, date
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func

from ..database import get_db
from ..models import Worker, Policy, Payment, PolicyStatus
from ..schemas import PaymentCreate, PaymentOut, PaymentStatusOut, WorkerPaymentSummary
from ..auth import get_current_worker, get_current_admin
from ..services.notification_service import notify_worker, notify_admin

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/payments", tags=["payments"])


# ── Helpers ───────────────────────────────────────────────────────────────────

def _week_bounds(dt: datetime) -> tuple[datetime, datetime]:
    """Return (Monday 00:00, Sunday 23:59:59) UTC for the week containing dt."""
    monday = dt - timedelta(days=dt.weekday())
    monday = monday.replace(hour=0, minute=0, second=0, microsecond=0)
    sunday = monday + timedelta(days=6, hours=23, minutes=59, seconds=59)
    return monday, sunday


def _get_active_policy(worker_id: int, db: Session) -> Policy | None:
    """Return the worker's current active policy, or None."""
    now = datetime.utcnow()
    return db.query(Policy).filter(
        Policy.worker_id == worker_id,
        Policy.status == PolicyStatus.active,
        Policy.end_date >= now,
    ).first()


def _payment_behaviour(payments: list[Payment], weekly_premium: float) -> str:
    """
    Simple rule-based behaviour indicator — no ML.
    GOOD      : ≥ 80% of weeks paid on time (payment_date within the week)
    DELAYED   : some payments made but consistently late
    IRREGULAR : fewer than half of expected weeks paid
    """
    if not payments:
        return "IRREGULAR"

    paid = [p for p in payments if p.status == "PAID"]
    advance = [p for p in payments if p.status == "ADVANCE"]
    on_time = [p for p in paid if p.payment_date <= p.week_end_date]

    total_relevant = len(paid) + len(advance)
    if total_relevant == 0:
        return "IRREGULAR"

    on_time_ratio = len(on_time) / total_relevant
    if on_time_ratio >= 0.8:
        return "GOOD"
    elif on_time_ratio >= 0.4:
        return "DELAYED"
    return "IRREGULAR"


# ── Worker endpoints ──────────────────────────────────────────────────────────

@router.post("", response_model=PaymentOut)
def make_payment(
    body: PaymentCreate,
    db: Session = Depends(get_db),
    current_worker: Worker = Depends(get_current_worker),
):
    """
    Worker submits a premium payment.
    - payment_date in current week  → status = PAID
    - payment_date in a future week → status = ADVANCE, is_advance = True
    - payment_date in a past week   → clears that week's due → status = PAID
    """
    policy = _get_active_policy(current_worker.id, db)
    if not policy:
        raise HTTPException(status_code=400, detail="No active policy found. Activate a policy first.")

    if body.amount <= 0:
        raise HTTPException(status_code=400, detail="Payment amount must be positive.")

    payment_dt = body.payment_date
    # Ensure timezone-naive for comparison
    if payment_dt.tzinfo is not None:
        payment_dt = payment_dt.replace(tzinfo=None)

    now = datetime.utcnow()
    current_week_start, current_week_end = _week_bounds(now)
    payment_week_start, payment_week_end = _week_bounds(payment_dt)

    # Determine status
    if payment_week_start > current_week_start:
        status = "ADVANCE"
        is_advance = True
    else:
        status = "PAID"
        is_advance = False

    # Prevent duplicate payment for the same week
    existing = db.query(Payment).filter(
        Payment.worker_id == current_worker.id,
        Payment.week_start_date == payment_week_start,
        Payment.status.in_(["PAID", "ADVANCE"]),
    ).first()
    if existing:
        raise HTTPException(
            status_code=400,
            detail=f"Week of {payment_week_start.date()} already has a {existing.status} payment."
        )

    payment = Payment(
        worker_id=current_worker.id,
        amount=body.amount,
        payment_date=payment_dt,
        status=status,
        is_advance=is_advance,
        week_start_date=payment_week_start,
        week_end_date=payment_week_end,
    )
    db.add(payment)
    db.commit()
    db.refresh(payment)

    # ── Notifications ─────────────────────────────────────────────────────────
    if is_advance:
        notify_worker(
            db, current_worker,
            f"Advance premium of ₹{body.amount:.0f} recorded for week of "
            f"{payment_week_start.date()}. Thank you!",
            "advance_payment",
        )
        notify_admin(
            db,
            f"Worker {current_worker.name} made an advance payment of ₹{body.amount:.0f} "
            f"for week {payment_week_start.date()}.",
            "advance_payment",
        )
    else:
        # Check if this was clearing a past due
        if payment_week_start < current_week_start:
            notify_worker(
                db, current_worker,
                f"Past due of ₹{body.amount:.0f} for week of {payment_week_start.date()} cleared. ✅",
                "dues_cleared",
            )
        else:
            notify_worker(
                db, current_worker,
                f"Premium payment of ₹{body.amount:.0f} received for current week. ✅",
                "payment_completed",
            )

    logger.info(
        "[payments] Worker %d paid ₹%.2f for week %s — status=%s",
        current_worker.id, body.amount, payment_week_start.date(), status,
    )
    return payment


@router.get("/status", response_model=PaymentStatusOut)
def get_payment_status(
    db: Session = Depends(get_db),
    current_worker: Worker = Depends(get_current_worker),
):
    """
    Returns the worker's current payment status:
    - current week: PAID or PENDING
    - total due (unpaid weeks since policy start)
    - advance payments
    - full payment history
    """
    policy = _get_active_policy(current_worker.id, db)
    weekly_premium = policy.weekly_premium if policy else 0.0

    now = datetime.utcnow()
    current_week_start, _ = _week_bounds(now)

    all_payments = (
        db.query(Payment)
        .filter(Payment.worker_id == current_worker.id)
        .order_by(Payment.week_start_date.desc())
        .all()
    )

    paid_week_starts = {
        p.week_start_date.replace(tzinfo=None) if p.week_start_date.tzinfo else p.week_start_date
        for p in all_payments
        if p.status in ("PAID", "ADVANCE")
    }

    # Current week status
    cws = current_week_start.replace(tzinfo=None) if current_week_start.tzinfo else current_week_start
    current_week_status = "PAID" if cws in paid_week_starts else "PENDING"

    # Calculate due: weeks since policy start that are unpaid
    total_due = 0.0
    if policy:
        policy_start = policy.start_date.replace(tzinfo=None) if policy.start_date.tzinfo else policy.start_date
        week_cursor, _ = _week_bounds(policy_start)
        while week_cursor <= current_week_start:
            wc = week_cursor.replace(tzinfo=None) if week_cursor.tzinfo else week_cursor
            if wc not in paid_week_starts:
                total_due += weekly_premium
            week_cursor += timedelta(weeks=1)

    advance_payments = [p for p in all_payments if p.status == "ADVANCE"]
    advance_total = sum(p.amount for p in advance_payments)

    return PaymentStatusOut(
        current_week_status=current_week_status,
        total_due=round(total_due, 2),
        advance_count=len(advance_payments),
        advance_total=round(advance_total, 2),
        payments=all_payments,
    )


@router.get("/history", response_model=list[PaymentOut])
def get_payment_history(
    db: Session = Depends(get_db),
    current_worker: Worker = Depends(get_current_worker),
):
    """Full payment history for the current worker, newest first."""
    return (
        db.query(Payment)
        .filter(Payment.worker_id == current_worker.id)
        .order_by(Payment.paid_at.desc())
        .all()
    )


# ── Admin endpoints ───────────────────────────────────────────────────────────

@router.get("/admin/summary", response_model=list[WorkerPaymentSummary])
def admin_payment_summary(
    db: Session = Depends(get_db),
    _: Worker = Depends(get_current_admin),
):
    """
    Per-worker payment summary for the admin dashboard.
    Returns one row per non-admin worker with status, due, behaviour indicator.
    """
    workers = db.query(Worker).filter(Worker.is_admin == False, Worker.is_active == True).all()
    now = datetime.utcnow()
    current_week_start, _ = _week_bounds(now)

    result = []
    for worker in workers:
        policy = _get_active_policy(worker.id, db)
        weekly_premium = policy.weekly_premium if policy else 0.0

        payments = (
            db.query(Payment)
            .filter(Payment.worker_id == worker.id)
            .order_by(Payment.week_start_date.asc())
            .all()
        )

        paid_week_starts = {
            p.week_start_date.replace(tzinfo=None) if p.week_start_date.tzinfo else p.week_start_date
            for p in payments
            if p.status in ("PAID", "ADVANCE")
        }

        cws = current_week_start.replace(tzinfo=None) if current_week_start.tzinfo else current_week_start
        current_week_status = "PAID" if cws in paid_week_starts else "PENDING"

        # Due calculation
        due = 0.0
        if policy:
            policy_start = policy.start_date.replace(tzinfo=None) if policy.start_date.tzinfo else policy.start_date
            week_cursor, _ = _week_bounds(policy_start)
            while week_cursor <= current_week_start:
                wc = week_cursor.replace(tzinfo=None) if week_cursor.tzinfo else week_cursor
                if wc not in paid_week_starts:
                    due += weekly_premium
                week_cursor += timedelta(weeks=1)

        advance_payments = [p for p in payments if p.status == "ADVANCE"]
        total_paid = sum(p.amount for p in payments if p.status == "PAID")
        behaviour = _payment_behaviour(payments, weekly_premium)

        result.append(WorkerPaymentSummary(
            worker_id=worker.id,
            worker_name=worker.name,
            city=worker.city,
            current_week_status=current_week_status,
            due_amount=round(due, 2),
            advance_count=len(advance_payments),
            behaviour=behaviour,
            total_paid=round(total_paid, 2),
        ))

    return result


@router.get("/admin/worker/{worker_id}", response_model=list[PaymentOut])
def admin_worker_payment_history(
    worker_id: int,
    db: Session = Depends(get_db),
    _: Worker = Depends(get_current_admin),
):
    """Full payment history for a specific worker (admin view)."""
    worker = db.query(Worker).filter(Worker.id == worker_id).first()
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    return (
        db.query(Payment)
        .filter(Payment.worker_id == worker_id)
        .order_by(Payment.paid_at.desc())
        .all()
    )


@router.get("/admin/totals")
def admin_payment_totals(
    db: Session = Depends(get_db),
    _: Worker = Depends(get_current_admin),
):
    """Aggregate payment totals for the admin summary card."""
    total_received = db.query(func.sum(Payment.amount)).filter(
        Payment.status.in_(["PAID", "ADVANCE"])
    ).scalar() or 0.0

    total_advance = db.query(func.sum(Payment.amount)).filter(
        Payment.status == "ADVANCE"
    ).scalar() or 0.0

    pending_workers = (
        db.query(func.count(func.distinct(Payment.worker_id)))
        .filter(Payment.status == "PENDING")
        .scalar() or 0
    )

    return {
        "total_received": round(total_received, 2),
        "total_advance": round(total_advance, 2),
        "pending_workers": pending_workers,
    }


# ── Scheduler helper (called from main.py) ────────────────────────────────────

def check_overdue_payments(db: Session) -> None:
    """
    Called daily by the scheduler.
    For each worker with an active policy and no payment for the current week,
    send an overdue notification.
    """
    now = datetime.utcnow()
    current_week_start, _ = _week_bounds(now)

    # Only notify on Wednesdays (mid-week reminder) to avoid spam
    if now.weekday() != 2:
        return

    workers = db.query(Worker).filter(Worker.is_admin == False, Worker.is_active == True).all()
    for worker in workers:
        policy = _get_active_policy(worker.id, db)
        if not policy:
            continue

        cws = current_week_start.replace(tzinfo=None) if current_week_start.tzinfo else current_week_start
        paid_this_week = db.query(Payment).filter(
            Payment.worker_id == worker.id,
            Payment.week_start_date == cws,
            Payment.status.in_(["PAID", "ADVANCE"]),
        ).first()

        if not paid_this_week:
            notify_worker(
                db, worker,
                f"Reminder: Your weekly premium of ₹{policy.weekly_premium:.0f} is due. "
                "Pay now to keep your coverage active.",
                "payment_overdue",
            )
            logger.info("[payments] Overdue reminder sent to worker %d", worker.id)
