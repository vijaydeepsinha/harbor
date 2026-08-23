from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.repositories import station_repo
from app.schemas.station import StationOut

router = APIRouter(tags=["Stations"])


@router.get(
    "/stations/search",
    operation_id="searchStations",
    summary="Search stations",
    description="Search stations by code, name, or city (case-insensitive, partial match).",
    response_model=list[StationOut],
)
def search_stations(
    query: str = Query(..., description="Search text, e.g. 'Delhi' or 'NDLS'"),
    db: Session = Depends(get_db),
):
    return station_repo.search_stations(db, query)
