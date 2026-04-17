from sqlalchemy import Column, Integer, String, Float, Boolean, DateTime, ForeignKey, Enum, Text
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from .database import Base
import enum

class WorkerType(str, enum.Enum):
    food_delivery = "food_delivery"
    ecommerce = "ecommerce"
    grocery = "grocery"

class PolicyStatus(str, enum.Enum):
    active = "active"
    expired = "expired"
    cancelled = "cancelled"

class ClaimStatus(str, enum.Enum):
    pending = "pending"
    approved = "approved"
    rejected = "rejected"
    paid = "paid"

class Worker(Base):
    __tablename__ = "workers"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    email = Column(String, unique=True, index=True, nullable=False)
    phone = Column(String, nullable=False)
    hashed_password = Column(String, nullable=False)
    worker_type = Column(Enum(WorkerType), nullable=False)
    city = Column(String, nullable=False)
    zone = Column(String, nullable=False)          # delivery zone / area
    lat = Column(Float, nullable=False)
    lng = Column(Float, nullable=False)
    avg_daily_income = Column(Float, default=800.0) # INR
    is_active = Column(Boolean, default=True)
    is_admin = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    # ── Velocity fraud tracking ───────────────────────────────────────────────
    last_lat = Column(Float, nullable=True)          # last known GPS latitude
    last_lng = Column(Float, nullable=True)          # last known GPS longitude
    last_activity_at = Column(DateTime(timezone=True), nullable=True)  # UTC
    # ── Live GPS (geofencing) ─────────────────────────────────────────────────
    last_location_update = Column(DateTime(timezone=True), nullable=True)  # UTC
    # ── Hyperlocal zone assignment ────────────────────────────────────────────
    zone_name = Column(String, nullable=True)  # e.g. "Andheri", "Gachibowli"
    # ── Demographics ─────────────────────────────────────────────────────────
    gender = Column(String, nullable=True)     # MALE / FEMALE / OTHER

    policies = relationship("Policy", back_populates="worker")
    claims = relationship("Claim", back_populates="worker")
    notifications = relationship("Notification", back_populates="worker")
    payments = relationship("Payment", back_populates="worker")
    manual_claims = relationship("ManualClaim", back_populates="worker")
    non_payment_case = relationship("NonPaymentCase", back_populates="worker", uselist=False)
    policy_choices = relationship("UserPolicyChoice", back_populates="worker")
    adoption_tracking = relationship("PolicyAdoptionTracking", back_populates="worker", uselist=False)

class Policy(Base):
    __tablename__ = "policies"
    id = Column(Integer, primary_key=True, index=True)
    worker_id = Column(Integer, ForeignKey("workers.id"), nullable=False)
    weekly_premium = Column(Float, nullable=False)   # INR
    coverage_amount = Column(Float, nullable=False)  # INR (max payout per week)
    risk_score = Column(Float, nullable=False)
    status = Column(Enum(PolicyStatus), default=PolicyStatus.active)
    start_date = Column(DateTime(timezone=True), server_default=func.now())
    end_date = Column(DateTime(timezone=True), nullable=False)
    underwriting_start_date = Column(DateTime(timezone=True), nullable=True)  # cover begins after 7-day wait
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    worker = relationship("Worker", back_populates="policies")
    claims = relationship("Claim", back_populates="policy")

class Claim(Base):
    __tablename__ = "claims"
    id = Column(Integer, primary_key=True, index=True)
    worker_id = Column(Integer, ForeignKey("workers.id"), nullable=False)
    policy_id = Column(Integer, ForeignKey("policies.id"), nullable=False)
    trigger_type = Column(String, nullable=False)    # rain / aqi / curfew
    trigger_value = Column(Float, nullable=False)    # actual measured value
    trigger_threshold = Column(Float, nullable=False)
    payout_amount = Column(Float, nullable=False)
    status = Column(Enum(ClaimStatus), default=ClaimStatus.pending)
    fraud_score = Column(Float, default=0.0)         # 0=clean, 1=fraud
    fraud_flags = Column(Text, default="")
    transaction_id = Column(String, nullable=True)   # UPI transaction ID for paid claims
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    approved_at = Column(DateTime(timezone=True), nullable=True)

    worker = relationship("Worker", back_populates="claims")
    policy = relationship("Policy", back_populates="claims")

