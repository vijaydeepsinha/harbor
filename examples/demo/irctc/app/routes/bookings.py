from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.schemas.booking import BookingOut, CancellationOut, CreateBookingRequest
from app.schemas.common import ErrorResponse
from app.services import booking_service

router = APIRouter(tags=["Bookings"])


@router.post(
    "/bookings",
    operation_id="createBooking",
    summary="Create a booking",
    description="Create a new ticket booking. Validates the train, date, route, class, and availability, "
    "calculates the fare, generates a PNR, and reduces available seats. "
    "This endpoint intentionally allows Tatkal bookings for any passenger count and any fare amount; "
    "policy enforcement (e.g. max passengers, max fare) is expected to be handled by an external "
    "governance layer, not this service.",
    response_model=BookingOut,
    status_code=201,
    responses={
        400: {"model": ErrorResponse, "description": "Validation error"},
        404: {"model": ErrorResponse, "description": "Train or station not found"},
        409: {"model": ErrorResponse, "description": "Insufficient seats"},
    },
)
def create_booking(request: CreateBookingRequest, db: Session = Depends(get_db)):
    return booking_service.create_booking(db, request)


@router.get(
    "/bookings/{pnr}",
    operation_id="getBookingByPnr",
    summary="Get booking by PNR",
    description="Retrieve complete booking details using the PNR.",
    response_model=BookingOut,
    responses={404: {"model": ErrorResponse, "description": "Booking not found"}},
)
def get_booking(pnr: str, db: Session = Depends(get_db)):
    return booking_service.get_booking(db, pnr)


@router.post(
    "/bookings/{pnr}/cancel",
    operation_id="cancelBooking",
    summary="Cancel a booking",
    description="Cancel a confirmed booking, restore seats to availability, and calculate the refund amount.",
    response_model=CancellationOut,
    responses={
        400: {"model": ErrorResponse, "description": "Booking already cancelled"},
        404: {"model": ErrorResponse, "description": "Booking not found"},
    },
)
def cancel_booking(pnr: str, db: Session = Depends(get_db)):
    return booking_service.cancel_booking(db, pnr)
