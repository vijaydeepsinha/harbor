from sqlalchemy import Float, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Availability(Base):
    __tablename__ = "availability"
    __table_args__ = (
        UniqueConstraint("train_id", "journey_date", "travel_class", "tatkal", name="uq_availability_slot"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    train_id: Mapped[int] = mapped_column(ForeignKey("trains.id"), nullable=False, index=True)
    journey_date: Mapped[str] = mapped_column(String(10), nullable=False, index=True)  # "YYYY-MM-DD"
    travel_class: Mapped[str] = mapped_column(String(5), nullable=False)
    tatkal: Mapped[bool] = mapped_column(default=False, nullable=False)
    total_seats: Mapped[int] = mapped_column(Integer, nullable=False)
    available_seats: Mapped[int] = mapped_column(Integer, nullable=False)
    fare: Mapped[float] = mapped_column(Float, nullable=False)
