def test_search_trains_by_route_and_date(client):
    resp = client.get("/trains/search", params={"from": "NDLS", "to": "PRYJ", "date": "2026-09-07"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] >= 2
    for result in body["results"]:
        assert result["source_station"] == "NDLS"
        assert result["destination_station"] == "PRYJ"


def test_search_trains_with_departure_preference(client):
    resp = client.get(
        "/trains/search",
        params={
            "from": "NDLS",
            "to": "PRYJ",
            "date": "2026-09-07",
            "preferred_departure_after": "20:00",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] >= 2
    for result in body["results"]:
        assert result["departure_time"] >= "20:00"


def test_search_trains_unknown_station_returns_404(client):
    resp = client.get("/trains/search", params={"from": "ZZZZ", "to": "PRYJ", "date": "2026-09-07"})
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "STATION_NOT_FOUND"


def test_get_train_details(client):
    resp = client.get("/trains/12418")
    assert resp.status_code == 200
    body = resp.json()
    assert body["train_name"] == "Prayagraj Express"
    assert body["tatkal_available"] is True
    assert "3A" in body["classes"]
    assert len(body["route"]) == 2


def test_get_train_details_invalid_train(client):
    resp = client.get("/trains/99999")
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "TRAIN_NOT_FOUND"
