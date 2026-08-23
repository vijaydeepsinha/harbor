from datetime import date

from sqlalchemy.orm import Session

from app.errors import NotFoundError
from app.repositories import availability_repo
from app.services.train_service import require_train, validate_class


def check_availability(db: Session, train_number: str, journey_date: date, travel_class: str, tatkal: bool) -> dict:
    train = require_train(db, train_number)
    validate_class(train, travel_class)

    date_str = journey_date.isoformat()
    slot = availability_repo.get_slot(db, train.id, date_str, travel_class, tatkal)
    if not slot:
        raise NotFoundError(
            f"No availability found for train {train_number} on {date_str} class {travel_class} (tatkal={tatkal})",
            code="AVAILABILITY_NOT_FOUND",
        )

    return {
        "train_number": train.train_number,
        "date": date_str,
        "travel_class": travel_class,
        "tatkal": tatkal,
        "available_seats": slot.available_seats,
        "total_seats": slot.total_seats,
        "fare": slot.fare,
    }
