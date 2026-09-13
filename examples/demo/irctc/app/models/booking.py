from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class Booking(Base):
    __tablename__ = "bookings"

    pnr: Mapped[str] = mapped_column(String(10), primary_key=True)
    train_id: Mapped[int] = mapped_column(ForeignKey("trains.id"), nullable=False)
    journey_date: Mapped[str] = mapped_column(String(10), nullable=False)
    source: Mapped[str] = mapped_column(String(10), nullable=False)
    destination: Mapped[str] = mapped_column(String(10), nullable=False)
    travel_class: Mapped[str] = mapped_column(String(5), nullable=False)
    tatkal: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    total_fare: Mapped[float] = mapped_column(Float, nullable=False)
    status: Mapped[str] = mapped_column(String(15), nullable=False, default="CONFIRMED")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))

    passengers: Mapped[list["BookingPassenger"]] = relationship(
        back_populates="booking", cascade="all, delete-orphan"
    )


class BookingPassenger(Base):
    __tablename__ = "booking_passengers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    booking_pnr: Mapped[str] = mapped_column(ForeignKey("bookings.pnr"), nullable=False)
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    age: Mapped[int] = mapped_column(Integer, nullable=False)
    gender: Mapped[str] = mapped_column(String(1), nullable=False)
    id_type: Mapped[str | None] = mapped_column(String(30), nullable=True)
    id_number: Mapped[str | None] = mapped_column(String(50), nullable=True)

    booking: Mapped["Booking"] = relationship(back_populates="passengers")
