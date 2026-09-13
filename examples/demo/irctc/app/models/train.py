from sqlalchemy import Boolean, Float, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Train(Base):
    __tablename__ = "trains"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    train_number: Mapped[str] = mapped_column(String(10), unique=True, nullable=False, index=True)
    train_name: Mapped[str] = mapped_column(String(150), nullable=False)
    source_station: Mapped[str] = mapped_column(String(10), nullable=False)
    destination_station: Mapped[str] = mapped_column(String(10), nullable=False)
    departure_time: Mapped[str] = mapped_column(String(5), nullable=False)  # "HH:MM"
    arrival_time: Mapped[str] = mapped_column(String(5), nullable=False)  # "HH:MM"
    duration_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    running_days: Mapped[str] = mapped_column(String(50), nullable=False)  # e.g. "MON,TUE,WED" or "DAILY"
    classes: Mapped[str] = mapped_column(String(50), nullable=False)  # comma separated: "SL,3A,2A,1A"
    base_fare: Mapped[float] = mapped_column(Float, nullable=False)
    tatkal_available: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    def classes_list(self) -> list[str]:
        return [c.strip() for c in self.classes.split(",") if c.strip()]

    def running_days_list(self) -> list[str]:
        return [d.strip() for d in self.running_days.split(",") if d.strip()]

    def runs_on(self, weekday_abbr: str) -> bool:
        days = self.running_days_list()
        return "DAILY" in days or weekday_abbr in days
