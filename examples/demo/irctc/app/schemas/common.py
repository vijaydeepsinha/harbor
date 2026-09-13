from enum import Enum

from pydantic import BaseModel, Field


class TravelClass(str, Enum):
    SL = "SL"
    AC3 = "3A"
    AC2 = "2A"
    AC1 = "1A"


class Gender(str, Enum):
    MALE = "M"
    FEMALE = "F"
    OTHER = "O"


class BookingStatus(str, Enum):
    CONFIRMED = "CONFIRMED"
    CANCELLED = "CANCELLED"


class ErrorDetail(BaseModel):
    code: str = Field(..., description="Machine-readable error code, e.g. TRAIN_NOT_FOUND")
    message: str = Field(..., description="Human-readable error message")


class ErrorResponse(BaseModel):
    error: ErrorDetail
