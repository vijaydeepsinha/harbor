def test_check_availability(client):
    resp = client.get(
        "/availability",
        params={"train_number": "12418", "date": "2026-09-07", "travel_class": "3A", "tatkal": False},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["train_number"] == "12418"
    assert body["available_seats"] > 0
    assert body["fare"] > 0


def test_check_availability_invalid_class(client):
    resp = client.get(
        "/availability",
        params={"train_number": "12951", "date": "2026-09-07", "travel_class": "SL", "tatkal": False},
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "INVALID_CLASS"


def test_calculate_fare_normal(client):
    resp = client.get(
        "/fare",
        params={
            "train_number": "12418",
            "date": "2026-09-07",
            "travel_class": "3A",
            "passenger_count": 2,
            "tatkal": False,
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["tatkal_surcharge_per_passenger"] == 0.0
    assert body["total_fare"] == round(body["base_fare_per_passenger"] * 2, 2)


def test_calculate_fare_tatkal_adds_surcharge(client):
    resp = client.get(
        "/fare",
        params={
            "train_number": "12418",
            "date": "2026-09-07",
            "travel_class": "3A",
            "passenger_count": 1,
            "tatkal": True,
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["tatkal_surcharge_per_passenger"] > 0
