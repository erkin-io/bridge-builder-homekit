"""Constants for Bridge Builder for HomeKit."""

DOMAIN = "homekit_bridge_builder"
HOMEKIT_DOMAIN = "homekit"

PANEL_URL_PATH = "bridge-builder"
PANEL_COMPONENT = "bridge-builder-panel"
PANEL_TITLE = "Bridge Builder"
PANEL_ICON = "mdi:bridge"
STATIC_URL = "/homekit_bridge_builder_static"

STORAGE_KEY = DOMAIN
STORAGE_VERSION = 1

# The HomeKit Bridge refuses to add more than this many accessories,
# and the bridge itself counts as one.
MAX_BRIDGE_ACCESSORIES = 149
