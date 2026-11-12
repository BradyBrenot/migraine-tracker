"""Constants for the Migraine Tracker integration."""

from typing import Final

DOMAIN: Final = "migraine_tracker"
DEFAULT_NAME: Final = "Migraine Tracker"
MANUFACTURER: Final = "migraine-tracker"

# Config entry data.
CONF_URL: Final = "url"

# Config entry options (never entry data, so the header stays out of the
# entry's identity and is not echoed back into a form).
CONF_SCAN_INTERVAL: Final = "scan_interval"
CONF_AUTHORIZATION: Final = "authorization"
CONF_CLEAR_AUTHORIZATION: Final = "clear_authorization"

DEFAULT_SCAN_INTERVAL: Final = 60
MIN_SCAN_INTERVAL: Final = 15
MAX_SCAN_INTERVAL: Final = 3600

API_STATUS_PATH: Final = "/api/status"
REQUEST_TIMEOUT: Final = 10
UNAUTHORIZED_STATUSES: Final = frozenset({401, 403})

# Status document, apiVersion 1 (docs/home-assistant.md).
ATTR_API_VERSION: Final = "apiVersion"
ATTR_GENERATED_AT: Final = "generatedAt"
ATTR_STATE: Final = "state"
ATTR_ACTIVE_ATTACK: Final = "activeAttack"
ATTR_LAST_ATTACK: Final = "lastAttack"
ATTR_HISTORY: Final = "history"
ATTR_INVENTORY: Final = "inventory"
ATTR_NURTEC: Final = "nurtec"

EXPECTED_API_VERSION: Final = 1
STATUS_OPTIONS: Final = ["attack", "off", "well", "no_data"]
VALID_DISPLAY_STATES: Final = frozenset(STATUS_OPTIONS)
