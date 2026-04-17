"""
Manual Claim Router
Handles worker-initiated claim requests (not parametric).
Max ₹1000 per claim. Requires admin approval before payout.
Does NOT touch the existing parametric Claim table or claim engine.
"""
import logging
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Worker, ManualClaim
from ..schemas import ManualClaimCreate, ManualClaimOut, ManualClaimAdminOut
from ..auth import get_current_worker, get_current_admin
from ..services.notification_service import notify_worker, notify_admin
from ..services.payment_service import create_razorpay_order

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/manual-claims", tags=["manual-claims"])

MAX_CLAIM_AMOUNT = 1000.0  # ₹1000 hard cap per claim


# ── Worker endpoints ──────────────────────────────────────────────────────────

@router.post("", response_model=ManualClaimOut)
def submit_claim(
    body: ManualClaimCreate,
    db: Session = Depends(get_db),
    current_worker: Worker = Depends(get_current_worker),
):
    """
    Worker submits a manual claim request.
    Amount must be ≤ ₹1000. Status starts as 'pending'.
    """
    if body.requested_amount <= 0:
        raise HTTPException(status_code=400, detail="Claim amount must be positive.")
    if body.requested_amount > MAX_CLAIM_AMOUNT:
        raise HTTPException(
            status_code=400,
            detail=f"Claim amount cannot exceed ₹{MAX_CLAIM_AMOUNT:.0f}. "
                   f"You requested ₹{body.requested_amount:.0f}."
        )

    claim = ManualClaim(
        worker_id=current_worker.id,
        requested_amount=body.requested_amount,
        reason=body.reason,
        status="pending",
    )
    db.add(claim)
    db.commit()
    db.refresh(claim)

    # Notify worker + admin
    notify_worker(
        db, current_worker,
        f"Your claim request of ₹{body.requested_amount:.0f} has been submitted and is pending review.",
        "claim_submitted",
    )
    notify_admin(
        db,
        f"New claim request from {current_worker.name}: ₹{body.requested_amount:.0f}. "
        f"Reason: {body.reason or 'Not specified'}",
        "claim_submitted",
    )

    logger.info("[manual_claims] Worker %d submitted claim ₹%.2f", current_worker.id, body.requested_amount)
    return claim


@router.get("/my", response_model=list[ManualClaimOut])
def get_my_claims(
    db: Session = Depends(get_db),
    current_worker: Worker = Depends(get_current_worker),
):
    """Worker's own manual claim history, newest first."""
    return (
        db.query(ManualClaim)
        .filter(ManualClaim.worker_id == current_worker.id)
        .order_by(ManualClaim.created_at.desc())
        .all()
    )


# ── Admin endpoints ───────────────────────────────────────────────────────────

@router.get("/admin/pending", response_model=list[ManualClaimAdminOut])
def list_pending_claims(
    db: Session = Depends(get_db),
    _: Worker = Depends(get_current_admin),
):
    """All pending manual claims for admin review."""
    claims = (
        db.query(ManualClaim)
        .filter(ManualClaim.status == "pending")
        .order_by(ManualClaim.created_at.asc())
        .all()
    )
    result = []
    for c in claims:
        worker = db.query(Worker).filter(Worker.id == c.worker_id).first()
        result.append(ManualClaimAdminOut(
            id=c.id,
            worker_id=c.worker_id,
            worker_name=worker.name if worker else None,
            requested_amount=c.requested_amount,
            status=c.status,
            reason=c.reason,
            transaction_id=c.transaction_id,
            admin_note=c.admin_note,
            created_at=c.created_at,
        ))
    return result


@router.get("/admin/all", response_model=list[ManualClaimAdminOut])
def list_all_claims(
    db: Session = Depends(get_db),
    _: Worker = Depends(get_current_admin),
):
    """All manual claims (any status) for admin view, newest first."""
    claims = (
        db.query(ManualClaim)
        .order_by(ManualClaim.created_at.desc())
        .limit(100)
        .all()
    )
    result = []
    for c in claims:
        worker = db.query(Worker).filter(Worker.id == c.worker_id).first()
        result.append(ManualClaimAdminOut(
            id=c.id,
            worker_id=c.worker_id,
            worker_name=worker.name if worker else None,
            requested_amount=c.requested_amount,
            status=c.status,
            reason=c.reason,
            transaction_id=c.transaction_id,
            admin_note=c.admin_note,
            created_at=c.created_at,
        ))
    return result


