import os
import tempfile

import pytest

_tmp_dir = tempfile.mkdtemp(prefix="irctc_test_")
os.environ["IRCTC_DATABASE_URL"] = f"sqlite:///{_tmp_dir}/test_irctc.db"

from fastapi.testclient import TestClient  # noqa: E402

from app.database import Base, engine  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture()
def client():
    Base.metadata.drop_all(bind=engine)
    with TestClient(app) as test_client:
        yield test_client
