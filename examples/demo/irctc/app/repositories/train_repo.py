from sqlalchemy.orm import Session

from app.models.train import Train


def get_by_number(db: Session, train_number: str) -> Train | None:
    return db.query(Train).filter(Train.train_number == train_number).first()


def search_trains(db: Session, source: str, destination: str) -> list[Train]:
    return (
        db.query(Train)
        .filter(Train.source_station == source.upper(), Train.destination_station == destination.upper())
        .all()
    )


def get_by_id(db: Session, train_id: int) -> Train | None:
    return db.get(Train, train_id)
