"""Smoke test proving the pytest-homeassistant harness bootstraps."""


async def test_harness_bootstraps(hass):
    """The hass fixture should give a running HomeAssistant instance."""
    assert hass is not None
