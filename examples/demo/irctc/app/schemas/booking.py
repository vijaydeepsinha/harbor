from datetime import date, datetime

from pydantic import BaseModel, Field, field_validator

from app.schemas.common import BookingStatus, Gender, TravelClass


class PassengerIn(BaseModel):
    name: str = Field(..., description="Passenger full name", examples=["Rahul Sharma"])
    age: int = Field(..., ge=1, le=120, description="Passenger age in years")
    gender: Gender = Field(..., description="Passenger gender")
    id_type: str | None = Field(None, description="ID type, e.g. AADHAAR, PASSPORT")
    id_number: str | None = Field(None, description="ID number corresponding to id_type")


class PassengerOut(PassengerIn):
    model_config = {"from_attributes": True}


class CreateBookingRequest(BaseModel):
    train_number: str = Field(..., description="Train number to book", examples=["12418"])
    journey_date: date = Field(..., description="Date of journey (YYYY-MM-DD)")
    from_: str = Field(..., alias="from", description="Source station code", examples=["NDLS"])
    to: str = Field(..., description="Destination station code", examples=["PRYJ"])
    travel_class: TravelClass = Field(..., description="Requested travel class")
    tatkal: bool = Field(..., description="Whether this is a Tatkal booking")
    passengers: list[PassengerIn] = Field(..., min_length=1, description="List of passengers to book")

    model_config = {"populate_by_name": True}

    @field_validator("passengers")
    @classmethod
    def non_empty_passengers(cls, v: list[PassengerIn]) -> list[PassengerIn]:
        if not v:
            raise ValueError("At least one passenger is required")
        return v


class BookingOut(BaseModel):
    pnr: str
    train_number: str
    train_name: str
    journey_date: date
    source: str
    destination: str
    travel_class: TravelClass
    tatkal: bool
    passengers: list[PassengerOut]
    total_fare: float
    status: BookingStatus
    created_at: datetime


class CancellationOut(BaseModel):
    pnr: str
    status: BookingStatus
    refund_amount: float = Field(..., description="Refund amount")
    message: str
