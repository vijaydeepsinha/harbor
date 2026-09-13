from datetime import date, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.seed import BOOKING_WINDOW_DAYS, reset_demo_data

router = APIRouter(tags=["Health & Maintenance"])


@router.get(
    "/health",
    operation_id="healthCheck",
    summary="Health check",
    description=(
        "Returns service status plus the server's current date and the valid "
        "journey_date booking window. Call this first if unsure what 'today' is — "
        "do not guess or assume a year/date for journey_date."
    ),
)
def health():
    today = date.today()
    window_end = today + timedelta(days=BOOKING_WINDOW_DAYS - 1)
    return {
        "status": "ok",
        "today": today.isoformat(),
        "booking_window": {"from": today.isoformat(), "to": window_end.isoformat()},
    }


@router.post(
    "/demo/reset",
    operation_id="resetDemoData",
    summary="Reset booking data",
    description="Removes all bookings and restores every availability record to its initial state.",
)
def reset_demo(db: Session = Depends(get_db)):
    reset_demo_data(db)
    return {"status": "reset", "message": "Booking data has been restored"}
