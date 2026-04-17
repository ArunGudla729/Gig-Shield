from pydantic import BaseModel, EmailStr
from typing import Optional, List
from datetime import datetime
from .models import WorkerType, PolicyStatus, ClaimStatus

# ── Auth ──────────────────────────────────────────────────────────────────────
class WorkerRegister(BaseModel):
    name: str
    email: EmailStr
    phone: str
    password: str
    worker_type: WorkerType
    city: str
    zone: str
    lat: float
    lng: float
    avg_daily_income: float = 800.0
    gender: Optional[str] = None    # MALE / FEMALE / OTHER

class WorkerLogin(BaseModel):
    email: EmailStr
    password: str

class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    is_admin: bool = False

# ── Worker ────────────────────────────────────────────────────────────────────
class WorkerOut(BaseModel):
    id: int
    name: str
    email: str
    phone: str
    worker_type: WorkerType
    city: str
    zone: str
    lat: float
    lng: float
    avg_daily_income: float
    is_admin: bool
    gender: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True

# ── Policy ────────────────────────────────────────────────────────────────────
class PolicyCreate(BaseModel):
    pass  # premium is calculated server-side

class PolicyOut(BaseModel):
    id: int
    worker_id: int
    weekly_premium: float
    coverage_amount: float
    risk_score: float
    status: PolicyStatus
    start_date: datetime
    end_date: datetime
    underwriting_start_date: Optional[datetime] = None  # cover begins after 7-day waiting period

    class Config:
        from_attributes = True

# ── Claim ─────────────────────────────────────────────────────────────────────
class ClaimOut(BaseModel):
    id: int
    worker_id: int
    policy_id: int
    trigger_type: str
    trigger_value: float
    trigger_threshold: float
    payout_amount: float
    status: ClaimStatus
    fraud_score: float
    fraud_flags: str
    transaction_id: Optional[str] = None
    created_at: datetime
    approved_at: Optional[datetime]

    class Config:
        from_attributes = True

# ── Risk ──────────────────────────────────────────────────────────────────────
class RiskResponse(BaseModel):
    city: str
    zone: str
    risk_score: float
    rain_mm: float
    aqi: float
    temp_c: float
    curfew: bool
    weekly_premium: float
    coverage_amount: float
    women_benefits_active: bool = False

# ── Disruption ────────────────────────────────────────────────────────────────
class DisruptionEventOut(BaseModel):
    id: int
    city: str
    zone: Optional[str]
    event_type: str
    value: float
    threshold: float
    triggered: bool
    recorded_at: datetime

    class Config:
        from_attributes = True

# ── Admin ─────────────────────────────────────────────────────────────────────
class AdminStats(BaseModel):
    total_workers: int
    total_policies: int
    active_policies: int
    total_claims: int
    approved_claims: int
    total_payout: float
    fraud_alerts: int
    loss_ratio: float

# ── Simulation ────────────────────────────────────────────────────────────────
class SimulationRequest(BaseModel):
    city: str
    zone: str
    event_type: str   # rain / aqi / curfew
    value: float

class SimulationResult(BaseModel):
    event_type: str
    value: float
    threshold: float
    triggered: bool
    affected_workers: int
    total_payout: float
    claims_created: List[ClaimOut]

# ── Notification ──────────────────────────────────────────────────────────────
class NotificationOut(BaseModel):
    id: int
    worker_id: int
    message: str
    type: str
    is_read: bool
    created_at: datetime

    class Config:
        from_attributes = True

# ── Manual Claims (worker-initiated) ─────────────────────────────────────────
class ManualClaimCreate(BaseModel):
    requested_amount: float     # must be ≤ 1000
    reason: Optional[str] = None

class ManualClaimOut(BaseModel):
    id: int
    worker_id: int
    requested_amount: float
    status: str                 # pending / approved / rejected / paid
    reason: Optional[str]
    transaction_id: Optional[str]
    admin_note: Optional[str]
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True

class ManualClaimAdminOut(BaseModel):
    id: int
    worker_id: int
    worker_name: Optional[str]
    requested_amount: float
    status: str
    reason: Optional[str]
    transaction_id: Optional[str]
    admin_note: Optional[str]
    created_at: datetime

# ── Payments ──────────────────────────────────────────────────────────────────
class PaymentCreate(BaseModel):
    amount: float
    payment_date: datetime          # date chosen by worker (ISO string from frontend)

class PaymentOut(BaseModel):
    id: int
    worker_id: int
    amount: float
    payment_date: datetime
    paid_at: datetime
    status: str                     # PAID / PENDING / ADVANCE
    is_advance: bool
    week_start_date: datetime
    week_end_date: datetime

    class Config:
        from_attributes = True

