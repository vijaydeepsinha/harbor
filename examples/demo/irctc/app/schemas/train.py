from pydantic import BaseModel, Field

from app.schemas.common import TravelClass


class TrainSearchResult(BaseModel):
    train_number: str = Field(..., description="Train number", examples=["12418"])
    train_name: str = Field(..., description="Train name", examples=["Prayagraj Express"])
    source_station: str = Field(..., description="Source station code")
    destination_station: str = Field(..., description="Destination station code")
    departure_time: str = Field(..., description="Departure time (HH:MM)", examples=["21:15"])
    arrival_time: str = Field(..., description="Arrival time (HH:MM)", examples=["06:40"])
    duration_minutes: int = Field(..., description="Total journey duration in minutes")
    available_classes: list[TravelClass] = Field(..., description="Travel classes offered by this train")
    fare: dict[str, float] = Field(..., description="Fare per travel class for the requested date")
    tatkal_available: bool = Field(..., description="Whether Tatkal quota is offered on this train")


class TrainSearchResponse(BaseModel):
    count: int
    results: list[TrainSearchResult]


class TrainScheduleStop(BaseModel):
    station_code: str
    station_name: str
    role: str = Field(..., description="'SOURCE' or 'DESTINATION' for this simplified two-stop schedule")


class TrainDetail(BaseModel):
    train_number: str
    train_name: str
    source_station: str
    destination_station: str
    departure_time: str
    arrival_time: str
    duration_minutes: int
    running_days: list[str]
    classes: list[TravelClass]
    base_fare: float
    tatkal_available: bool
    route: list[TrainScheduleStop]

    model_config = {"from_attributes": True}
