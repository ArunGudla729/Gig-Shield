"""
Payment Service — Razorpay Orders API Integration
Generates real transaction IDs using Razorpay Test Mode.
Uses Orders API (not Payouts) — no actual money movement, just ID generation.
"""
import logging
from fastapi import HTTPException

logger = logging.getLogger(__name__)


def create_razorpay_order(amount_inr: float, reference_id: str) -> dict:
    """
    Create a Razorpay order and return the order_id.
    This is used ONLY for generating a real transaction ID — no payment capture.

    Args:
        amount_inr: Amount in INR (will be converted to paise)
        reference_id: Unique reference (e.g. "claim_7" or "manual_claim_3")

    Returns:
        {"order_id": "order_XXXXXXXXXX", "status": "created"}

    Raises:
        HTTPException(502) if Razorpay API fails
    """
    from ..config import settings

    # If keys are not configured, fall back to mock ID (for local dev without Razorpay account)
    if not settings.RAZORPAY_KEY_ID or not settings.RAZORPAY_KEY_SECRET:
        logger.warning("[payment_service] Razorpay keys not configured — using mock order ID")
        import random
        import string
        mock_id = 'order_' + ''.join(random.choices(string.ascii_uppercase + string.digits, k=14))
        return {"order_id": mock_id, "status": "created"}

    try:
        import razorpay
        client = razorpay.Client(auth=(settings.RAZORPAY_KEY_ID, settings.RAZORPAY_KEY_SECRET))

        # Amount must be in paise (₹ × 100)
        amount_paise = int(amount_inr * 100)

        order_data = {
            "amount": amount_paise,
            "currency": "INR",
            "receipt": reference_id,
            "payment_capture": 1,  # auto-capture (not used, but required by API)
        }

        response = client.order.create(data=order_data)
        order_id = response["id"]
        status = response.get("status", "created")

        logger.info("[payment_service] Razorpay order created: %s for ₹%.2f", order_id, amount_inr)
        return {"order_id": order_id, "status": status}

    except ImportError:
        logger.error("[payment_service] razorpay SDK not installed — run: pip install razorpay")
        raise HTTPException(
            status_code=502,
            detail="Payment gateway SDK not available. Contact admin."
        )
    except Exception as exc:
        logger.error("[payment_service] Razorpay order creation failed: %s", exc)
        raise HTTPException(
            status_code=502,
            detail=f"Payment gateway error: {str(exc)}"
        )
