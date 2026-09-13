"""App-wide configuration for the IRCTC service."""
import os

DATABASE_URL = os.environ.get("IRCTC_DATABASE_URL", "sqlite:///./irctc_demo.db")

# UVICORN_PORT is uvicorn's own auto-envvar name (uvicorn's CLI has
# auto_envvar_prefix="UVICORN", so this same var also drives `uvicorn app.main:app`
# and `uv run uvicorn app.main:app` directly, with no --port flag needed).
PORT = int(os.environ.get("UVICORN_PORT", "3005"))

TATKAL_SURCHARGE_RATE = 0.30  # flat 30% surcharge on base fare per passenger

TRAVEL_CLASSES = ["SL", "3A", "2A", "1A"]
