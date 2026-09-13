---
id: 00-start-here
title: Start here — IRCTC service orientation
tags: [irctc, train, railway, booking, start, overview, orientation, guide]
---

# Start Here

Read this before calling any IRCTC endpoint. It tells you which skill to use next
and the hard rules that apply across every operation in this service.

## Which skill to use

| User wants to... | Use skill |
|---|---|
| Find trains between two cities/stations | `search-trains` |
| Check seats left, or get a fare quote | `check-availability-and-fare` |
| Book a ticket, look up a PNR, or cancel | `book-and-manage-ticket` |
| Reset booking data, or check service health | `reset-and-health-check` |

## Hard rules (apply to every call)

0. **Call `GET /health` before picking any journey_date.** It returns `today` and
   `booking_window` (the valid date range). Never guess, assume, or default to a
   year/date from memory — always anchor on `/health`'s response.
1. **Never write custom filtering, sorting, or re-derivation code.** Every filter
   you could need — route, date, class, tatkal, departure-time window — is already
   a documented query parameter on the relevant endpoint. Call the endpoint with
   the right parameters and return its response as-is. Do not fetch broad data and
   post-process it yourself.
2. **Never invent parameters or fields** that are not in the OpenAPI spec for that
   operation. If you're unsure a parameter exists, it probably doesn't.
3. **Station codes are fixed**: `NDLS`, `PRYJ`, `LKO`, `BSB`, `CNB`, `BCT`, `HWH`.
   Travel classes are fixed: `SL`, `3A`, `2A`, `1A`.
4. **Data covers a rolling 30-day window starting today.** A journey date outside
   that window will 404 — that is expected, not a bug. Pick a date within the next
   30 days.
5. **Some trains run with very limited or zero seats on any given date/class.**
   Seeing `available_seats: 0`, or a `409 INSUFFICIENT_SEATS` on booking, means:
   stop retrying that exact train — call search again and offer the user a
   different train, date, or class.
6. **This service does not enforce booking policy.** It will allow a Tatkal booking
   for any number of passengers, and a booking of any fare amount. Do not add your
   own limits or refuse a request for those reasons — that decision belongs to
   Harbor's governance layer, not you.
