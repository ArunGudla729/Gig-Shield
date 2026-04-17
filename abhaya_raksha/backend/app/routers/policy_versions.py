"""
Policy Versioning Router
Allows admin to publish new policy versions and workers to choose adoption.

Flow:
  Admin creates new policy template → all workers notified
  Worker sees banner → chooses NEW or EXISTING
  Workers on NEW are tracked for 90 days for payment regularity
  Irregular workers receive a suggestion to switch back
"""
import logging
from datetime import datetime, timedelta
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Worker, PolicyTemplate, UserPolicyChoice, PolicyAdoptionTracking, Payment
from ..schemas import (
    PolicyTemplateCreate, PolicyTemplateOut,
    UserPolicyChoiceCreate, UserPolicyChoiceOut,
    PolicyAdoptionOut, PolicyAdoptionAdminOut,
)
from ..auth import get_current_worker, get_current_admin
from ..services.notification_service import notify_worker, notify_admin

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/policy-versions", tags=["policy-versions"])

TRACKING_DAYS = 90          # 3-month adoption tracking window
IRREGULAR_THRESHOLD = 2     # missed weeks before flagging as irregular


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_active_template(db: Session) -> PolicyTemplate | None:
    return db.query(PolicyTemplate).filter(PolicyTemplate.is_active == True).first()


def _get_worker_choice(worker_id: int, template_id: int, db: Session) -> UserPolicyChoice | None:
    return db.query(UserPolicyChoice).filter(
        UserPolicyChoice.worker_id == worker_id,
        UserPolicyChoice.policy_template_id == template_id,
    ).first()


# ── Public / Worker endpoints ─────────────────────────────────────────────────

@router.get("/active", response_model=PolicyTemplateOut | None)
def get_active_template(
    db: Session = Depends(get_db),
    _: Worker = Depends(get_current_worker),
):
    """Returns the currently active policy template, or null if none published yet."""
    return _get_active_template(db)


@router.get("/my-choice", response_model=UserPolicyChoiceOut | None)
def get_my_choice(
    db: Session = Depends(get_db),
    current_worker: Worker = Depends(get_current_worker),
):
    """Returns the current worker's choice for the active policy template."""
    template = _get_active_template(db)
    if not template:
        return None
    return _get_worker_choice(current_worker.id, template.id, db)


@router.post("/choose", response_model=UserPolicyChoiceOut)
def make_policy_choice(
    body: UserPolicyChoiceCreate,
    db: Session = Depends(get_db),
    current_worker: Worker = Depends(get_current_worker),
):
    """
    Worker chooses NEW or EXISTING for the active policy template.
    Can only be called once per template per worker.
    """
    choice_val = body.choice.upper()
    if choice_val not in ("NEW", "EXISTING"):
        raise HTTPException(status_code=400, detail="choice must be NEW or EXISTING")

    template = _get_active_template(db)
    if not template:
        raise HTTPException(status_code=404, detail="No active policy template found")

    existing = _get_worker_choice(current_worker.id, template.id, db)
    if existing:
        raise HTTPException(status_code=400, detail="You have already made a choice for this policy version")

    # Calculate adjusted premium for NEW adopters
    adjusted_premium = None
    if choice_val == "NEW":
        # Get worker's current active policy premium as base
        from ..models import Policy, PolicyStatus
        current_policy = db.query(Policy).filter(
            Policy.worker_id == current_worker.id,
            Policy.status == PolicyStatus.active,
        ).first()
        base = current_policy.weekly_premium if current_policy else template.base_premium
        adjusted_premium = round(base * template.premium_multiplier, 2)

    choice = UserPolicyChoice(
        worker_id=current_worker.id,
        policy_template_id=template.id,
        choice=choice_val,
        adjusted_premium=adjusted_premium,
    )
    db.add(choice)

    # Start 90-day tracking for NEW adopters
    if choice_val == "NEW":
        tracking = PolicyAdoptionTracking(
            worker_id=current_worker.id,
            policy_template_id=template.id,
            tracking_end=datetime.utcnow() + timedelta(days=TRACKING_DAYS),
        )
        db.add(tracking)

    db.commit()
    db.refresh(choice)

    # Notify worker of their choice
    if choice_val == "NEW":
        notify_worker(
            db, current_worker,
            f"You've switched to {template.name} (v{template.version}). "
            f"Your new weekly premium is ₹{adjusted_premium:.0f}. "
            "Your payment regularity will be tracked for 90 days.",
            "policy_choice_new",
        )
    else:
        notify_worker(
            db, current_worker,
            f"You've chosen to continue with your existing policy. "
            f"No changes to your premium.",
            "policy_choice_existing",
        )

    logger.info("[policy_versions] Worker %d chose %s for template v%d", current_worker.id, choice_val, template.version)
    return choice


@router.get("/my-tracking", response_model=PolicyAdoptionOut | None)
def get_my_tracking(
    db: Session = Depends(get_db),
    current_worker: Worker = Depends(get_current_worker),
):
    """Returns the worker's 90-day adoption tracking record if they chose NEW."""
    return db.query(PolicyAdoptionTracking).filter(
        PolicyAdoptionTracking.worker_id == current_worker.id
    ).first()


# ── Admin endpoints ───────────────────────────────────────────────────────────

@router.get("/admin/all", response_model=list[PolicyTemplateOut])
def list_all_templates(
    db: Session = Depends(get_db),
    _: Worker = Depends(get_current_admin),
):
    """All policy templates, newest first."""
    return db.query(PolicyTemplate).order_by(PolicyTemplate.version.desc()).all()


