from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.seed import reset_demo_data

router = APIRouter(tags=["Demo & Health"])


@router.get("/health", operation_id="healthCheck", summary="Health check")
def health():
    return {"status": "ok"}


@router.post(
    "/demo/reset",
    operation_id="resetDemoData",
    summary="Reset demo data",
    description="Delete all demo bookings and restore seeded availability. Useful between live demo runs.",
)
def reset_demo(db: Session = Depends(get_db)):
    reset_demo_data(db)
    return {"status": "reset", "message": "Demo railway data has been restored"}
