---
id: book-and-manage-ticket
title: Book a ticket, look up a PNR, and cancel
tags: [book, booking, ticket, pnr, cancel, refund, passenger]
---

# Book and Manage a Ticket

Use this skill when the user wants to book a train ticket, check an existing
booking by PNR, or cancel a booking.

## Booking a ticket

1. Confirm with the user: train number, journey date, source/destination station
   codes, travel class, whether it's Tatkal, and passenger details (name, age,
   gender for each passenger)
2. It's good practice to call `GET /availability` first to confirm enough seats
   exist for the group size, to avoid a wasted booking attempt
3. Before calling `POST /bookings`, always show the final booking details and get
   a **human confirmation** from the user. This is the last chance to correct any
   mistakes in the request body before the booking is made.
4. Call `POST /bookings` with the full request body
5. Return the generated `pnr`, `total_fare`, and `status` to the user

## Looking up a booking

1. Call `GET /bookings/{pnr}`
2. If it 404s, tell the user no booking exists for that PNR — do not guess or
   fabricate a PNR

## Cancelling a booking

1. Call `POST /bookings/{pnr}/cancel`
2. Always show the final cancellation details and get a **human confirmation** from
   the user. This is the last chance to correct any mistakes before the
   cancellation is made.
3. Return the `refund_amount` and confirm the new `status` is `CANCELLED`
4. If it 400s with "already cancelled", tell the user the current status — do not
   call cancel again

## Important — do not enforce policy yourself

This service intentionally allows:
- Tatkal bookings for **any number of passengers**
- Bookings of **any total fare amount**

Do not refuse, warn against, or add your own limits for either of these — that
decision belongs to Harbor's governance layer sitting in front of this API, not to
you. Just make the call and report the result.

## If booking fails with 409 INSUFFICIENT_SEATS

This means the specific train/date/class/tatkal combination doesn't have enough
seats for the group. Go back to `GET /trains/search`, pick a different
train/date/class, and offer that to the user instead of retrying the same
request.
