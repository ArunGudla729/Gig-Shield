"""
Non-Payment Handling Router
Manages health-related and simple non-payment cases.
- Workers can report health issues and upload documents
- Workers blocked for simple non-payment see a blocked UI
- Admins review documents, classify cases, and manage fines
- All state transitions trigger notifications via existing system
"""
import os
import logging
from datetime import datetime, timedelta
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Worker, NonPaymentCase
from ..schemas import (
    NonPaymentCaseOut, NonPaymentCaseAdminOut,
    ReportHealthIssueRequest, AdminClassifyRequest,
    AdminDocumentActionRequest,
)
from ..auth import get_current_worker, get_current_admin
from ..services.notification_service import notify_worker, notify_admin

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/non-payment", tags=["non-payment"])

MAJOR_FINE_AMOUNT = 10000.0
BLOCK_DURATION_MONTHS = 6
MINOR_PREMIUM_PENALTY = 0.10

# Directory to store uploaded health documents (relative to backend/)
UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "../../uploads/health_docs")
os.makedirs(UPLOAD_DIR, exist_ok=True)


def _get_or_create_case(worker_id: int, db: Session) -> NonPaymentCase:
    case = db.query(NonPaymentCase).filter(NonPaymentCase.worker_id == worker_id).first()
    if not case:
        case = NonPaymentCase(worker_id=worker_id, payment_status="ACTIVE")
        db.add(case)
        db.flush()
    return case


def _to_admin_out(c: NonPaymentCase, worker_name: str | None) -> NonPaymentCaseAdminOut:
    return NonPaymentCaseAdminOut(
        id=c.id, worker_id=c.worker_id, worker_name=worker_name,
        payment_status=c.payment_status,
        non_payment_reason=c.non_payment_reason,
        health_case_type=c.health_case_type,
        document_uploaded=c.document_uploaded,
        document_filename=c.document_filename,
        document_status=c.document_status,
        admission_from=c.admission_from,
        admission_to=c.admission_to,
        fine_amount=c.fine_amount,
        fine_paid=c.fine_paid,
        block_until=c.block_until,
        premium_penalty=c.premium_penalty,
        admin_note=c.admin_note,
        created_at=c.created_at,
    )


# ── Worker endpoints ──────────────────────────────────────────────────────────

@router.get("/status", response_model=NonPaymentCaseOut)
def get_my_status(
    db: Session = Depends(get_db),
    current_worker: Worker = Depends(get_current_worker),
):
    case = _get_or_create_case(current_worker.id, db)
    db.commit()
    db.refresh(case)
    return case


@router.post("/upload-document")
async def upload_health_document(
    file: UploadFile = File(...),
    current_worker: Worker = Depends(get_current_worker),
    db: Session = Depends(get_db),
):
    """
    Worker uploads a health document (prescription / hospital proof).
    Returns the saved filename to be passed to report-health.
    Max file size: 5MB. Accepted: PDF, JPG, PNG.
    """
    ALLOWED_TYPES = {"application/pdf", "image/jpeg", "image/png", "image/jpg"}
    MAX_SIZE = 5 * 1024 * 1024  # 5MB

    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(status_code=400, detail="Only PDF, JPG, and PNG files are accepted.")

    contents = await file.read()
    if len(contents) > MAX_SIZE:
        raise HTTPException(status_code=400, detail="File size must be under 5MB.")

    # Save with worker-id prefix to avoid collisions
    ext = os.path.splitext(file.filename or "doc")[1] or ".pdf"
    saved_name = f"worker_{current_worker.id}_{int(datetime.utcnow().timestamp())}{ext}"
    save_path = os.path.join(UPLOAD_DIR, saved_name)
    with open(save_path, "wb") as f:
        f.write(contents)

    logger.info("[non_payment] Worker %d uploaded document: %s", current_worker.id, saved_name)
    return {"filename": saved_name, "original_name": file.filename}


