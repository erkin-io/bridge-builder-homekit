"""Websocket commands used by the Bridge Builder panel."""

from typing import Any

try:
    import probatio as vol
except ImportError:  # Home Assistant before the move to probatio
    import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import (
    area_registry as ar,
    device_registry as dr,
    entity_registry as er,
)

from . import bridges
from .bridges import BridgeBuilderStore
from .const import DOMAIN
from .preview import classify


def _store(hass: HomeAssistant) -> BridgeBuilderStore:
    return hass.data[DOMAIN]


@callback
def async_register(hass: HomeAssistant) -> None:
    """Register the panel's websocket commands."""
    for command in (
        ws_catalog,
        ws_bridges,
        ws_create_bridge,
        ws_set_entities,
        ws_rename_bridge,
        ws_delete_bridge,
        ws_reset_pairing,
        ws_save_template,
        ws_delete_template,
        ws_import_templates,
    ):
        websocket_api.async_register_command(hass, command)


async def _run(connection, msg_id: int, coro) -> None:
    try:
        result = await coro
    except HomeAssistantError as err:
        connection.send_error(msg_id, "homekit_bridge_builder_error", str(err))
        return
    connection.send_result(msg_id, result)


@websocket_api.websocket_command(
    {vol.Required("type"): "homekit_bridge_builder/catalog", vol.Optional("entry_id"): str}
)
@websocket_api.require_admin
@callback
def ws_catalog(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Every entity, with its room and how Apple Home would show it."""
    entity_config: dict[str, Any] = {}
    if (entry_id := msg.get("entry_id")) and (
        entry := hass.config_entries.async_get_entry(entry_id)
    ):
        entity_config = entry.options.get(
            "entity_config", entry.data.get("entity_config", {})
        )
    ent_reg = er.async_get(hass)
    dev_reg = dr.async_get(hass)
    area_reg = ar.async_get(hass)
    entities = []
    for state in hass.states.async_all():
        entity_id = state.entity_id
        reg = ent_reg.async_get(entity_id)
        device = dev_reg.async_get(reg.device_id) if reg and reg.device_id else None
        area_id = (reg.area_id if reg else None) or (device.area_id if device else None)
        entities.append(
            {
                "entity_id": entity_id,
                "name": state.name,
                "domain": state.domain,
                "area_id": area_id,
                "device": (device.name_by_user or device.name) if device else None,
                "hidden": bool(reg and reg.hidden_by),
                "category": reg.entity_category.value
                if reg and reg.entity_category
                else None,
                "homekit": classify(state, entity_config.get(entity_id)),
            }
        )
    # Listed so the editor can show them and saving keeps them
    for entity_id in sorted(bridges.not_loaded_entity_ids(hass, _store(hass))):
        reg = ent_reg.async_get(entity_id)
        device = dev_reg.async_get(reg.device_id) if reg and reg.device_id else None
        area_id = (reg.area_id if reg else None) or (device.area_id if device else None)
        entities.append(
            {
                "entity_id": entity_id,
                "name": (reg and (reg.name or reg.original_name)) or entity_id,
                "domain": entity_id.partition(".")[0],
                "area_id": area_id,
                "device": (device.name_by_user or device.name) if device else None,
                "hidden": False,
                "category": None,
                "missing": True,
                "homekit": {
                    "kind": None,
                    "service": "Not loaded",
                    "note": "Home Assistant has no state for this right now. "
                    "It stays selected unless you untick it.",
                    "supported": True,
                    "needs_own_pairing": bridges.needs_own_pairing(hass, entity_id),
                },
            }
        )
    areas = [
        {"area_id": area.id, "name": area.name, "floor_id": area.floor_id}
        for area in area_reg.async_list_areas()
    ]
    connection.send_result(msg["id"], {"entities": entities, "areas": areas})


@websocket_api.websocket_command({vol.Required("type"): "homekit_bridge_builder/bridges"})
@websocket_api.require_admin
@callback
def ws_bridges(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Every HomeKit entry plus the saved templates."""
    store = _store(hass)
    connection.send_result(
        msg["id"],
        {
            "bridges": bridges.list_bridges(hass, store),
            "templates": list(store.templates.values()),
        },
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "homekit_bridge_builder/create_bridge",
        vol.Required("name"): str,
        vol.Required("entities"): [str],
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_create_bridge(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Create a bridge with exactly these entities."""

    async def _create() -> dict:
        entry_id = await bridges.async_create_bridge(
            hass, _store(hass), msg["name"], msg["entities"]
        )
        return {"entry_id": entry_id}

    await _run(connection, msg["id"], _create())


@websocket_api.websocket_command(
    {
        vol.Required("type"): "homekit_bridge_builder/set_entities",
        vol.Required("entry_id"): str,
        vol.Required("entities"): [str],
        vol.Optional("name"): str,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_set_entities(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Replace what a bridge shares, and rename it if a name is given."""
    await _run(
        connection,
        msg["id"],
        bridges.async_set_bridge_entities(
            hass, _store(hass), msg["entry_id"], msg["entities"], msg.get("name")
        ),
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "homekit_bridge_builder/rename_bridge",
        vol.Required("entry_id"): str,
        vol.Required("name"): str,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_rename_bridge(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Rename a bridge and nothing else."""
    await _run(
        connection,
        msg["id"],
        bridges.async_rename_bridge(hass, _store(hass), msg["entry_id"], msg["name"]),
    )


@websocket_api.websocket_command(
    {vol.Required("type"): "homekit_bridge_builder/delete_bridge", vol.Required("entry_id"): str}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_delete_bridge(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Delete a bridge and its own-pairing accessories."""
    await _run(
        connection,
        msg["id"],
        bridges.async_delete_bridge(hass, _store(hass), msg["entry_id"]),
    )


@websocket_api.websocket_command(
    {vol.Required("type"): "homekit_bridge_builder/reset_pairing", vol.Required("entry_id"): str}
)
@websocket_api.require_admin
@callback
def ws_reset_pairing(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Unpair a bridge so it shows a fresh code."""
    try:
        bridges.async_reset_pairing(hass, msg["entry_id"])
    except HomeAssistantError as err:
        connection.send_error(msg["id"], "homekit_bridge_builder_error", str(err))
        return
    connection.send_result(msg["id"])


@websocket_api.websocket_command(
    {
        vol.Required("type"): "homekit_bridge_builder/save_template",
        vol.Optional("template_id"): str,
        vol.Required("name"): str,
        vol.Required("entities"): [str],
    }
)
@websocket_api.require_admin
@callback
def ws_save_template(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Save a selection as a reusable template."""
    template = _store(hass).save_template(
        msg.get("template_id"), msg["name"], msg["entities"]
    )
    connection.send_result(msg["id"], template)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "homekit_bridge_builder/delete_template",
        vol.Required("template_id"): str,
    }
)
@websocket_api.require_admin
@callback
def ws_delete_template(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Delete a template."""
    _store(hass).delete_template(msg["template_id"])
    connection.send_result(msg["id"])


@websocket_api.websocket_command(
    {
        vol.Required("type"): "homekit_bridge_builder/import_templates",
        vol.Required("templates"): [
            {vol.Required("name"): str, vol.Required("entities"): [str]}
        ],
    }
)
@websocket_api.require_admin
@callback
def ws_import_templates(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Add templates from an exported file."""
    try:
        result = bridges.import_templates(hass, _store(hass), msg["templates"])
    except HomeAssistantError as err:
        connection.send_error(msg["id"], "homekit_bridge_builder_error", str(err))
        return
    connection.send_result(msg["id"], result)
