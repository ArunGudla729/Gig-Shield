import logging
from sqlalchemy.orm import Session
from ..models import Notification, Worker

logger = logging.getLogger(__name__)


def create_notification(db: Session, worker_id: int, message: str, type: str) -> Notification:
    """Persist a notification to the DB. DB exceptions propagate to caller."""
    notification = Notification(worker_id=worker_id, message=message, type=type)
    db.add(notification)
    db.commit()
    db.refresh(notification)
    return notification


def notify_worker(db: Session, worker: Worker, message: str, type: str) -> Notification:
    """Create and store an in-app notification for a worker."""
    return create_notification(db, worker.id, message, type)


def notify_admin(db: Session, message: str, type: str) -> list[Notification]:
    """Create in-app notifications for all admin workers."""
    admins = db.query(Worker).filter(Worker.is_admin == True).all()
    notifications = []
    for admin in admins:
        n = create_notification(db, admin.id, message, type)
        notifications.append(n)
    return notifications
