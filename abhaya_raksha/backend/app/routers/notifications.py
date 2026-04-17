from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from ..database import get_db
from ..models import Notification, Worker
from ..schemas import NotificationOut
from ..auth import get_current_worker, get_current_admin
from ..services.notification_service import notify_worker

router = APIRouter(
    prefix="/api/notifications",
    tags=["notifications"],
    redirect_slashes=False,  # prevent 307 redirect that strips Authorization header
)


@router.get("", response_model=list[NotificationOut])
@router.get("/", response_model=list[NotificationOut], include_in_schema=False)
def get_notifications(
    db: Session = Depends(get_db),
    current_worker: Worker = Depends(get_current_worker),
):
    """Return all notifications for the authenticated worker, newest first."""
    return (
        db.query(Notification)
        .filter(Notification.worker_id == current_worker.id)
        .order_by(Notification.created_at.desc())
        .all()
    )


@router.post("/read/{notification_id}", response_model=NotificationOut)
def mark_read(
    notification_id: int,
    db: Session = Depends(get_db),
    current_worker: Worker = Depends(get_current_worker),
):
    """Mark a notification as read. Returns 404 if not found or not owned by caller."""
    notification = db.query(Notification).filter(
        Notification.id == notification_id,
        Notification.worker_id == current_worker.id,
    ).first()
    if not notification:
        raise HTTPException(status_code=404, detail="Notification not found")
    notification.is_read = True
    db.commit()
    db.refresh(notification)
    return notification


@router.post("/read-all")
def mark_all_read(
    db: Session = Depends(get_db),
    current_worker: Worker = Depends(get_current_worker),
):
    """Mark all unread notifications as read for the authenticated worker."""
    db.query(Notification).filter(
        Notification.worker_id == current_worker.id,
        Notification.is_read == False,
    ).update({"is_read": True})
    db.commit()
    return {"message": "All notifications marked as read"}


@router.post("/test")
def create_test_notifications(
    db: Session = Depends(get_db),
    _admin: Worker = Depends(get_current_admin),
):
    """
    Admin-only: seed demo notifications for every non-admin worker so the
    notification bell can be demonstrated end-to-end without waiting for a
    real parametric event.
    """
    workers = db.query(Worker).filter(Worker.is_admin == False).all()
    if not workers:
        raise HTTPException(status_code=404, detail="No workers found to notify")

    demo_messages = [
        ("ALERT",  "⚠️ Heavy rain expected in your area in 2 hours. Consider adjusting your shift."),
        ("CLAIM",  "🌧️ Rain detected (42 mm). A ₹150 parametric claim has been initiated for you."),
        ("PAYOUT", "✅ ₹150 has been credited to your account. Stay safe!"),
    ]

    for worker in workers:
        for ntype, message in demo_messages:
            notify_worker(db, worker, message, ntype)

    return {"status": "success", "message": "Test notifications created"}
