from sqlalchemy.orm import Session, joinedload

from app.models.booking import Booking


def get_by_pnr(db: Session, pnr: str) -> Booking | None:
    return (
        db.query(Booking)
        .options(joinedload(Booking.passengers))
        .filter(Booking.pnr == pnr)
        .first()
    )


def pnr_exists(db: Session, pnr: str) -> bool:
    return db.get(Booking, pnr) is not None
