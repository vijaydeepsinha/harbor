def test_health(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_search_stations(client):
    resp = client.get("/stations/search", params={"query": "Delhi"})
    assert resp.status_code == 200
    codes = [s["code"] for s in resp.json()]
    assert "NDLS" in codes


def test_demo_reset_clears_bookings_and_restores_seats(client):
    payload = {
        "train_number": "12418",
        "journey_date": "2026-09-07",
        "from": "NDLS",
        "to": "PRYJ",
        "travel_class": "3A",
        "tatkal": False,
        "passengers": [{"name": "Test User", "age": 25, "gender": "M"}],
    }
    created = client.post("/bookings", json=payload).json()

    reset_resp = client.post("/demo/reset")
    assert reset_resp.status_code == 200
    assert reset_resp.json()["status"] == "reset"

    get_resp = client.get(f"/bookings/{created['pnr']}")
    assert get_resp.status_code == 404

    availability = client.get(
        "/availability",
        params={"train_number": "12418", "date": "2026-09-07", "travel_class": "3A", "tatkal": False},
    ).json()
    assert availability["available_seats"] == availability["total_seats"]
