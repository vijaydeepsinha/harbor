---
id: search-trains
title: Search trains and get train details
tags: [train, search, route, schedule, timing, departure, arrival, find]
---

# Search Trains

Use this skill when the user wants to find trains between two stations, or wants
details about a specific train they already know the number of.

## Searching by route and date

1. Call `GET /trains/search` with `from`, `to` (station codes), and `date`
   (YYYY-MM-DD, must be within the next 30 days from today)
2. If the user gives a time preference ("after 8pm", "morning trains only"), pass
   `preferred_departure_after` and/or `preferred_departure_before` (HH:MM) — do not
   filter the `results` array yourself, the parameter already does this
3. Present each result's train number, name, departure/arrival time, duration,
   `available_classes`, `fare` (per class), and `tatkal_available`
4. If `count` is 0, tell the user no trains run that route/date — do not retry the
   same call expecting a different result

## Getting full details for a known train

1. Call `GET /trains/{train_number}` (e.g. `12418`)
2. Return route, schedule, running days, classes, and base fare

## Important

- `from`/`to` must be station codes from this fixed set: `NDLS`, `PRYJ`, `LKO`,
  `BSB`, `CNB`, `BCT`, `HWH`. If the user gives a city name instead of a code, use
  `GET /stations/search?query=<city>` to resolve it first.
- A 404 here means the station code itself isn't recognized — it does not mean "no
  trains found" (that's `count: 0` with a `200`).
- This endpoint only returns whether classes/Tatkal are offered — it does not tell
  you seat counts. For actual seats left, use the `check-availability-and-fare`
  skill next.
