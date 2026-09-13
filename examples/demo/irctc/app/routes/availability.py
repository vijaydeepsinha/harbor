from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.schemas.availability import AvailabilityOut, FareBreakdown
from app.schemas.common import ErrorResponse, TravelClass
from app.services import availability_service, fare_service

router = APIRouter(tags=["Availability & Fare"])


@router.get(
    "/availability",
    operation_id="checkAvailability",
    summary="Check seat availability",
    description="Check seat availability for a train, date, and travel class. Read-only; does not modify seats.",
    response_model=AvailabilityOut,
    responses={
        404: {"model": ErrorResponse, "description": "Train or availability not found"},
        400: {"model": ErrorResponse, "description": "Invalid travel class"},
    },
)
def check_availability(
    train_number: str = Query(..., description="Train number", examples=["12418"]),
    date_: date = Query(..., alias="date", description="Journey date (YYYY-MM-DD)"),
    travel_class: TravelClass = Query(..., description="Travel class"),
    tatkal: bool = Query(False, description="Whether to check Tatkal quota"),
    db: Session = Depends(get_db),
):
    return availability_service.check_availability(db, train_number, date_, travel_class.value, tatkal)


@router.get(
    "/fare",
    operation_id="calculateFare",
    summary="Calculate fare",
    description="Calculate the fare breakdown (base fare, Tatkal surcharge, total) for a booking scenario.",
    response_model=FareBreakdown,
    responses={
        404: {"model": ErrorResponse, "description": "Train or availability not found"},
        400: {"model": ErrorResponse, "description": "Invalid travel class"},
    },
)
def calculate_fare(
    train_number: str = Query(..., description="Train number", examples=["12418"]),
    date_: date = Query(..., alias="date", description="Journey date (YYYY-MM-DD)"),
    travel_class: TravelClass = Query(..., description="Travel class"),
    passenger_count: int = Query(..., ge=1, le=6, description="Number of passengers"),
    tatkal: bool = Query(False, description="Whether this is a Tatkal fare calculation"),
    db: Session = Depends(get_db),
):
    return fare_service.calculate_fare(db, train_number, date_, travel_class.value, passenger_count, tatkal)
