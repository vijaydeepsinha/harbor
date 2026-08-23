PASSENGER = {"name": "Rahul Sharma", "age": 32, "gender": "M"}


def _booking_payload(**overrides):
    payload = {
        "train_number": "12418",
        "journey_date": "2026-09-07",
        "from": "NDLS",
        "to": "PRYJ",
        "travel_class": "3A",
        "tatkal": False,
        "passengers": [PASSENGER, {"name": "Priya Sharma", "age": 29, "gender": "F"}],
    }
    payload.update(overrides)
    return payload


def test_create_normal_booking(client):
    resp = client.post("/bookings", json=_booking_payload())
    assert resp.status_code == 201
    body = resp.json()
    assert len(body["pnr"]) == 10
    assert body["status"] == "CONFIRMED"
    assert len(body["passengers"]) == 2
    assert body["total_fare"] > 0


def test_create_tatkal_booking(client):
    resp = client.post("/bookings", json=_booking_payload(tatkal=True))
    assert resp.status_code == 201
    assert resp.json()["tatkal"] is True


def test_create_tatkal_booking_three_passengers_succeeds(client):
    """Backend must allow Tatkal + 3 passengers; Harbor governance blocks this later, not this service."""
    payload = _booking_payload(
        tatkal=True,
        passengers=[
            {"name": "A One", "age": 40, "gender": "M"},
            {"name": "B Two", "age": 38, "gender": "F"},
            {"name": "C Three", "age": 10, "gender": "M"},
        ],
    )
    resp = client.post("/bookings", json=payload)
    assert resp.status_code == 201
    assert len(resp.json()["passengers"]) == 3


def test_create_booking_above_5000_succeeds(client):
    """Backend must allow bookings above the future Harbor max-fare threshold."""
    payload = _booking_payload(train_number="12301", to="HWH", travel_class="1A", tatkal=False)
    resp = client.post("/bookings", json=payload)
    assert resp.status_code == 201
    assert resp.json()["total_fare"] > 5000


def test_retrieve_booking_by_pnr(client):
    created = client.post("/bookings", json=_booking_payload()).json()
    resp = client.get(f"/bookings/{created['pnr']}")
    assert resp.status_code == 200
    assert resp.json()["pnr"] == created["pnr"]


def test_retrieve_unknown_pnr_returns_404(client):
    resp = client.get("/bookings/0000000000")
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "BOOKING_NOT_FOUND"


def test_cancel_booking_restores_seats(client):
    availability_before = client.get(
        "/availability",
        params={"train_number": "12418", "date": "2026-09-07", "travel_class": "3A", "tatkal": False},
    ).json()

    created = client.post("/bookings", json=_booking_payload()).json()

    availability_after_booking = client.get(
        "/availability",
        params={"train_number": "12418", "date": "2026-09-07", "travel_class": "3A", "tatkal": False},
    ).json()
    assert availability_after_booking["available_seats"] == availability_before["available_seats"] - 2

    cancel_resp = client.post(f"/bookings/{created['pnr']}/cancel")
    assert cancel_resp.status_code == 200
    assert cancel_resp.json()["status"] == "CANCELLED"

    availability_after_cancel = client.get(
        "/availability",
        params={"train_number": "12418", "date": "2026-09-07", "travel_class": "3A", "tatkal": False},
    ).json()
    assert availability_after_cancel["available_seats"] == availability_before["available_seats"]

    get_resp = client.get(f"/bookings/{created['pnr']}")
    assert get_resp.json()["status"] == "CANCELLED"


def test_cancel_already_cancelled_booking_fails(client):
    created = client.post("/bookings", json=_booking_payload()).json()
    client.post(f"/bookings/{created['pnr']}/cancel")
    resp = client.post(f"/bookings/{created['pnr']}/cancel")
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "ALREADY_CANCELLED"


def test_create_booking_invalid_train(client):
    resp = client.post("/bookings", json=_booking_payload(train_number="99999"))
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "TRAIN_NOT_FOUND"


def test_create_booking_invalid_class(client):
    resp = client.post("/bookings", json=_booking_payload(train_number="12951", travel_class="SL"))
    # 12951 (Mumbai Rajdhani) does not run NDLS->PRYJ or offer SL; route mismatch surfaces first.
    assert resp.status_code in (400, 404)


def test_create_booking_insufficient_seats(client):
    payload = _booking_payload(
        travel_class="1A",
        tatkal=True,
        passengers=[{"name": f"P{i}", "age": 30, "gender": "M"} for i in range(6)],
    )
    resp = client.post("/bookings", json=payload)
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "INSUFFICIENT_SEATS"
