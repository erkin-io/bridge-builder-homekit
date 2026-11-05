"""Bridge Builder for HomeKit: a panel for building HomeKit bridges."""

from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import SOURCE_IMPORT, ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.storage import Store
from homeassistant.helpers.typing import ConfigType

from . import api
from .bridges import BridgeBuilderStore
from .const import (
    DOMAIN,
    PANEL_COMPONENT,
    PANEL_ICON,
    PANEL_TITLE,
    PANEL_URL_PATH,
    STATIC_URL,
    STORAGE_KEY,
    STORAGE_VERSION,
)

# A bare homekit_bridge_builder: line is allowed, with no options under it
CONFIG_SCHEMA = cv.empty_config_schema(DOMAIN)

_REGISTERED = f"{DOMAIN}_registered"


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Support adding the panel with a homekit_bridge_builder: line in YAML."""
    if DOMAIN in config and not hass.config_entries.async_entries(DOMAIN):
        hass.async_create_task(
            hass.config_entries.flow.async_init(
                DOMAIN, context={"source": SOURCE_IMPORT}, data={}
            )
        )
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Load templates, register the API and add the sidebar panel."""
    store = BridgeBuilderStore(hass)
    await store.async_load()
    hass.data[DOMAIN] = store

    # Static paths and websocket commands cannot be unregistered, so only
    # add them the first time the entry loads.
    if not hass.data.get(_REGISTERED):
        frontend_dir = Path(__file__).parent / "frontend"
        await hass.http.async_register_static_paths(
            [StaticPathConfig(STATIC_URL, str(frontend_dir), cache_headers=False)]
        )
        api.async_register(hass)
        hass.data[_REGISTERED] = True

    panel_js = Path(__file__).parent / "frontend" / "bridge-builder-panel.js"
    version = await hass.async_add_executor_job(lambda: panel_js.stat().st_mtime)
    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name=PANEL_COMPONENT,
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        module_url=f"{STATIC_URL}/bridge-builder-panel.js?v={int(version)}",
        require_admin=True,
    )
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Remove the sidebar panel."""
    frontend.async_remove_panel(hass, PANEL_URL_PATH)
    if store := hass.data.pop(DOMAIN, None):
        await store.async_flush()
    return True


async def async_remove_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Delete the saved templates when the integration is removed.

    The bridges are ordinary HomeKit entries and stay as they are.
    """
    await Store(hass, STORAGE_VERSION, STORAGE_KEY).async_remove()
