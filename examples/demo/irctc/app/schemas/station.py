from pydantic import BaseModel, Field


class StationOut(BaseModel):
    code: str = Field(..., description="Unique station code, e.g. NDLS")
    name: str = Field(..., description="Station name")
    city: str = Field(..., description="City the station is located in")

    model_config = {"from_attributes": True}
