"""Seed and reset demo data for the simulated IRCTC service.

All data here is fictional and created purely for demonstrating the Harbor MCP
gateway. It does not reflect real IRCTC schedules, fares, or policies.
"""
from datetime import date, timedelta

from sqlalchemy.orm import Session

from app.models.availability import Availability
from app.models.booking import Booking, BookingPassenger
from app.models.station import Station
from app.models.train import Train

STATIONS = [
    ("NDLS", "New Delhi", "New Delhi"),
    ("PRYJ", "Prayagraj Junction", "Prayagraj"),
    ("LKO", "Lucknow", "Lucknow"),
    ("BSB", "Varanasi Junction", "Varanasi"),
    ("CNB", "Kanpur Central", "Kanpur"),
    ("BCT", "Mumbai Central", "Mumbai"),
    ("HWH", "Howrah Junction", "Kolkata"),
]

# (train_number, name, source, destination, departure, arrival, duration_min, running_days, classes, base_fare, tatkal)
TRAINS = [
    ("12301", "Rajdhani Express", "NDLS", "HWH", "16:55", "10:05", 1030, "DAILY", "3A,2A,1A", 2500.0, True),
    ("12423", "Dibrugarh Rajdhani", "NDLS", "HWH", "11:05", "13:10", 1565, "DAILY", "3A,2A,1A", 2800.0, True),
    ("12801", "Purushottam Express", "NDLS", "HWH", "14:35", "20:20", 1665, "DAILY", "SL,3A,2A", 1400.0, False),
    ("12418", "Prayagraj Express", "NDLS", "PRYJ", "21:15", "06:40", 565, "DAILY", "SL,3A,2A,1A", 1200.0, True),
    ("12951", "Mumbai Rajdhani", "NDLS", "BCT", "16:25", "08:15", 950, "DAILY", "3A,2A,1A", 2600.0, True),
    ("12402", "Prayagraj Duronto", "NDLS", "PRYJ", "20:30", "05:10", 520, "DAILY", "SL,3A,2A", 900.0, False),
    ("12448", "UP Sampark Kranti", "NDLS", "PRYJ", "22:15", "07:00", 525, "DAILY", "SL,3A", 700.0, True),
]

# Class fare multipliers relative to a train's base_fare (SL cheapest, 1A priciest).
CLASS_FARE_MULTIPLIER = {"SL": 0.4, "3A": 1.0, "2A": 1.5, "1A": 2.2}

CLASS_TOTAL_SEATS = {"SL": 500, "3A": 300, "2A": 150, "1A": 50}
CLASS_TOTAL_SEATS_TATKAL = {"SL": 50, "3A": 30, "2A": 15, "1A": 5}

# Fixed demo window (covers the dates used throughout Requirements.md examples).
DEMO_START_DATE = date(2026, 9, 1)
DEMO_WINDOW_DAYS = 21


def _demo_dates() -> list[str]:
    return [(DEMO_START_DATE + timedelta(days=i)).isoformat() for i in range(DEMO_WINDOW_DAYS)]


def seed_stations(db: Session) -> None:
    for code, name, city in STATIONS:
        if not db.get(Station, code):
            db.add(Station(code=code, name=name, city=city))
    db.commit()


def seed_trains(db: Session) -> list[Train]:
    trains = []
    for (
        number,
        name,
        source,
        destination,
        departure,
        arrival,
        duration,
        running_days,
        classes,
        base_fare,
        tatkal,
    ) in TRAINS:
        train = db.query(Train).filter(Train.train_number == number).first()
        if not train:
            train = Train(
                train_number=number,
                train_name=name,
                source_station=source,
                destination_station=destination,
                departure_time=departure,
                arrival_time=arrival,
                duration_minutes=duration,
                running_days=running_days,
                classes=classes,
                base_fare=base_fare,
                tatkal_available=tatkal,
            )
            db.add(train)
            db.flush()
        trains.append(train)
    db.commit()
    return trains


def seed_availability(db: Session, trains: list[Train]) -> None:
    dates = _demo_dates()
    for train in trains:
        for journey_date in dates:
            for travel_class in train.classes_list():
                fare = round(train.base_fare * CLASS_FARE_MULTIPLIER[travel_class], 2)

                existing = (
                    db.query(Availability)
                    .filter(
                        Availability.train_id == train.id,
                        Availability.journey_date == journey_date,
                        Availability.travel_class == travel_class,
                        Availability.tatkal.is_(False),
                    )
                    .first()
                )
                if not existing:
                    total = CLASS_TOTAL_SEATS[travel_class]
                    db.add(
                        Availability(
                            train_id=train.id,
                            journey_date=journey_date,
                            travel_class=travel_class,
                            tatkal=False,
                            total_seats=total,
                            available_seats=total,
                            fare=fare,
                        )
                    )

                if train.tatkal_available:
                    existing_tatkal = (
                        db.query(Availability)
                        .filter(
                            Availability.train_id == train.id,
                            Availability.journey_date == journey_date,
                            Availability.travel_class == travel_class,
                            Availability.tatkal.is_(True),
                        )
                        .first()
                    )
                    if not existing_tatkal:
                        total_tatkal = CLASS_TOTAL_SEATS_TATKAL[travel_class]
                        db.add(
                            Availability(
                                train_id=train.id,
                                journey_date=journey_date,
                                travel_class=travel_class,
                                tatkal=True,
                                total_seats=total_tatkal,
                                available_seats=total_tatkal,
                                fare=fare,
                            )
                        )
    db.commit()


def seed_all(db: Session) -> None:
    seed_stations(db)
    trains = seed_trains(db)
    seed_availability(db, trains)


def reset_demo_data(db: Session) -> None:
    """Delete all demo bookings and restore seeded availability to full capacity."""
    db.query(BookingPassenger).delete()
    db.query(Booking).delete()
    db.query(Availability).delete()
    db.commit()

    trains = db.query(Train).all()
    seed_availability(db, trains)
