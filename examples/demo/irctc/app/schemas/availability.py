from pydantic import BaseModel, Field

from app.schemas.common import TravelClass


class AvailabilityOut(BaseModel):
    train_number: str
    date: str = Field(..., description="Journey date (YYYY-MM-DD)")
    travel_class: TravelClass
    tatkal: bool
    available_seats: int
    total_seats: int
    fare: float


class FareBreakdown(BaseModel):
    train_number: str
    date: str
    travel_class: TravelClass
    passenger_count: int
    tatkal: bool
    base_fare_per_passenger: float
    tatkal_surcharge_per_passenger: float = Field(..., description="Tatkal surcharge per passenger")
    total_fare: float