class DisruptionEvent(Base):
    __tablename__ = "disruption_events"
    id = Column(Integer, primary_key=True, index=True)
    city = Column(String, nullable=False)
    zone = Column(String, nullable=True)
    event_type = Column(String, nullable=False)      # rain / aqi / curfew / flood
    value = Column(Float, nullable=False)
    threshold = Column(Float, nullable=False)
    triggered = Column(Boolean, default=False)
    recorded_at = Column(DateTime(timezone=True), server_default=func.now())

class RiskLog(Base):
    __tablename__ = "risk_logs"
    id = Column(Integer, primary_key=True, index=True)
    city = Column(String, nullable=False)
    zone = Column(String, nullable=True)
    risk_score = Column(Float, nullable=False)
    rain_mm = Column(Float, default=0.0)
    aqi = Column(Float, default=0.0)
    temp_c = Column(Float, default=0.0)
    curfew = Column(Boolean, default=False)
    recorded_at = Column(DateTime(timezone=True), server_default=func.now())


class Notification(Base):
    __tablename__ = "notifications"
    id = Column(Integer, primary_key=True, index=True)
    worker_id = Column(Integer, ForeignKey("workers.id"), nullable=False)
    message = Column(String, nullable=False)
    type = Column(String, nullable=False)
    is_read = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    worker = relationship("Worker", back_populates="notifications")