@router.post("/admin/publish", response_model=PolicyTemplateOut)
def publish_new_policy(
    body: PolicyTemplateCreate,
    db: Session = Depends(get_db),
    _: Worker = Depends(get_current_admin),
):
    """
    Admin publishes a new policy version.
    - Deactivates the current active template
    - Creates a new template with incremented version
    - Notifies ALL non-admin workers
    """
    # Deactivate current active template
    current = _get_active_template(db)
    prev_id = None
    next_version = 1
    if current:
        current.is_active = False
        prev_id = current.id
        next_version = current.version + 1
        db.flush()

    template = PolicyTemplate(
        version=next_version,
        name=body.name,
        description=body.description,
        benefits=body.benefits,
        base_premium=body.base_premium,
        premium_multiplier=body.premium_multiplier,
        is_active=True,
        previous_policy_id=prev_id,
    )
    db.add(template)
    db.commit()
    db.refresh(template)

    # Notify all non-admin workers
    workers = db.query(Worker).filter(Worker.is_admin == False, Worker.is_active == True).all()
    for worker in workers:
        notify_worker(
            db, worker,
            f"📋 New policy version available: {template.name} (v{template.version}). "
            f"Log in to review the benefits and choose whether to switch.",
            "new_policy_published",
        )

    logger.info("[policy_versions] Published policy v%d — notified %d workers", template.version, len(workers))
    return template


@router.get("/admin/adoption", response_model=list[PolicyAdoptionAdminOut])
def get_adoption_stats(
    db: Session = Depends(get_db),
    _: Worker = Depends(get_current_admin),
):
    """
    Per-worker adoption summary for the active policy template.
    Shows choice, adjusted premium, and tracking status.
    """
    template = _get_active_template(db)
    if not template:
        return []

    choices = db.query(UserPolicyChoice).filter(
        UserPolicyChoice.policy_template_id == template.id
    ).all()

    result = []
    for c in choices:
        worker = db.query(Worker).filter(Worker.id == c.worker_id).first()
        tracking = db.query(PolicyAdoptionTracking).filter(
            PolicyAdoptionTracking.worker_id == c.worker_id,
            PolicyAdoptionTracking.policy_template_id == template.id,
        ).first()
        result.append(PolicyAdoptionAdminOut(
            worker_id=c.worker_id,
            worker_name=worker.name if worker else None,
            choice=c.choice,
            adjusted_premium=c.adjusted_premium,
            is_irregular=tracking.is_irregular if tracking else False,
            irregular_count=tracking.irregular_count if tracking else 0,
            tracking_end=tracking.tracking_end if tracking else None,
        ))
    return result


@router.get("/admin/adoption/summary")
def get_adoption_summary(
    db: Session = Depends(get_db),
    _: Worker = Depends(get_current_admin),
):
    """Quick counts: how many on new vs old policy, how many irregular."""
    template = _get_active_template(db)
    if not template:
        return {"new_count": 0, "existing_count": 0, "no_choice": 0, "irregular_count": 0, "version": None}

    choices = db.query(UserPolicyChoice).filter(
        UserPolicyChoice.policy_template_id == template.id
    ).all()

    total_workers = db.query(Worker).filter(Worker.is_admin == False, Worker.is_active == True).count()
    new_count = sum(1 for c in choices if c.choice == "NEW")
    existing_count = sum(1 for c in choices if c.choice == "EXISTING")
    no_choice = total_workers - len(choices)

    irregular = db.query(PolicyAdoptionTracking).filter(
        PolicyAdoptionTracking.policy_template_id == template.id,
        PolicyAdoptionTracking.is_irregular == True,
    ).count()

    return {
        "version": template.version,
        "name": template.name,
        "new_count": new_count,
        "existing_count": existing_count,
        "no_choice": no_choice,
        "irregular_count": irregular,
    }


# ── Scheduler helper ──────────────────────────────────────────────────────────

def check_adoption_irregularity(db: Session) -> None:
    """
    Called daily by the scheduler.
    For each worker in a 90-day tracking window, check payment regularity.
    If they've missed ≥ IRREGULAR_THRESHOLD weeks, flag as irregular and
    send a suggestion notification (once only).
    """
    now = datetime.utcnow()
    active_trackings = db.query(PolicyAdoptionTracking).filter(
        PolicyAdoptionTracking.tracking_end >= now,
    ).all()

    for tracking in active_trackings:
        worker = db.query(Worker).filter(Worker.id == tracking.worker_id).first()
        if not worker:
            continue

        # Count weeks since tracking started
        weeks_elapsed = max(1, int((now - tracking.tracking_start).days / 7))

        # Count weeks with at least one PAID/ADVANCE payment
        paid_weeks = db.query(Payment).filter(
            Payment.worker_id == tracking.worker_id,
            Payment.paid_at >= tracking.tracking_start,
            Payment.status.in_(["PAID", "ADVANCE"]),
        ).count()

        missed = max(0, weeks_elapsed - paid_weeks)
        tracking.irregular_count = missed

        if missed >= IRREGULAR_THRESHOLD:
            tracking.is_irregular = True
            if not tracking.suggestion_sent:
                tracking.suggestion_sent = True
                template = db.query(PolicyTemplate).filter(
                    PolicyTemplate.id == tracking.policy_template_id
                ).first()
                prev_name = "your previous policy"
                if template and template.previous_policy_id:
                    prev = db.query(PolicyTemplate).filter(
                        PolicyTemplate.id == template.previous_policy_id
                    ).first()
                    if prev:
                        prev_name = f"{prev.name} (v{prev.version})"

                notify_worker(
                    db, worker,
                    f"We noticed some payment irregularity since you switched to the new policy. "
                    f"Consider switching back to {prev_name} for more stability.",
                    "policy_irregularity_suggestion",
                )
                logger.info("[policy_versions] Irregularity suggestion sent to worker %d", worker.id)

    db.commit()
