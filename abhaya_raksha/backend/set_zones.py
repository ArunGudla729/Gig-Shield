from sqlalchemy.orm import Session
from app.database import SessionLocal
from app.models import Worker

db: Session = SessionLocal()

updates = {
    "bhargav@demo.com": "Gachibowli",
    "ravi@demo.com": "Andheri",
    "anjali@demo.com": "Whitefield",
    "meena@demo.com": "T Nagar",
}

for email, zone in updates.items():
    worker = db.query(Worker).filter(Worker.email == email).first()
    if worker:
        worker.zone_name = zone
        print(f"Updated {email} → {zone}")
    else:
        print(f"Worker not found: {email}")

db.commit()
db.close()

print("✅ Zone assignment complete")