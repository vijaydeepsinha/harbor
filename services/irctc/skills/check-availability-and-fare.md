---
id: check-availability-and-fare
title: Check seat availability and calculate fare
tags: [availability, seats, fare, price, cost, tatkal, quote]
---

# Check Availability and Fare

Use this skill when the user wants to know how many seats are left on a train, or
wants a fare quote before booking.

## Checking availability

1. Call `GET /availability` with `train_number`, `date`, `travel_class`, and
   optionally `tatkal` (default `false`)
2. Read `available_seats` directly from the response — do not compute or estimate it

## Calculating fare

1. Call `GET /fare` with the same parameters plus `passenger_count` (1-6)
2. Return `base_fare_per_passenger`, `tatkal_surcharge_per_passenger`, and
   `total_fare` as given — do not recompute the math yourself

## Interpreting the result — read this before deciding something is wrong

- **`available_seats: 0` is a valid response.** Some trains run with very limited
  or zero seats in a given class on a given date. It is not a bug and not a reason
  to retry the same call.
- If seats are 0 (or too few for the group size), go back to `GET /trains/search`
  for the same route/date and offer the user a different train. Do not keep
  re-checking the same train/date/class combination.
- A `404` here means the train doesn't run, or the date is outside the bookable
  window returned by `GET /health` — not that seats are unavailable.
- A `400` means the requested `travel_class` isn't offered by this train — check
  `GET /trains/{train_number}` for its actual class list.
