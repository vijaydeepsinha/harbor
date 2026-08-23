I want you to build a small, self-contained **simulated IRCTC railway booking service in Python** that I will use as a backend for demonstrating my open-source Harbor MCP gateway.

IMPORTANT:

* This is a POC/demo service only.
* Do NOT connect to, scrape, or depend on real IRCTC systems.
* Do NOT claim that any implemented railway rules are actual IRCTC policies.
* The service must run completely locally.
* Use SQLite as the local database.
* No external database, Redis, Kafka, cloud service, or external infrastructure should be required.
* Seed realistic demo data automatically when the application starts.
* Keep the implementation simple, clean, and easy to understand because this will be used in a live technical demo.

## Technology

Use:

* Python 3.11+
* FastAPI
* Uvicorn
* SQLite
* SQLAlchemy 2.x
* Pydantic
* pytest for tests

The application should run with:

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Expose the service on:

```text
http://localhost:8000
```

FastAPI should automatically expose:

```text
/openapi.json
/docs
/redoc
```

The generated OpenAPI specification is extremely important because Harbor will later consume this API dynamically.

Use a clean project structure such as:

```text
app/
  main.py
  database.py
  models/
  schemas/
  repositories/
  services/
  routes/
  seed.py
  config.py

tests/

requirements.txt
README.md
```

Keep routes thin and put business logic in service classes.

---

# DOMAIN

Create a simplified railway booking system.

## Station

Fields:

* code
* name
* city

Seed at least:

```text
NDLS - New Delhi
PRYJ - Prayagraj
LKO  - Lucknow
BSB  - Varanasi
CNB  - Kanpur
BCT  - Mumbai Central
HWH  - Howrah
```

Support searching using station code and/or name.

---

# TRAIN

Fields:

* id
* train_number
* train_name
* source_station
* destination_station
* departure_time
* arrival_time
* duration_minutes
* running_days
* classes
* base_fare
* tatkal_available

Create realistic sample trains.

For example:

```text
12301 Rajdhani Express
12423 Dibrugarh Rajdhani
12801 Purushottam Express
12418 Prayagraj Express
12951 Mumbai Rajdhani
```

These are fictional demo records even if the names/numbers resemble real trains.

Create enough data so searches return multiple results.

---

# JOURNEY / AVAILABILITY

Represent availability for:

* SL
* 3A
* 2A
* 1A

Each train/date/class combination should have:

* total_seats
* available_seats
* fare

Seed enough availability data for the demo.

---

# PASSENGER

Fields:

* name
* age
* gender
* id_type
* id_number

Do not implement real identity verification.

---

# TICKET / BOOKING

Fields:

* pnr
* train_id
* journey_date
* source
* destination
* travel_class
* tatkal
* passengers
* total_fare
* status
* created_at

Possible status:

```text
CONFIRMED
CANCELLED
```

Generate a realistic 10-digit PNR when creating a booking.

---

# REQUIRED APIs

## 1. Search trains

GET:

```text
/trains/search
```

Query parameters:

* from
* to
* date
* preferred_departure_after (optional)
* preferred_departure_before (optional)

Example:

```text
GET /trains/search?from=NDLS&to=PRYJ&date=2026-09-07
```

Return:

* train number
* train name
* departure
* arrival
* duration
* available classes
* fare
* Tatkal availability

Support filtering by preferred departure time.

For example:

```text
preferred_departure_after=20:00
```

This is one of the most important APIs for the demo.

---

# 2. Get train details

GET:

```text
/trains/{train_number}
```

Return:

* train details
* route
* schedule
* running days
* classes
* fare information
* Tatkal availability

---

# 3. Check seat availability

GET:

```text
/availability
```

Query parameters:

* train_number
* date
* travel_class
* tatkal

Example:

```text
GET /availability?train_number=12418&date=2026-09-07&travel_class=3A&tatkal=false
```

Return:

* train
* date
* class
* tatkal
* available_seats
* fare

Do not modify availability during GET requests.

---

# 4. Create ticket / booking

POST:

```text
/bookings
```

Request body:

```json
{
  "train_number": "12418",
  "journey_date": "2026-09-07",
  "from": "NDLS",
  "to": "PRYJ",
  "travel_class": "3A",
  "tatkal": false,
  "passengers": [
    {
      "name": "Rahul Sharma",
      "age": 32,
      "gender": "M"
    },
    {
      "name": "Priya Sharma",
      "age": 29,
      "gender": "F"
    }
  ]
}
```

The service should:

1. Validate train.
2. Validate journey date.
3. Validate source/destination.
4. Validate class.
5. Check availability.
6. Calculate fare.
7. Generate PNR.
8. Reduce available seats.
9. Persist booking.
10. Return booking details.

Return:

* PNR
* train
* journey details
* passenger information
* class
* Tatkal status
* total fare
* booking status

IMPORTANT:

**Do NOT implement governance rules inside this service.**

Specifically:

* Do NOT block Tatkal based on passenger count.
* Do NOT implement a maximum booking amount.
* Do NOT implement Harbor policy enforcement.
* Do NOT implement enterprise governance.

The backend should expose the capability and allow the operation when technically valid.