@router.post("/report-health", response_model=NonPaymentCaseOut)
def report_health_issue(
    body: ReportHealthIssueRequest,
    db: Session = Depends(get_db),
    current_worker: Worker = Depends(get_current_worker),
):
    """
    Worker reports a health issue as reason for non-payment.
    Accepts document filename (from upload-document) + optional admission dates.
    """
    case = _get_or_create_case(current_worker.id, db)

    if case.payment_status == "BLOCKED":
        raise HTTPException(status_code=400, detail="Your account is blocked. You cannot submit health requests.")

    case.non_payment_reason = "HEALTH"
    case.payment_status = "PENDING"
    case.document_uploaded = True
    case.document_filename = body.document_filename
    case.document_status = "PENDING"
    case.health_case_type = None

    # Store admission period if provided
    if body.admission_from:
        af = body.admission_from
        case.admission_from = af.replace(tzinfo=None) if af.tzinfo else af
    if body.admission_to:
        at = body.admission_to
        case.admission_to = at.replace(tzinfo=None) if at.tzinfo else at

    db.commit()
    db.refresh(case)

    admission_info = ""
    if body.admission_from and body.admission_to:
        admission_info = f" (admitted {body.admission_from.date()} to {body.admission_to.date()})"

    notify_worker(
        db, current_worker,
        f"Your health issue report has been submitted{admission_info}. Admin will review your document shortly.",
        "health_report_submitted",
    )
    notify_admin(
        db,
        f"Worker {current_worker.name} submitted a health issue report. "
        f"Document: {body.document_filename}{admission_info}",
        "health_report_submitted",
    )

    logger.info("[non_payment] Worker %d reported health issue, doc=%s", current_worker.id, body.document_filename)
    return case


@router.post("/pay-fine", response_model=NonPaymentCaseOut)
def pay_fine(
    db: Session = Depends(get_db),
    current_worker: Worker = Depends(get_current_worker),
):
    """
    Worker pays the ₹10,000 fine for a MAJOR health case.
    Marks fine_paid = True and restores payment_status = ACTIVE.
    """
    case = db.query(NonPaymentCase).filter(NonPaymentCase.worker_id == current_worker.id).first()
    if not case:
        raise HTTPException(status_code=404, detail="No non-payment case found.")
    if case.health_case_type != "MAJOR":
        raise HTTPException(status_code=400, detail="Fine only applies to MAJOR health cases.")
    if case.fine_paid:
        raise HTTPException(status_code=400, detail="Fine has already been paid.")
    if not case.fine_amount:
        raise HTTPException(status_code=400, detail="No fine has been assigned yet.")

    case.fine_paid = True
    case.payment_status = "ACTIVE"
    db.commit()
    db.refresh(case)

    notify_worker(
        db, current_worker,
        f"Your fine of ₹{case.fine_amount:.0f} has been paid. Your account is now active. "
        "You can resume weekly premium payments.",
        "fine_paid",
    )
    notify_admin(
        db,
        f"Worker {current_worker.name} paid the ₹{case.fine_amount:.0f} fine. Account restored.",
        "fine_paid",
    )

    logger.info("[non_payment] Worker %d paid fine ₹%.0f", current_worker.id, case.fine_amount)
    return case


# ── Admin endpoints ───────────────────────────────────────────────────────────

@router.get("/admin/document/{filename}")
def view_document(
    filename: str,
    token: str = None,
    db: Session = Depends(get_db),
):
    """
    Serve an uploaded health document for admin viewing.
    Accepts token as query param so admin can open the file directly in a browser tab.
    """
    from fastapi.responses import FileResponse
    from jose import JWTError, jwt
    from ..config import settings

    if not token:
        raise HTTPException(status_code=401, detail="Token required")

    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        worker_id = int(payload.get("sub"))
    except (JWTError, TypeError, ValueError):
        raise HTTPException(status_code=401, detail="Invalid token")

    worker = db.query(Worker).filter(Worker.id == worker_id, Worker.is_admin == True).first()
    if not worker:
        raise HTTPException(status_code=403, detail="Admin access required")

    # Sanitise — prevent path traversal
    safe_name = os.path.basename(filename)
    file_path = os.path.join(UPLOAD_DIR, safe_name)

    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="Document not found on server")

    ext = os.path.splitext(safe_name)[1].lower()
    media_map = {
        ".pdf":  "application/pdf",
        ".jpg":  "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png":  "image/png",
    }
    media_type = media_map.get(ext, "application/octet-stream")

    return FileResponse(path=file_path, media_type=media_type, filename=safe_name)


