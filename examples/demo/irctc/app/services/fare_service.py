from datetime import date

from sqlalchemy.orm import Session

from app.config import TATKAL_SURCHARGE_RATE
from app.errors import NotFoundError
from app.repositories import availability_repo
from app.services.train_service import require_train, validate_class


def compute_fare_for_slot(base_fare_per_passenger: float, passenger_count: int, tatkal: bool) -> dict:
    surcharge_per_passenger = round(base_fare_per_passenger * TATKAL_SURCHARGE_RATE, 2) if tatkal else 0.0
    total = round((base_fare_per_passenger + surcharge_per_passenger) * passenger_count, 2)
    return {
        "base_fare_per_passenger": base_fare_per_passenger,
        "tatkal_surcharge_per_passenger": surcharge_per_passenger,
        "total_fare": total,
    }


def calculate_fare(
    db: Session, train_number: str, journey_date: date, travel_class: str, passenger_count: int, tatkal: bool
) -> dict:
    train = require_train(db, train_number)
    validate_class(train, travel_class)

    date_str = journey_date.isoformat()
    slot = availability_repo.get_slot(db, train.id, date_str, travel_class, tatkal)
    if not slot:
        raise NotFoundError(
            f"No fare information found for train {train_number} on {date_str} class {travel_class} (tatkal={tatkal})",
            code="AVAILABILITY_NOT_FOUND",
        )

    breakdown = compute_fare_for_slot(slot.fare, passenger_count, tatkal)
    return {
        "train_number": train.train_number,
        "date": date_str,
        "travel_class": travel_class,
        "passenger_count": passenger_count,
        "tatkal": tatkal,
        **breakdown,
    }
