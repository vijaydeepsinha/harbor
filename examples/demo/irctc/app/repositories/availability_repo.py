from sqlalchemy.orm import Session

from app.models.availability import Availability


def get_slot(
    db: Session, train_id: int, journey_date: str, travel_class: str, tatkal: bool
) -> Availability | None:
    return (
        db.query(Availability)
        .filter(
            Availability.train_id == train_id,
            Availability.journey_date == journey_date,
            Availability.travel_class == travel_class,
            Availability.tatkal == tatkal,
        )
        .first()
    )


def get_all_for_train_date(db: Session, train_id: int, journey_date: str) -> list[Availability]:
    return (
        db.query(Availability)
        .filter(Availability.train_id == train_id, Availability.journey_date == journey_date)
        .all()
    )
