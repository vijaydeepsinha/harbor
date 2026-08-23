import random
from datetime import date

from sqlalchemy.orm import Session

from app.errors import ConflictError, NotFoundError, ValidationError
from app.models.booking import Booking, BookingPassenger
from app.repositories import availability_repo, booking_repo, station_repo
from app.schemas.booking import CreateBookingRequest
from app.services.fare_service import compute_fare_for_slot
from app.services.train_service import (
    require_train,
    validate_class,
    validate_route,
    validate_running_day,
    validate_tatkal_offered,
)

CANCEL_REFUND_RATE = 0.75  # 75% of fare refunded on cancellation


def _generate_pnr(db: Session) -> str:
    while True:
        pnr = "".join(random.choices("0123456789", k=10))
        if not booking_repo.pnr_exists(db, pnr):
            return pnr


def _booking_to_dict(booking: Booking, train_number: str, train_name: str) -> dict:
    return {
        "pnr": booking.pnr,
        "train_number": train_number,
        "train_name": train_name,
        "journey_date": booking.journey_date,
        "source": booking.source,
        "destination": booking.destination,
        "travel_class": booking.travel_class,
        "tatkal": booking.tatkal,
        "passengers": booking.passengers,
        "total_fare": booking.total_fare,
        "status": booking.status,
        "created_at": booking.created_at,
    }


def create_booking(db: Session, request: CreateBookingRequest) -> dict:
    train = require_train(db, request.train_number)

    if not station_repo.get_station(db, request.from_):
        raise NotFoundError(f"Station {request.from_} was not found", code="STATION_NOT_FOUND")
    if not station_repo.get_station(db, request.to):
        raise NotFoundError(f"Station {request.to} was not found", code="STATION_NOT_FOUND")

    validate_route(train, request.from_, request.to)
    validate_running_day(train, request.journey_date)
    validate_class(train, request.travel_class.value)
    validate_tatkal_offered(train, request.tatkal)

    date_str = request.journey_date.isoformat()
    slot = availability_repo.get_slot(db, train.id, date_str, request.travel_class.value, request.tatkal)
    if not slot:
        raise NotFoundError(
            f"No availability found for train {request.train_number} on {date_str} "
            f"class {request.travel_class.value} (tatkal={request.tatkal})",
            code="AVAILABILITY_NOT_FOUND",
        )

    passenger_count = len(request.passengers)
    if slot.available_seats < passenger_count:
        raise ConflictError(
            f"Only {slot.available_seats} seat(s) available, requested {passenger_count}",
            code="INSUFFICIENT_SEATS",
        )

    fare_breakdown = compute_fare_for_slot(slot.fare, passenger_count, request.tatkal)

    pnr = _generate_pnr(db)
    booking = Booking(
        pnr=pnr,
        train_id=train.id,
        journey_date=date_str,
        source=request.from_,
        destination=request.to,
        travel_class=request.travel_class.value,
        tatkal=request.tatkal,
        total_fare=fare_breakdown["total_fare"],
        status="CONFIRMED",
    )
    booking.passengers = [
        BookingPassenger(
            name=p.name,
            age=p.age,
            gender=p.gender.value,
            id_type=p.id_type,
            id_number=p.id_number,
        )
        for p in request.passengers
    ]

    slot.available_seats -= passenger_count

    db.add(booking)
    db.commit()
    db.refresh(booking)

    return _booking_to_dict(booking, train.train_number, train.train_name)


def get_booking(db: Session, pnr: str) -> dict:
    booking = booking_repo.get_by_pnr(db, pnr)
    if not booking:
        raise NotFoundError(f"Booking {pnr} was not found", code="BOOKING_NOT_FOUND")
    train = require_train(db, _train_number_for(db, booking.train_id))
    return _booking_to_dict(booking, train.train_number, train.train_name)


def _train_number_for(db: Session, train_id: int) -> str:
    from app.repositories import train_repo

    train = train_repo.get_by_id(db, train_id)
    if not train:
        raise NotFoundError(f"Train with id {train_id} was not found", code="TRAIN_NOT_FOUND")
    return train.train_number


def cancel_booking(db: Session, pnr: str) -> dict:
    booking = booking_repo.get_by_pnr(db, pnr)
    if not booking:
        raise NotFoundError(f"Booking {pnr} was not found", code="BOOKING_NOT_FOUND")
    if booking.status == "CANCELLED":
        raise ValidationError(f"Booking {pnr} is already cancelled", code="ALREADY_CANCELLED")

    slot = availability_repo.get_slot(db, booking.train_id, booking.journey_date, booking.travel_class, booking.tatkal)
    passenger_count = len(booking.passengers)
    if slot:
        slot.available_seats = min(slot.total_seats, slot.available_seats + passenger_count)

    booking.status = "CANCELLED"
    refund_amount = round(booking.total_fare * CANCEL_REFUND_RATE, 2)

    db.commit()

    return {
        "pnr": booking.pnr,
        "status": booking.status,
        "refund_amount": refund_amount,
        "message": f"Booking {pnr} has been cancelled. Refund of {refund_amount} initiated.",
    }