@router.get("/admin/pending-health", response_model=list[NonPaymentCaseAdminOut])
def list_pending_health_cases(
    db: Session = Depends(get_db),
    _: Worker = Depends(get_current_admin),
):
    """
    All health cases — any document status — so admin can both review docs
    AND classify cases in the same table.
    """
    cases = db.query(NonPaymentCase).filter(
        NonPaymentCase.non_payment_reason == "HEALTH",
    ).order_by(NonPaymentCase.created_at.asc()).all()

    result = []
    for c in cases:
        worker = db.query(Worker).filter(Worker.id == c.worker_id).first()
        result.append(_to_admin_out(c, worker.name if worker else None))
    return result


@router.get("/admin/blocked", response_model=list[NonPaymentCaseAdminOut])
def list_blocked_workers(
    db: Session = Depends(get_db),
    _: Worker = Depends(get_current_admin),
):
    cases = db.query(NonPaymentCase).filter(
        NonPaymentCase.payment_status == "BLOCKED"
    ).order_by(NonPaymentCase.block_until.asc()).all()
    result = []
    for c in cases:
        worker = db.query(Worker).filter(Worker.id == c.worker_id).first()
        result.append(_to_admin_out(c, worker.name if worker else None))
    return result


@router.get("/admin/all", response_model=list[NonPaymentCaseAdminOut])
def list_all_cases(
    db: Session = Depends(get_db),
    _: Worker = Depends(get_current_admin),
):
    cases = db.query(NonPaymentCase).order_by(NonPaymentCase.updated_at.desc()).all()
    result = []
    for c in cases:
        worker = db.query(Worker).filter(Worker.id == c.worker_id).first()
        result.append(_to_admin_out(c, worker.name if worker else None))
    return result


@router.post("/admin/{case_id}/review-document", response_model=NonPaymentCaseAdminOut)
def review_document(
    case_id: int,
    body: AdminDocumentActionRequest,
    db: Session = Depends(get_db),
    _: Worker = Depends(get_current_admin),
):
    """
    Admin approves or rejects the uploaded health document.
    APPROVE → document_status = APPROVED (admin must then classify)
    REJECT  → document_status = REJECTED, payment_status = ACTIVE (case closed)
    """
    action = body.action.upper()
    if action not in ("APPROVE", "REJECT"):
        raise HTTPException(status_code=400, detail="action must be APPROVE or REJECT")

    case = db.query(NonPaymentCase).filter(NonPaymentCase.id == case_id).first()
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    if case.document_status != "PENDING":
        raise HTTPException(status_code=400, detail=f"Document is already {case.document_status}")

    worker = db.query(Worker).filter(Worker.id == case.worker_id).first()
    case.document_status = action + "D"   # APPROVED or REJECTED
    if body.admin_note:
        case.admin_note = body.admin_note

    if action == "REJECT":
        # Document rejected — close the health case, restore active status
        case.payment_status = "ACTIVE"
        case.non_payment_reason = None
        db.commit()
        db.refresh(case)
        if worker:
            notify_worker(
                db, worker,
                "Your health document has been reviewed and rejected. "
                "Please ensure your premium payments are up to date.",
                "document_rejected",
            )
    else:
        # Document approved — admin must now classify MINOR/MAJOR
        db.commit()
        db.refresh(case)
        if worker:
            notify_worker(
                db, worker,
                "Your health document has been approved. "
                "Admin will classify your case shortly.",
                "document_approved",
            )

    logger.info("[non_payment] Case %d document %s by admin", case_id, action)
    return _to_admin_out(case, worker.name if worker else None)