Harbor will later decide whether the operation is permitted.

This separation is critical to the demo.

---

# 5. Get booking using PNR

GET:

```text
/bookings/{pnr}
```

Return complete booking details.

Return HTTP 404 if the PNR doesn't exist.

---

# 6. Cancel booking

POST:

```text
/bookings/{pnr}/cancel
```

When cancelling:

1. Validate PNR.
2. Ensure it isn't already cancelled.
3. Mark it CANCELLED.
4. Restore seats.
5. Calculate a simple simulated refund.
6. Return cancellation details.

---

# 7. Calculate fare

GET:

```text
/fare
```

Parameters:

* train_number
* date
* travel_class
* passenger_count
* tatkal

Return:

* base fare
* Tatkal surcharge
* total fare

This endpoint is particularly useful for demonstrating Harbor governance.

---

# OPTIONAL APIS

Add:

```text
GET /stations/search?query=Delhi
GET /health
POST /demo/reset
```

`/demo/reset` should restore seeded availability and remove demo bookings.

---

# OPENAPI REQUIREMENTS

FastAPI's generated OpenAPI specification must be comprehensive.

Every endpoint should have:

* operation_id
* summary
* description
* parameters
* request body schema
* response schema
* error responses
* enums
* required fields

For example:

```text
POST /bookings
operationId: createBooking
```

Its request schema must explicitly describe:

* train_number
* journey_date
* from
* to
* travel_class
* tatkal
* passengers

`tatal` must be a boolean.

The passenger list must have an explicit array schema.

Harbor should be able to understand the APIs entirely from `/openapi.json`.

---

# DEMO DATA

The following scenarios must work immediately after startup.

## Scenario 1

Search:

```text
New Delhi → Prayagraj
Date: 2026-09-07
Preferred departure: after 20:00
```

Return at least 2–3 suitable trains.

## Scenario 2

Tatkal booking.

At least one train must support Tatkal.

## Scenario 3

Normal booking for two passengers.

## Scenario 4

Tatkal booking for three passengers.

**The backend must allow this if technically valid.**

Harbor's governance layer will later block it.

## Scenario 5

Booking with total fare greater than ₹5,000.

Again, allow it if seats are available.

Harbor will later enforce the maximum amount.

## Scenario 6

Create booking → retrieve by PNR → cancel → retrieve again → confirm CANCELLED.

---

# ERROR HANDLING

Use consistent JSON errors:

```json
{
  "error": {
    "code": "TRAIN_NOT_FOUND",
    "message": "Train 99999 was not found"
  }
}
```

Use:

* 400 — validation errors
* 404 — resource not found
* 409 — availability/booking conflicts
* 500 — unexpected errors

---

# LOGGING

Add structured logging for:

* timestamp
* request ID
* operation
* train number
* PNR
* result

Do not unnecessarily log passenger identity information.

---

# TESTS

Use pytest.

Test at minimum:

1. Search trains by route/date.
2. Search using departure-time preference.
3. Get train details.
4. Check availability.
5. Create normal booking.
6. Create Tatkal booking.
7. Retrieve booking by PNR.
8. Cancel booking.
9. Verify seats are restored.
10. Invalid train.
11. Invalid class.
12. Insufficient seats.

Also explicitly test:

```text
Tatkal + 3 passengers → backend succeeds
Booking > ₹5,000 → backend succeeds
```

These are intentional.

They will later be blocked by Harbor governance.

---

# RESET / DEMO EXPERIENCE

The application should be easy to reset between demonstrations.

Implement:

```text
POST /demo/reset
```

It should:

* delete all demo bookings
* restore seeded availability
* reset generated demo data

Return:

```json
{
  "status": "reset",
  "message": "Demo railway data has been restored"
}
```

---

# README

Create a README containing:

1. Project purpose.
2. Important disclaimer that this is not IRCTC.
3. Architecture.
4. Installation.
5. Running locally.
6. API documentation.
7. Example curl commands.
8. Demo workflow.
9. Reset instructions.
10. Harbor integration.

Show this intended architecture:

```text
AI Agent
    ↓
MCP
    ↓
Harbor
    ↓
OpenAPI discovery / API execution
    ↓
Simulated Railway Service
    ↓
SQLite
```

Later Harbor will introduce:

```text
Governance
    ↓
ALLOW / DENY
```

before backend API execution.

Do NOT implement Harbor integration in this project.

---

# FINAL ACCEPTANCE CRITERIA

After running:

```bash
uvicorn app.main:app --reload
```

I must be able to demonstrate:

1. Search New Delhi → Prayagraj trains.
2. Filter by preferred departure time.
3. Select a train.
4. Check availability.
5. Calculate fare.
6. Create a ticket.
7. Receive PNR.
8. Retrieve ticket using PNR.
9. Cancel ticket.
10. Retrieve PNR again and see CANCELLED.
11. Create a Tatkal booking for three passengers successfully.
12. Create a booking above ₹5,000 successfully.

The final two cases are deliberate. The **backend provides the capability**, while Harbor will later determine whether the AI agent is **allowed** to perform those operations.

Keep the implementation small, robust, readable, and demo-friendly. Do not over-engineer it.