@router.post("/admin/{claim_id}/approve", response_model=ManualClaimAdminOut)
def approve_claim(
    claim_id: int,
    db: Session = Depends(get_db),
    _: Worker = Depends(get_current_admin),
):
    """Admin approves a pending claim. Status: pending → approved."""
    claim = db.query(ManualClaim).filter(ManualClaim.id == claim_id).first()
    if not claim:
        raise HTTPException(status_code=404, detail="Claim not found")
    if claim.status != "pending":
        raise HTTPException(status_code=400, detail=f"Claim is already {claim.status}")

    claim.status = "approved"
    db.commit()
    db.refresh(claim)

    worker = db.query(Worker).filter(Worker.id == claim.worker_id).first()
    if worker:
        notify_worker(
            db, worker,
            f"Your claim of ₹{claim.requested_amount:.0f} has been approved. Payout will follow shortly.",
            "claim_approved",
        )

    logger.info("[manual_claims] Claim %d approved", claim_id)
    return ManualClaimAdminOut(
        id=claim.id, worker_id=claim.worker_id,
        worker_name=worker.name if worker else None,
        requested_amount=claim.requested_amount, status=claim.status,
        reason=claim.reason, transaction_id=claim.transaction_id,
        admin_note=claim.admin_note, created_at=claim.created_at,
    )


@router.post("/admin/{claim_id}/reject", response_model=ManualClaimAdminOut)
def reject_claim(
    claim_id: int,
    db: Session = Depends(get_db),
    _: Worker = Depends(get_current_admin),
):
    """Admin rejects a pending claim. Status: pending → rejected."""
    claim = db.query(ManualClaim).filter(ManualClaim.id == claim_id).first()
    if not claim:
        raise HTTPException(status_code=404, detail="Claim not found")
    if claim.status != "pending":
        raise HTTPException(status_code=400, detail=f"Claim is already {claim.status}")

    claim.status = "rejected"
    db.commit()
    db.refresh(claim)

    worker = db.query(Worker).filter(Worker.id == claim.worker_id).first()
    if worker:
        notify_worker(
            db, worker,
            f"Your claim of ₹{claim.requested_amount:.0f} has been reviewed and rejected.",
            "claim_rejected",
        )

    logger.info("[manual_claims] Claim %d rejected", claim_id)
    return ManualClaimAdminOut(
        id=claim.id, worker_id=claim.worker_id,
        worker_name=worker.name if worker else None,
        requested_amount=claim.requested_amount, status=claim.status,
        reason=claim.reason, transaction_id=claim.transaction_id,
        admin_note=claim.admin_note, created_at=claim.created_at,
    )


@router.post("/admin/{claim_id}/pay", response_model=ManualClaimAdminOut)
def pay_claim(
    claim_id: int,
    db: Session = Depends(get_db),
    _: Worker = Depends(get_current_admin),
):
    """
    Admin pays an approved claim.
    Status: approved → paid. Generates transaction_id.
    """
    claim = db.query(ManualClaim).filter(ManualClaim.id == claim_id).first()
    if not claim:
        raise HTTPException(status_code=404, detail="Claim not found")
    if claim.status != "approved":
        raise HTTPException(status_code=400, detail=f"Claim must be approved before paying (current: {claim.status})")

    # Create Razorpay order — claim status only updated after successful API call
    order = create_razorpay_order(
        amount_inr=claim.requested_amount,
        reference_id=f"manual_claim_{claim.id}"
    )
    txn_id = order["order_id"]
    claim.status = "paid"
    claim.transaction_id = txn_id
    db.commit()
    db.refresh(claim)

    worker = db.query(Worker).filter(Worker.id == claim.worker_id).first()
    if worker:
        notify_worker(
            db, worker,
            f"₹{claim.requested_amount:.0f} has been paid to your account. "
            f"Transaction ID: {txn_id}",
            "claim_paid",
        )

    logger.info("[manual_claims] Claim %d paid — TXN %s", claim_id, txn_id)
    return ManualClaimAdminOut(
        id=claim.id, worker_id=claim.worker_id,
        worker_name=worker.name if worker else None,
        requested_amount=claim.requested_amount, status=claim.status,
        reason=claim.reason, transaction_id=claim.transaction_id,
        admin_note=claim.admin_note, created_at=claim.created_at,
    )