@router.post("/admin/{case_id}/classify", response_model=NonPaymentCaseAdminOut)
def classify_health_case(
    case_id: int,
    body: AdminClassifyRequest,
    db: Session = Depends(get_db),
    _: Worker = Depends(get_current_admin),
):
    """
    Admin classifies an approved health case as MINOR or MAJOR.

    MINOR → premium_penalty = 10% (applied on recovery), payment_status = PENDING
    MAJOR → fine_amount = ₹10,000, payment requirement paused, payment_status = PENDING
    """
    case_type = body.health_case_type.upper()
    if case_type not in ("MINOR", "MAJOR"):
        raise HTTPException(status_code=400, detail="health_case_type must be MINOR or MAJOR")

    case = db.query(NonPaymentCase).filter(NonPaymentCase.id == case_id).first()
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    if case.document_status != "APPROVED":
        raise HTTPException(status_code=400, detail="Document must be approved before classification")

    worker = db.query(Worker).filter(Worker.id == case.worker_id).first()
    case.health_case_type = case_type
    if body.admin_note:
        case.admin_note = body.admin_note

    if case_type == "MINOR":
        case.premium_penalty = MINOR_PREMIUM_PENALTY
        case.payment_status = "PENDING"
        db.commit()
        db.refresh(case)
        if worker:
            notify_worker(
                db, worker,
                "Your health case has been classified as MINOR. "
                "Once you recover, resume your weekly payments. "
                "A small 10% premium increase will apply going forward.",
                "case_classified_minor",
            )
    else:  # MAJOR
        case.fine_amount = MAJOR_FINE_AMOUNT
        case.payment_status = "PENDING"   # payments paused, fine due within 1 month
        db.commit()
        db.refresh(case)
        if worker:
            notify_worker(
                db, worker,
                f"Your health case has been classified as MAJOR. "
                f"Weekly premium payments are paused. "
                f"A fine of ₹{MAJOR_FINE_AMOUNT:.0f} must be paid within 1 month to restore your account.",
                "case_classified_major",
            )

    logger.info("[non_payment] Case %d classified as %s", case_id, case_type)
    return _to_admin_out(case, worker.name if worker else None)


@router.post("/admin/{worker_id}/block-simple", response_model=NonPaymentCaseAdminOut)
def block_for_simple_non_payment(
    worker_id: int,
    db: Session = Depends(get_db),
    _: Worker = Depends(get_current_admin),
):
    """
    Admin blocks a worker for simple non-payment (no valid reason).
    Sets payment_status = BLOCKED, block_until = now + 6 months.
    """
    worker = db.query(Worker).filter(Worker.id == worker_id).first()
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    case = _get_or_create_case(worker_id, db)

    if case.payment_status == "BLOCKED":
        raise HTTPException(status_code=400, detail="Worker is already blocked")

    case.non_payment_reason = "SIMPLE"
    case.payment_status = "BLOCKED"
    case.block_until = datetime.utcnow() + timedelta(days=30 * BLOCK_DURATION_MONTHS)

    db.commit()
    db.refresh(case)

    notify_worker(
        db, worker,
        "Your account has been blocked due to non-payment without a valid reason. "
        f"You can re-register after {BLOCK_DURATION_MONTHS} months.",
        "account_blocked",
    )
    notify_admin(
        db,
        f"Worker {worker.name} has been blocked for simple non-payment until {case.block_until.date()}.",
        "account_blocked",
    )

    logger.info("[non_payment] Worker %d blocked until %s", worker_id, case.block_until)
    return _to_admin_out(case, worker.name)


@router.post("/admin/{worker_id}/lift-block", response_model=NonPaymentCaseAdminOut)
def lift_block(
    worker_id: int,
    db: Session = Depends(get_db),
    _: Worker = Depends(get_current_admin),
):
    """
    Admin manually lifts a block (e.g. after 6 months or special review).
    Resets payment_status = ACTIVE.
    """
    case = db.query(NonPaymentCase).filter(NonPaymentCase.worker_id == worker_id).first()
    if not case or case.payment_status != "BLOCKED":
        raise HTTPException(status_code=400, detail="Worker is not currently blocked")

    worker = db.query(Worker).filter(Worker.id == worker_id).first()
    case.payment_status = "ACTIVE"
    case.non_payment_reason = None
    case.block_until = None
    db.commit()
    db.refresh(case)

    if worker:
        notify_worker(
            db, worker,
            "Your account block has been lifted. You can now re-register and take a new policy.",
            "block_lifted",
        )

    logger.info("[non_payment] Block lifted for worker %d", worker_id)
    return _to_admin_out(case, worker.name if worker else None)