class PaymentStatusOut(BaseModel):
    current_week_status: str        # PAID / PENDING
    total_due: float
    advance_count: int
    advance_total: float
    payments: List[PaymentOut]

class WorkerPaymentSummary(BaseModel):
    worker_id: int
    worker_name: str
    city: str
    current_week_status: str        # PAID / PENDING
    due_amount: float
    advance_count: int
    behaviour: str                  # GOOD / DELAYED / IRREGULAR
    total_paid: float

# ── Non-Payment Cases ─────────────────────────────────────────────────────────
class NonPaymentCaseOut(BaseModel):
    id: int
    worker_id: int
    payment_status: str
    non_payment_reason: Optional[str]
    health_case_type: Optional[str]
    document_uploaded: bool
    document_filename: Optional[str]
    document_status: Optional[str]
    admission_from: Optional[datetime]
    admission_to: Optional[datetime]
    fine_amount: Optional[float]
    fine_paid: bool
    block_until: Optional[datetime]
    premium_penalty: Optional[float]
    admin_note: Optional[str]
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True

class NonPaymentCaseAdminOut(BaseModel):
    id: int
    worker_id: int
    worker_name: Optional[str]
    payment_status: str
    non_payment_reason: Optional[str]
    health_case_type: Optional[str]
    document_uploaded: bool
    document_filename: Optional[str]
    document_status: Optional[str]
    admission_from: Optional[datetime]
    admission_to: Optional[datetime]
    fine_amount: Optional[float]
    fine_paid: bool
    block_until: Optional[datetime]
    premium_penalty: Optional[float]
    admin_note: Optional[str]
    created_at: datetime

class ReportHealthIssueRequest(BaseModel):
    document_filename: str
    admission_from: Optional[datetime] = None
    admission_to: Optional[datetime] = None

class AdminClassifyRequest(BaseModel):
    health_case_type: str           # MINOR or MAJOR
    admin_note: Optional[str] = None

class AdminDocumentActionRequest(BaseModel):
    action: str                     # APPROVE or REJECT
    admin_note: Optional[str] = None

class PayFineRequest(BaseModel):
    pass                            # no body needed — fine amount is fixed

# ── Policy Versioning ─────────────────────────────────────────────────────────
class PolicyTemplateCreate(BaseModel):
    name: str
    description: Optional[str] = None
    benefits: Optional[str] = None          # newline-separated bullet points
    base_premium: float
    premium_multiplier: float = 1.07        # default +7% over current premium

class PolicyTemplateOut(BaseModel):
    id: int
    version: int
    name: str
    description: Optional[str]
    benefits: Optional[str]
    base_premium: float
    premium_multiplier: float
    effective_from: datetime
    is_active: bool
    previous_policy_id: Optional[int]
    created_at: datetime

    class Config:
        from_attributes = True

class UserPolicyChoiceCreate(BaseModel):
    choice: str                             # NEW or EXISTING

class UserPolicyChoiceOut(BaseModel):
    id: int
    worker_id: int
    policy_template_id: int
    choice: str
    chosen_at: datetime
    adjusted_premium: Optional[float]

    class Config:
        from_attributes = True

class PolicyAdoptionOut(BaseModel):
    id: int
    worker_id: int
    policy_template_id: int
    tracking_start: datetime
    tracking_end: datetime
    is_irregular: bool
    irregular_count: int
    suggestion_sent: bool

    class Config:
        from_attributes = True

class PolicyAdoptionAdminOut(BaseModel):
    worker_id: int
    worker_name: Optional[str]
    choice: str
    adjusted_premium: Optional[float]
    is_irregular: bool
    irregular_count: int
    tracking_end: Optional[datetime]

# ── Geofencing ────────────────────────────────────────────────────────────────
class LocationUpdate(BaseModel):
    lat: float
    lng: float

class WorkerLocationOut(BaseModel):
    id: int
    name: str
    city: str
    latitude: float | None = None
    longitude: float | None = None
    last_location_update: datetime | None = None
    status: str | None = None        # INSIDE / OUTSIDE / NO_DATA / UNKNOWN
    distance: float | None = None
    zone_center: list[float] | None = None
    fraud_flag: str | None = None    # "OUT_OF_ZONE" when OUTSIDE, null otherwise
    zone_name: str | None = None     # hyperlocal zone name, null if not assigned
    radius_km: float | None = None   # radius used for the check (1.5 or 5.0)

    class Config:
        from_attributes = True
