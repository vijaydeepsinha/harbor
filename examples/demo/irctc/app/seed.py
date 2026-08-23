"""Seed and reset reference data for the IRCTC service: stations, trains, and
seat availability.
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
# Every route runs in both directions, each with its own train number (e.g. an "up"
# train 12301 and a "down" train 12302 for the same route).
TRAINS = [
    ("12301", "Rajdhani Express", "NDLS", "HWH", "16:55", "10:05", 1030, "DAILY", "3A,2A,1A", 2500.0, True),
    ("12302", "Rajdhani Express", "HWH", "NDLS", "16:50", "10:00", 1030, "DAILY", "3A,2A,1A", 2500.0, True),
    ("12423", "Dibrugarh Rajdhani", "NDLS", "HWH", "11:05", "13:10", 1565, "DAILY", "3A,2A,1A", 2800.0, True),
    ("12424", "Dibrugarh Rajdhani", "HWH", "NDLS", "11:00", "13:00", 1560, "DAILY", "3A,2A,1A", 2800.0, True),
    ("12801", "Purushottam Express", "NDLS", "HWH", "14:35", "20:20", 1665, "DAILY", "SL,3A,2A", 1400.0, False),
    ("12802", "Purushottam Express", "HWH", "NDLS", "14:30", "20:15", 1665, "DAILY", "SL,3A,2A", 1400.0, False),
    ("12418", "Prayagraj Express", "NDLS", "PRYJ", "21:15", "06:40", 565, "DAILY", "SL,3A,2A,1A", 1200.0, True),
    ("12417", "Prayagraj Express", "PRYJ", "NDLS", "21:00", "06:15", 555, "DAILY", "SL,3A,2A,1A", 1200.0, True),
    ("12951", "Mumbai Rajdhani", "NDLS", "BCT", "16:25", "08:15", 950, "DAILY", "3A,2A,1A", 2600.0, True),
    ("12952", "Mumbai Rajdhani", "BCT", "NDLS", "17:00", "08:35", 935, "DAILY", "3A,2A,1A", 2600.0, True),
    ("12402", "Prayagraj Duronto", "NDLS", "PRYJ", "20:30", "05:10", 520, "DAILY", "SL,3A,2A", 900.0, False),
    ("12401", "Prayagraj Duronto", "PRYJ", "NDLS", "20:00", "04:40", 520, "DAILY", "SL,3A,2A", 900.0, False),
    ("12448", "UP Sampark Kranti", "NDLS", "PRYJ", "22:15", "07:00", 525, "DAILY", "SL,3A", 700.0, True),
    ("12447", "UP Sampark Kranti", "PRYJ", "NDLS", "22:00", "06:45", 525, "DAILY", "SL,3A", 700.0, True),
]

# Class fare multipliers relative to a train's base_fare (SL cheapest, 1A priciest).
CLASS_FARE_MULTIPLIER = {"SL": 0.4, "3A": 1.0, "2A": 1.5, "1A": 2.2}

CLASS_TOTAL_SEATS = {"SL": 500, "3A": 300, "2A": 150, "1A": 50}
CLASS_TOTAL_SEATS_TATKAL = {"SL": 50, "3A": 30, "2A": 15, "1A": 5}

# Fixed 2-or-4-seat caps for trains running with limited capacity.
SCARCE_AVAILABLE = {"SL": 4, "3A": 2, "2A": 4, "1A": 2}
SCARCE_AVAILABLE_TATKAL = {"SL": 2, "3A": 2, "2A": 2, "1A": 2}

# Every train is deterministically assigned one capacity profile, applied across
# every date and class it runs. This produces a realistic mix: most trains have
# healthy availability, some run with only a few seats left, and some are fully
# booked out (0 available — booking correctly returns 409 INSUFFICIENT_SEATS).
TRAIN_CAPACITY_PROFILE = {
    "12418": "healthy",    # Prayagraj Express (NDLS->PRYJ)
    "12417": "healthy",    # Prayagraj Express (PRYJ->NDLS)
    "12402": "healthy",    # Prayagraj Duronto (NDLS->PRYJ)
    "12401": "healthy",    # Prayagraj Duronto (PRYJ->NDLS)
    "12301": "healthy",    # Rajdhani Express (NDLS->HWH)
    "12302": "healthy",    # Rajdhani Express (HWH->NDLS)
    "12423": "scarce",     # Dibrugarh Rajdhani (NDLS->HWH)
    "12424": "scarce",     # Dibrugarh Rajdhani (HWH->NDLS)
    "12448": "scarce",     # UP Sampark Kranti (NDLS->PRYJ)
    "12447": "scarce",     # UP Sampark Kranti (PRYJ->NDLS)
    "12801": "sold_out",   # Purushottam Express (NDLS->HWH)
    "12802": "sold_out",   # Purushottam Express (HWH->NDLS)
    "12951": "sold_out",   # Mumbai Rajdhani (NDLS->BCT)
    "12952": "sold_out",   # Mumbai Rajdhani (BCT->NDLS)
}

# Rolling window anchored on "today" so the booking horizon is always current,
# rather than a fixed calendar window that goes stale.
BOOKING_WINDOW_DAYS = 30


def _booking_window_dates() -> list[str]:
    start = date.today()
    return [(start + timedelta(days=i)).isoformat() for i in range(BOOKING_WINDOW_DAYS)]


def _capacity_for(train_number: str, travel_class: str, tatkal: bool) -> tuple[int, int]:
    """Return (total_seats, available_seats) for a train/class/tatkal slot."""
    total = (CLASS_TOTAL_SEATS_TATKAL if tatkal else CLASS_TOTAL_SEATS)[travel_class]
    profile = TRAIN_CAPACITY_PROFILE.get(train_number, "healthy")

    if profile == "healthy":
        return total, total
    if profile == "scarce":
        available = (SCARCE_AVAILABLE_TATKAL if tatkal else SCARCE_AVAILABLE)[travel_class]
        return total, min(available, total)
    if profile == "sold_out":
        return total, 0
    return total, total


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
    dates = _booking_window_dates()
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
                    total, available = _capacity_for(train.train_number, travel_class, tatkal=False)
                    db.add(
                        Availability(
                            train_id=train.id,
                            journey_date=journey_date,
                            travel_class=travel_class,
                            tatkal=False,
                            total_seats=total,
                            available_seats=available,
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
                        total_tatkal, available_tatkal = _capacity_for(
                            train.train_number, travel_class, tatkal=True
                        )
                        db.add(
                            Availability(
                                train_id=train.id,
                                journey_date=journey_date,
                                travel_class=travel_class,
                                tatkal=True,
                                total_seats=total_tatkal,
                                available_seats=available_tatkal,
                                fare=fare,
                            )
                        )
    db.commit()


def seed_all(db: Session) -> None:
    seed_stations(db)
    trains = seed_trains(db)
    seed_availability(db, trains)


def reset_demo_data(db: Session) -> None:
    """Delete all bookings and restore every availability record to its initial state."""
    db.query(BookingPassenger).delete()
    db.query(Booking).delete()
    db.query(Availability).delete()
    db.commit()

    trains = db.query(Train).all()
    seed_availability(db, trains)
