"""Shared fixtures for the Home Assistant integration tests."""

import pytest


@pytest.fixture(autouse=True)
def _assert_http_contract(request):
    """Prove that every mocked HTTP test only issues GET .../api/status.

    The integration is read-only, so any other method or URL recorded by the
    aiohttp mock is a defect, not a test detail.
    """
    yield
    aioclient_mock = request.node.funcargs.get("aioclient_mock")
    if aioclient_mock is None:
        return
    for method, url, _data, _headers in aioclient_mock.mock_calls:
        assert method.lower() == "get", f"unexpected {method.upper()} request"
        assert str(url).endswith("/api/status"), f"unexpected URL {url}"
