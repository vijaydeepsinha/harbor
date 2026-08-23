from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models.station import Station


def search_stations(db: Session, query: str) -> list[Station]:
    like = f"%{query.lower()}%"
    return (
        db.query(Station)
        .filter(or_(Station.code.ilike(like), Station.name.ilike(like), Station.city.ilike(like)))
        .all()
    )


def get_station(db: Session, code: str) -> Station | None:
    return db.get(Station, code.upper())
