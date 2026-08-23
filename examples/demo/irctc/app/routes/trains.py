from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.schemas.common import ErrorResponse
from app.schemas.train import TrainDetail, TrainSearchResponse
from app.services import train_service

router = APIRouter(tags=["Trains"])


@router.get(
    "/trains/search",
    operation_id="searchTrains",
    summary="Search trains between two stations",
    description="Search trains running between a source and destination station on a given date, "
    "optionally filtered by preferred departure time window.",
    response_model=TrainSearchResponse,
    responses={404: {"model": ErrorResponse, "description": "Station not found"}},
)
def search_trains(
    from_: str = Query(..., alias="from", description="Source station code", examples=["NDLS"]),
    to: str = Query(..., description="Destination station code", examples=["PRYJ"]),
    date_: date = Query(..., alias="date", description="Journey date (YYYY-MM-DD)"),
    preferred_departure_after: str | None = Query(
        None, description="Only include trains departing at/after this time (HH:MM)", examples=["20:00"]
    ),
    preferred_departure_before: str | None = Query(
        None, description="Only include trains departing at/before this time (HH:MM)", examples=["23:59"]
    ),
    db: Session = Depends(get_db),
):
    results = train_service.search_trains(
        db, from_, to, date_, preferred_departure_after, preferred_departure_before
    )
    return {"count": len(results), "results": results}


@router.get(
    "/trains/{train_number}",
    operation_id="getTrainDetails",
    summary="Get train details",
    description="Get full details for a train including route, schedule, running days, classes and fares.",
    response_model=TrainDetail,
    responses={404: {"model": ErrorResponse, "description": "Train not found"}},
)
def get_train_details(train_number: str, db: Session = Depends(get_db)):
    return train_service.get_train_details(db, train_number)