class GlobalSettings(Base):
    """
    Singleton table — always contains exactly one row (id=1).
    Controls platform-wide kill-switches for Force Majeure events.
    """
    __tablename__ = "global_settings"
    id = Column(Integer, primary_key=True, default=1)
    is_systemic_pause = Column(Boolean, default=False, nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class PaymentStatus(str, enum.Enum):
    paid    = "PAID"
    pending = "PENDING"
    advance = "ADVANCE"


class ManualClaimStatus(str, enum.Enum):
    pending  = "pending"
    approved = "approved"
    rejected = "rejected"
    paid     = "paid"


class ManualClaim(Base):
    """
    Worker-initiated claim requests (manual, not parametric).
    Max ₹1000 per claim. Requires admin approval before payout.
    Separate from the parametric Claim table — no existing logic is touched.
    """
    __tablename__ = "manual_claims"
    id               = Column(Integer, primary_key=True, index=True)
    worker_id        = Column(Integer, ForeignKey("workers.id"), nullable=False)
    requested_amount = Column(Float, nullable=False)          # ≤ 1000
    status           = Column(String, nullable=False, default="pending")  # pending/approved/rejected/paid
    reason           = Column(String, nullable=True)          # optional note from worker
    transaction_id   = Column(String, nullable=True)          # set on payout
    admin_note       = Column(String, nullable=True)          # optional note from admin
    created_at       = Column(DateTime(timezone=True), server_default=func.now())
    updated_at       = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    worker = relationship("Worker", back_populates="manual_claims")


class Payment(Base):
    """
    Tracks weekly premium payments made by workers.
    One row per payment transaction — a worker may have multiple rows
    (one per week paid, including advance weeks).
    """
    __tablename__ = "payments"
    id              = Column(Integer, primary_key=True, index=True)
    worker_id       = Column(Integer, ForeignKey("workers.id"), nullable=False)
    amount          = Column(Float, nullable=False)
    payment_date    = Column(DateTime(timezone=True), nullable=False)   # date chosen by worker
    paid_at         = Column(DateTime(timezone=True), server_default=func.now())  # server timestamp
    status          = Column(String, nullable=False, default="PAID")    # PAID / PENDING / ADVANCE
    is_advance      = Column(Boolean, default=False, nullable=False)
    week_start_date = Column(DateTime(timezone=True), nullable=False)
    week_end_date   = Column(DateTime(timezone=True), nullable=False)

    worker = relationship("Worker", back_populates="payments")


class NonPaymentCase(Base):
    """
    Tracks non-payment events for workers.
    Created when a worker reports a health issue or is blocked for simple non-payment.

    payment_status : ACTIVE | PENDING | BLOCKED
    non_payment_reason : HEALTH | SIMPLE | null
    health_case_type   : MINOR | MAJOR | null  (set by admin after doc review)
    document_status    : PENDING | APPROVED | REJECTED
    fine_amount        : set to 10000 for MAJOR cases
    block_until        : set to now+6months for SIMPLE non-payment
    premium_penalty    : small % increase applied after MINOR recovery (e.g. 0.10 = 10%)
    """
    __tablename__ = "non_payment_cases"
    id                  = Column(Integer, primary_key=True, index=True)
    worker_id           = Column(Integer, ForeignKey("workers.id"), nullable=False, unique=True)
    payment_status      = Column(String, nullable=False, default="ACTIVE")   # ACTIVE/PENDING/BLOCKED
    non_payment_reason  = Column(String, nullable=True)    # HEALTH / SIMPLE
    health_case_type    = Column(String, nullable=True)    # MINOR / MAJOR
    document_uploaded   = Column(Boolean, default=False, nullable=False)
    document_filename   = Column(String, nullable=True)    # stored filename/path
    document_status     = Column(String, nullable=True)    # PENDING / APPROVED / REJECTED
    admission_from      = Column(DateTime(timezone=True), nullable=True)  # hospital admission start
    admission_to        = Column(DateTime(timezone=True), nullable=True)  # hospital admission end
    fine_amount         = Column(Float, nullable=True)     # 10000 for MAJOR
    fine_paid           = Column(Boolean, default=False, nullable=False)
    block_until         = Column(DateTime(timezone=True), nullable=True)
    premium_penalty     = Column(Float, nullable=True)     # e.g. 0.10 for 10% increase
    admin_note          = Column(String, nullable=True)
    created_at          = Column(DateTime(timezone=True), server_default=func.now())
    updated_at          = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    worker = relationship("Worker", back_populates="non_payment_case")


# ── Policy Versioning ─────────────────────────────────────────────────────────

class PolicyTemplate(Base):
    """
    Platform-level policy template published by admin.
    Versioned — only one is active at a time.
    Workers choose whether to adopt the new version or stay on their current one.
    """
    __tablename__ = "policy_templates"
    id                  = Column(Integer, primary_key=True, index=True)
    version             = Column(Integer, nullable=False, unique=True)   # 1, 2, 3 …
    name                = Column(String, nullable=False)
    description         = Column(Text, nullable=True)
    benefits            = Column(Text, nullable=True)    # newline-separated bullet points
    base_premium        = Column(Float, nullable=False)  # base weekly premium (INR)
    premium_multiplier  = Column(Float, nullable=False, default=1.0)  # e.g. 1.07 = +7%
    effective_from      = Column(DateTime(timezone=True), server_default=func.now())
    is_active           = Column(Boolean, default=False, nullable=False)
    previous_policy_id  = Column(Integer, ForeignKey("policy_templates.id"), nullable=True)
    created_at          = Column(DateTime(timezone=True), server_default=func.now())

    choices = relationship("UserPolicyChoice", back_populates="policy_template")


class UserPolicyChoice(Base):
    """
    Records each worker's choice when a new policy version is published.
    choice = NEW  → worker switched to new policy version
    choice = EXISTING → worker stayed on their current policy
    """
    __tablename__ = "user_policy_choices"
    id                  = Column(Integer, primary_key=True, index=True)
    worker_id           = Column(Integer, ForeignKey("workers.id"), nullable=False)
    policy_template_id  = Column(Integer, ForeignKey("policy_templates.id"), nullable=False)
    choice              = Column(String, nullable=False)   # NEW / EXISTING
    chosen_at           = Column(DateTime(timezone=True), server_default=func.now())
    adjusted_premium    = Column(Float, nullable=True)     # premium after multiplier applied

    worker          = relationship("Worker", back_populates="policy_choices")
    policy_template = relationship("PolicyTemplate", back_populates="choices")


class PolicyAdoptionTracking(Base):
    """
    90-day behaviour tracking for workers who switched to a new policy.
    Tracks payment regularity during the adoption window.
    """
    __tablename__ = "policy_adoption_tracking"
    id                  = Column(Integer, primary_key=True, index=True)
    worker_id           = Column(Integer, ForeignKey("workers.id"), nullable=False, unique=True)
    policy_template_id  = Column(Integer, ForeignKey("policy_templates.id"), nullable=False)
    tracking_start      = Column(DateTime(timezone=True), server_default=func.now())
    tracking_end        = Column(DateTime(timezone=True), nullable=False)  # start + 90 days
    is_irregular        = Column(Boolean, default=False, nullable=False)
    irregular_count     = Column(Integer, default=0, nullable=False)   # missed/late weeks
    suggestion_sent     = Column(Boolean, default=False, nullable=False)
    created_at          = Column(DateTime(timezone=True), server_default=func.now())
    updated_at          = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    worker = relationship("Worker", back_populates="adoption_tracking")
