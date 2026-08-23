from datetime import date, datetime

from sqlalchemy.orm import Session

from app.errors import NotFoundError, ValidationError
from app.models.train import Train
from app.repositories import availability_repo, station_repo, train_repo


def _weekday_abbr(journey_date: date) -> str:
    return journey_date.strftime("%a").upper()  # MON, TUE, ...


def _fare_map(db: Session, train: Train, journey_date: str) -> dict[str, float]:
    slots = availability_repo.get_all_for_train_date(db, train.id, journey_date)
    fares = {slot.travel_class: slot.fare for slot in slots if not slot.tatkal}
    for cls in train.classes_list():
        fares.setdefault(cls, train.base_fare)
    return fares


def _to_search_result(db: Session, train: Train, journey_date: str) -> dict:
    return {
        "train_number": train.train_number,
        "train_name": train.train_name,
        "source_station": train.source_station,
        "destination_station": train.destination_station,
        "departure_time": train.departure_time,
        "arrival_time": train.arrival_time,
        "duration_minutes": train.duration_minutes,
        "available_classes": train.classes_list(),
        "fare": _fare_map(db, train, journey_date),
        "tatkal_available": train.tatkal_available,
    }


def search_trains(
    db: Session,
    source: str,
    destination: str,
    journey_date: date,
    preferred_departure_after: str | None = None,
    preferred_departure_before: str | None = None,
) -> list[dict]:
    if not station_repo.get_station(db, source):
        raise NotFoundError(f"Station {source} was not found", code="STATION_NOT_FOUND")
    if not station_repo.get_station(db, destination):
        raise NotFoundError(f"Station {destination} was not found", code="STATION_NOT_FOUND")

    weekday = _weekday_abbr(journey_date)
    trains = train_repo.search_trains(db, source, destination)
    trains = [t for t in trains if t.runs_on(weekday)]

    if preferred_departure_after:
        trains = [t for t in trains if t.departure_time >= preferred_departure_after]
    if preferred_departure_before:
        trains = [t for t in trains if t.departure_time <= preferred_departure_before]

    trains.sort(key=lambda t: t.departure_time)
    date_str = journey_date.isoformat()
    return [_to_search_result(db, t, date_str) for t in trains]


def get_train_details(db: Session, train_number: str) -> dict:
    train = train_repo.get_by_number(db, train_number)
    if not train:
        raise NotFoundError(f"Train {train_number} was not found", code="TRAIN_NOT_FOUND")

    return {
        "train_number": train.train_number,
        "train_name": train.train_name,
        "source_station": train.source_station,
        "destination_station": train.destination_station,
        "departure_time": train.departure_time,
        "arrival_time": train.arrival_time,
        "duration_minutes": train.duration_minutes,
        "running_days": train.running_days_list(),
        "classes": train.classes_list(),
        "base_fare": train.base_fare,
        "tatkal_available": train.tatkal_available,
        "route": [
            {"station_code": train.source_station, "station_name": _station_name(db, train.source_station), "role": "SOURCE"},
            {
                "station_code": train.destination_station,
                "station_name": _station_name(db, train.destination_station),
                "role": "DESTINATION",
            },
        ],
    }


def _station_name(db: Session, code: str) -> str:
    station = station_repo.get_station(db, code)
    return station.name if station else code


def require_train(db: Session, train_number: str) -> Train:
    train = train_repo.get_by_number(db, train_number)
    if not train:
        raise NotFoundError(f"Train {train_number} was not found", code="TRAIN_NOT_FOUND")
    return train


def validate_class(train: Train, travel_class: str) -> None:
    if travel_class not in train.classes_list():
        raise ValidationError(
            f"Train {train.train_number} does not offer class {travel_class}", code="INVALID_CLASS"
        )


def validate_route(train: Train, source: str, destination: str) -> None:
    if train.source_station != source.upper() or train.destination_station != destination.upper():
        raise ValidationError(
            f"Train {train.train_number} does not run from {source} to {destination}",
            code="INVALID_ROUTE",
        )


def validate_running_day(train: Train, journey_date: date) -> None:
    if not train.runs_on(_weekday_abbr(journey_date)):
        raise ValidationError(
            f"Train {train.train_number} does not run on {journey_date.isoformat()}",
            code="INVALID_JOURNEY_DATE",
        )


def validate_tatkal_offered(train: Train, tatkal: bool) -> None:
    if tatkal and not train.tatkal_available:
        raise ValidationError(
            f"Train {train.train_number} does not offer Tatkal quota", code="TATKAL_NOT_AVAILABLE"
        )
