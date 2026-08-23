# IRCTC Railway Booking Service

## Purpose

A small, self-contained railway booking backend used to demonstrate the Harbor MCP
gateway. It exposes a booking API (search, availability, fare, booking, cancellation)
with a rich OpenAPI spec so Harbor can discover and govern it dynamically. Reference
data (stations, trains, availability) is seeded automatically on startup into a local
SQLite database.

## Architecture

```text
AI Agent
    |
    v
MCP
    |
    v
Harbor
    |
    v
OpenAPI discovery / API execution
    |
    v
Railway Booking Service     <-- this repo
    |
    v
SQLite
```

Later, Harbor will introduce a governance layer:

```text
Governance
    |
    v
ALLOW / DENY
```

sitting in front of backend API execution. **Harbor integration is intentionally not
implemented in this project.** This service only exposes technically valid operations;
policy decisions (e.g. blocking Tatkal for large groups, capping booking amounts) are
left entirely to Harbor.

Project layout:

```text
app/
  main.py          FastAPI app, lifespan seeding, logging, error handlers
  database.py      SQLAlchemy engine/session setup
  config.py        Runtime configuration
  models/          SQLAlchemy ORM models
  schemas/         Pydantic request/response schemas
  repositories/     Data access
  services/        Business logic
  routes/          Thin FastAPI routers
  seed.py          Reference data seeding / reset
tests/             pytest suite
```

## Installation

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Running locally

```bash
python -m app.main
```

The port is defined in one place — `app/config.py` reads `UVICORN_PORT` (default
`3005`). This is also uvicorn's own auto-envvar name, so the same variable works no
matter how you start the app:

```bash
python -m app.main                                  # uses UVICORN_PORT, default 3005
UVICORN_PORT=4000 python -m app.main                 # override
UVICORN_PORT=4000 uvicorn app.main:app --reload      # uvicorn CLI honors it directly
UVICORN_PORT=4000 uv run uvicorn app.main:app --reload
```

The service listens on `http://localhost:3005` and seeds reference data automatically
on startup (idempotent — safe to restart).

## API documentation

- Swagger UI: `http://localhost:3005/docs`
- ReDoc: `http://localhost:3005/redoc`
- Raw OpenAPI spec: `http://localhost:3005/openapi.json`

## Example curl commands

```bash
# Search trains
curl "http://localhost:3005/trains/search?from=NDLS&to=PRYJ&date=2026-09-07&preferred_departure_after=20:00"

# Train details
curl "http://localhost:3005/trains/12418"

# Check availability
curl "http://localhost:3005/availability?train_number=12418&date=2026-09-07&travel_class=3A&tatkal=false"

# Calculate fare
curl "http://localhost:3005/fare?train_number=12418&date=2026-09-07&travel_class=3A&passenger_count=2&tatkal=false"

# Create a booking
curl -X POST "http://localhost:3005/bookings" \
  -H "Content-Type: application/json" \
  -d '{
    "train_number": "12418",
    "journey_date": "2026-09-07",
    "from": "NDLS",
    "to": "PRYJ",
    "travel_class": "3A",
    "tatkal": false,
    "passengers": [
      {"name": "Rahul Sharma", "age": 32, "gender": "M"},
      {"name": "Priya Sharma", "age": 29, "gender": "F"}
    ]
  }'

# Retrieve a booking
curl "http://localhost:3005/bookings/<PNR>"

# Cancel a booking
curl -X POST "http://localhost:3005/bookings/<PNR>/cancel"

# Reset booking data
curl -X POST "http://localhost:3005/demo/reset"
```

## Booking workflow

1. Search New Delhi (`NDLS`) -> Prayagraj (`PRYJ`) trains for `2026-09-07`.
2. Filter by `preferred_departure_after=20:00`.
3. Pick a train (e.g. `12418`), check availability, and calculate the fare.
4. Create a booking and receive a generated PNR.
5. Retrieve the booking by PNR.
6. Cancel the booking and confirm the status is `CANCELLED` on re-fetch.
7. Create a Tatkal booking for 3 passengers — the backend allows it (Harbor will later
   decide whether this is permitted).
8. Create a booking with total fare above ₹5,000 — the backend allows it (Harbor will
   later enforce any maximum-amount policy).

## Reset instructions

```bash
curl -X POST "http://localhost:3005/demo/reset"
```

This deletes all bookings and restores every availability record to full capacity,
returning the service to a clean state without restarting the app.

## Tests

```bash
pytest
```

## Harbor integration

This service deliberately does **not** implement any governance/policy logic (e.g.
blocking Tatkal bookings by passenger count, or capping total booking fare). It exposes
the raw technical capability via a fully-described OpenAPI spec so that Harbor, sitting
in front of this service, can decide — per request — whether an AI agent's action is
`ALLOWED` or `DENIED` before the request ever reaches this backend.
