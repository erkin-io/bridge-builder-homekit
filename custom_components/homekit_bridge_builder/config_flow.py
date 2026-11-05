"""Config flow for Bridge Builder for HomeKit."""

from typing import Any

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult

from .const import DOMAIN, PANEL_TITLE


class BridgeBuilderConfigFlow(ConfigFlow, domain=DOMAIN):
    """Add the panel; there is nothing to configure."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Confirm adding the panel."""
        if user_input is not None:
            return self.async_create_entry(title=PANEL_TITLE, data={})
        return self.async_show_form(step_id="user")

    async def async_step_import(self, import_data: dict[str, Any]) -> ConfigFlowResult:
        """Add the panel from a homekit_bridge_builder: line in configuration.yaml."""
        return self.async_create_entry(title=PANEL_TITLE, data={})
