"""Create, read and change HomeKit Bridge config entries.

Everything goes through the HomeKit integration's own config flow and
options, so the bridges this creates are ordinary HomeKit Bridge entries
that keep working if this integration is removed.
"""

import asyncio
from collections.abc import Iterable
from copy import deepcopy
import logging
import re
import secrets
from typing import Any

from homeassistant.components.homekit.const import DEFAULT_CONFIG_FLOW_PORT

try:
    from homeassistant.components.homekit.const import STATUS_RUNNING, STATUS_STOPPED
except ImportError:  # Before they moved to const (2026.10 and older)
    from homeassistant.components.homekit import STATUS_RUNNING, STATUS_STOPPED
from homeassistant.components.homekit.util import (
    async_find_next_available_port,
    state_needs_accessory_mode,
)
from homeassistant.config_entries import (
    SOURCE_IMPORT,
    SOURCE_USER,
    ConfigEntry,
    ConfigEntryState,
)
from homeassistant.core import HomeAssistant, State, callback, valid_entity_id
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.entityfilter import FILTER_SCHEMA
from homeassistant.helpers.storage import Store
from slugify import slugify  # Home Assistant itself depends on python-slugify

from .const import HOMEKIT_DOMAIN, MAX_BRIDGE_ACCESSORIES, STORAGE_KEY, STORAGE_VERSION

_LOGGER = logging.getLogger(__name__)

MODE_BRIDGE = "bridge"
MODE_ACCESSORY = "accessory"


class BridgeBuilderStore:
    """Templates, and which accessory-mode entries belong to which bridge."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Set up the store."""
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self.templates: dict[str, dict[str, Any]] = {}
        # accessory-mode entry id -> the bridge entry id it was made for
        self.links: dict[str, str] = {}

    async def async_load(self) -> None:
        """Load from disk."""
        data = await self._store.async_load() or {}
        self.templates = data.get("templates", {})
        self.links = data.get("links", {})

    def _data(self) -> dict[str, Any]:
        return {"templates": self.templates, "links": self.links}

    @callback
    def async_save(self) -> None:
        """Save soon."""
        self._store.async_delay_save(self._data, 1)

    async def async_flush(self) -> None:
        """Write now, so no delayed save runs after the entry is gone."""
        await self._store.async_save(self._data())

    @callback
    def save_template(
        self, template_id: str | None, name: str, entities: list[str]
    ) -> dict[str, Any]:
        """Add or replace a template."""
        template_id = template_id or secrets.token_hex(6)
        self.templates[template_id] = {
            "id": template_id,
            "name": name,
            "entities": sorted(set(entities)),
        }
        self.async_save()
        return self.templates[template_id]

    @callback
    def delete_template(self, template_id: str) -> None:
        """Delete a template."""
        self.templates.pop(template_id, None)
        self.async_save()


@callback
def import_templates(
    hass: HomeAssistant, store: BridgeBuilderStore, templates: list[dict[str, Any]]
) -> dict[str, Any]:
    """Add templates from a file. All of them or, if one is invalid, none.

    Nothing is overwritten: an exact copy of a template is skipped, and a
    different one with a name in use gets a number.
    """
    for template in templates:
        if not template["name"].strip():
            raise HomeAssistantError("A template in this file has no name")
        for entity_id in template["entities"]:
            if not valid_entity_id(entity_id):
                raise HomeAssistantError(
                    f'Template "{template["name"]}" has an invalid entity id: {entity_id}'
                )
    added = skipped = 0
    for template in templates:
        name = template["name"].strip()
        entities = sorted(set(template["entities"]))
        existing = list(store.templates.values())
        if any(t["name"] == name and t["entities"] == entities for t in existing):
            skipped += 1
            continue
        names = {t["name"] for t in existing}
        final_name, number = name, 2
        while final_name in names:
            final_name, number = f"{name} {number}", number + 1
        store.save_template(None, final_name, entities)
        added += 1
    ent_reg = er.async_get(hass)
    not_found = {
        entity_id
        for template in templates
        for entity_id in template["entities"]
        if hass.states.get(entity_id) is None and ent_reg.async_get(entity_id) is None
    }
    return {"added": added, "skipped": skipped, "not_found": sorted(not_found)}


def _homekit_entries(hass: HomeAssistant) -> list[ConfigEntry]:
    return [
        entry
        for entry in hass.config_entries.async_entries(HOMEKIT_DOMAIN)
        if entry.source != "ignore"
    ]


def _entry_value(entry: ConfigEntry, key: str, default: Any = None) -> Any:
    """Read an option, falling back to data for entries not started yet."""
    if key in entry.options:
        return entry.options[key]
    return entry.data.get(key, default)


def _mode(entry: ConfigEntry) -> str:
    return _entry_value(entry, "mode", MODE_BRIDGE)


def _clean_name(requested: str) -> str:
    """Return the name with only letters, digits and spaces, maybe empty.

    Same rule as the HomeKit config flow. Other alphabets become their closest
    plain letters, so Ayşe is Ayse.
    """
    return slugify(re.sub("['’]", "", requested), lowercase=False, separator=" ")


@callback
def available_name(
    hass: HomeAssistant, requested: str, ignore_entry_id: str | None = None
) -> str:
    """Return a bridge name that is valid for mDNS and not in use."""
    name = _clean_name(requested) or "HASS Bridge"
    in_use = {
        entry.data.get("name")
        for entry in _homekit_entries(hass)
        if entry.entry_id != ignore_entry_id
    }
    if name not in in_use:
        return name
    number = 2
    while f"{name} {number}" in in_use:
        number += 1
    return f"{name} {number}"


@callback
def needs_own_pairing(hass: HomeAssistant, entity_id: str) -> bool:
    """Return if HomeKit pairs this entity on its own, loaded or not."""
    if state := hass.states.get(entity_id):
        return state_needs_accessory_mode(state)
    attributes: dict[str, Any] = {}
    if reg := er.async_get(hass).async_get(entity_id):
        attributes = {
            "device_class": reg.device_class or reg.original_device_class,
            "supported_features": reg.supported_features,
        }
    return state_needs_accessory_mode(State(entity_id, "unavailable", attributes))


@callback
def not_loaded_entity_ids(hass: HomeAssistant, store: BridgeBuilderStore) -> set[str]:
    """Return entities a bridge or template names that have no state right now."""
    named = {
        entity_id
        for template in store.templates.values()
        for entity_id in template["entities"]
    }
    for entry in _homekit_entries(hass):
        named.update(_entry_value(entry, "filter", {}).get("include_entities", []))
    return {entity_id for entity_id in named if hass.states.get(entity_id) is None}


@callback
def bridged_entity_ids(hass: HomeAssistant, entry: ConfigEntry) -> dict[str, list[str]]:
    """Return the entities a HomeKit entry exposes, the way HomeKit decides it.

    Mirrors HomeKit.async_configure_accessories(): the filter, then hidden
    and diagnostic entities only when named explicitly, then entities that
    need their own pairing are left off bridges created by the config flow.
    """
    filter_conf = _entry_value(entry, "filter", {})
    entity_filter = FILTER_SCHEMA(deepcopy(filter_conf))
    exclude_accessory_mode = entry.data.get("exclude_accessory_mode", False)
    bridge_mode = _mode(entry) == MODE_BRIDGE
    ent_reg = er.async_get(hass)
    included: list[str] = []
    left_out: list[str] = []
    missing: list[str] = []
    for state in hass.states.async_all():
        entity_id = state.entity_id
        if not entity_filter(entity_id):
            continue
        if (
            (reg := ent_reg.async_get(entity_id))
            and (reg.entity_category is not None or reg.hidden_by is not None)
            and not entity_filter.explicitly_included(entity_id)
        ):
            continue
        if bridge_mode and exclude_accessory_mode and state_needs_accessory_mode(state):
            left_out.append(entity_id)
            continue
        included.append(entity_id)
    # An entity named in the list stays on it while it has no state, for example
    # a YAML entity whose integration failed to start. Saving must not lose it.
    for entity_id in filter_conf.get("include_entities", []):
        if hass.states.get(entity_id) is not None or not entity_filter(entity_id):
            continue
        if bridge_mode and exclude_accessory_mode and needs_own_pairing(hass, entity_id):
            left_out.append(entity_id)
            continue
        included.append(entity_id)
        missing.append(entity_id)
    if not bridge_mode:
        included = included[:1]
    return {
        "included": sorted(included),
        "left_out": sorted(left_out),
        "missing": sorted(missing),
    }


def _filter_is_exact_list(entry: ConfigEntry) -> bool:
    """Return True when the filter is a plain list of entities."""
    conf = _entry_value(entry, "filter", {})
    return bool(conf.get("include_entities")) and not any(
        conf.get(key)
        for key in (
            "include_domains",
            "exclude_domains",
            "exclude_entities",
            "include_entity_globs",
            "exclude_entity_globs",
        )
    )


@callback
def bridge_info(hass: HomeAssistant, entry: ConfigEntry, store: BridgeBuilderStore) -> dict:
    """Describe one HomeKit entry for the panel."""
    runtime = getattr(entry, "runtime_data", None)
    homekit = getattr(runtime, "homekit", None)
    driver = getattr(homekit, "driver", None)
    paired = bool(driver and driver.state.paired)
    pairing: dict[str, Any] | None = None
    if driver and not paired:
        pairing = {
            "pin": driver.state.pincode.decode(),
            "qr_svg": runtime.pairing_qr.decode() if runtime.pairing_qr else None,
        }
    accessory_count = None
    if homekit is not None and getattr(homekit, "bridge", None) is not None:
        # The bridge itself is not listed in bridge.accessories
        accessory_count = len(homekit.bridge.accessories)
    entities = bridged_entity_ids(hass, entry)
    return {
        "entry_id": entry.entry_id,
        "title": entry.title,
        "name": entry.data.get("name", entry.title),
        "port": entry.data.get("port"),
        "mode": _mode(entry),
        "yaml": entry.source == SOURCE_IMPORT,
        "running": entry.state is ConfigEntryState.LOADED,
        "paired": paired,
        "paired_users": len(driver.state.paired_clients) if driver else 0,
        "pairing": pairing,
        "accessory_count": accessory_count,
        "exact_list": _filter_is_exact_list(entry),
        "entities": entities["included"],
        "left_out": entities["left_out"],
        "missing": entities["missing"],
        "own_pairing_for": entities["included"][0]
        if _mode(entry) == MODE_ACCESSORY and entities["included"]
        else None,
        "linked_to": store.links.get(entry.entry_id),
        "entity_config": _entry_value(entry, "entity_config", {}),
    }


@callback
def list_bridges(hass: HomeAssistant, store: BridgeBuilderStore) -> list[dict]:
    """Describe every HomeKit entry."""
    # Forget links to entries that were deleted elsewhere
    entry_ids = {entry.entry_id for entry in _homekit_entries(hass)}
    stale = [acc for acc, bridge in store.links.items() if acc not in entry_ids or bridge not in entry_ids]
    for acc in stale:
        store.links.pop(acc)
    if stale:
        store.async_save()
    return [bridge_info(hass, entry, store) for entry in _homekit_entries(hass)]


def _split_selection(
    hass: HomeAssistant, entity_ids: list[str], already_paired: Iterable[str] = ()
) -> tuple[list[str], list[str]]:
    """Split a selection into bridge entities and own-pairing entities.

    An entity with no state stays in the selection. It cannot get a new own
    pairing until it loads, so that is refused rather than silently skipped.
    """
    paired = set(already_paired)
    on_bridge: list[str] = []
    own: list[str] = []
    for entity_id in sorted(set(entity_ids)):
        if entity_id in paired or needs_own_pairing(hass, entity_id):
            own.append(entity_id)
        else:
            on_bridge.append(entity_id)
    not_loaded = [
        entity_id
        for entity_id in own
        if entity_id not in paired and hass.states.get(entity_id) is None
    ]
    if not_loaded:
        raise HomeAssistantError(
            f"{', '.join(not_loaded)} needs its own pairing but is not loaded right "
            "now. Remove it from the selection, or try again once it is back."
        )
    return on_bridge, own


def _exact_filter(entity_ids: list[str]) -> dict[str, list[str]]:
    return {
        "include_domains": [],
        "include_entities": sorted(entity_ids),
        "exclude_domains": [],
        "exclude_entities": [],
    }


def _get_bridge(hass: HomeAssistant, entry_id: str) -> ConfigEntry:
    entry = hass.config_entries.async_get_entry(entry_id)
    if entry is None or entry.domain != HOMEKIT_DOMAIN:
        raise HomeAssistantError("That HomeKit bridge no longer exists")
    if entry.source == SOURCE_IMPORT:
        raise HomeAssistantError(
            "This bridge is set up in configuration.yaml; change it there"
        )
    return entry


async def _async_wait_started(entry: ConfigEntry, timeout: float = 30) -> None:
    """Wait until a new HomeKit entry has finished starting.

    Changing the entry reloads it, and a reload while the first start is
    still running leaves two servers fighting over the same port.
    """
    for _ in range(int(timeout * 10)):
        if entry.state in (
            ConfigEntryState.SETUP_ERROR,
            ConfigEntryState.SETUP_RETRY,
            ConfigEntryState.NOT_LOADED,
        ):
            return
        homekit = getattr(getattr(entry, "runtime_data", None), "homekit", None)
        if homekit is not None and homekit.status in (STATUS_RUNNING, STATUS_STOPPED):
            return
        await asyncio.sleep(0.1)
    _LOGGER.warning("HomeKit entry %s did not finish starting in time", entry.title)


async def _async_run_flow(
    hass: HomeAssistant, context: dict[str, Any], data: dict[str, Any] | None, steps: list[dict]
) -> ConfigEntry:
    """Run a HomeKit config flow to the end and return the new entry."""
    flow = hass.config_entries.flow
    result = await flow.async_init(HOMEKIT_DOMAIN, context=context, data=data)
    for user_input in steps:
        if result["type"] != FlowResultType.FORM:
            break
        result = await flow.async_configure(result["flow_id"], user_input)
    if result["type"] != FlowResultType.CREATE_ENTRY:
        if result["type"] == FlowResultType.FORM:
            flow.async_abort(result["flow_id"])
        raise HomeAssistantError(
            f"HomeKit did not create the entry ({result.get('reason') or result['type']})"
        )
    return result["result"]


async def _async_create_own_pairing(
    hass: HomeAssistant, store: BridgeBuilderStore, bridge: ConfigEntry, entity_id: str
) -> ConfigEntry:
    """Create an accessory-mode entry for one entity, linked to a bridge."""
    port = async_find_next_available_port(hass, DEFAULT_CONFIG_FLOW_PORT)
    entry = await _async_run_flow(
        hass,
        {"source": "accessory"},
        {"entity_id": entity_id, "port": port},
        [],
    )
    state = hass.states.get(entity_id)
    friendly = state.name if state else entity_id
    name = available_name(hass, f"{friendly} {bridge.data.get('name', '')}")
    await _async_wait_started(entry)
    hass.config_entries.async_update_entry(
        entry,
        title=f"{name}:{entry.data['port']}",
        data={**entry.data, "name": name},
    )
    store.links[entry.entry_id] = bridge.entry_id
    store.async_save()
    return entry


async def async_create_bridge(
    hass: HomeAssistant, store: BridgeBuilderStore, name: str, entity_ids: list[str]
) -> str:
    """Create a new HomeKit bridge with exactly these entities."""
    on_bridge, own = _split_selection(hass, entity_ids)
    if len(on_bridge) > MAX_BRIDGE_ACCESSORIES:
        raise HomeAssistantError(
            f"A bridge can hold at most {MAX_BRIDGE_ACCESSORIES} accessories"
        )
    # The HomeKit config flow names the bridge itself; pick no domains so it
    # starts empty, then set the name and the exact entity list.
    entry = await _async_run_flow(
        hass, {"source": SOURCE_USER}, None, [{"include_domains": []}, {}]
    )
    final_name = available_name(hass, name)
    options = deepcopy(dict(entry.options))
    options["filter"] = _exact_filter(on_bridge)
    options.setdefault("mode", MODE_BRIDGE)
    data = {k: v for k, v in entry.data.items() if k not in ("filter", "mode")}
    data["name"] = final_name
    await _async_wait_started(entry)
    hass.config_entries.async_update_entry(
        entry,
        title=f"{final_name}:{entry.data['port']}",
        data=data,
        options=options,
    )
    for entity_id in own:
        await _async_create_own_pairing(hass, store, entry, entity_id)
    return entry.entry_id


@callback
def _name_update(hass: HomeAssistant, entry: ConfigEntry, requested: str) -> dict[str, Any]:
    """Return what to change on an entry to rename it, nothing if it is the same.

    HomeKit keeps pairings under the entry id and paired devices find the bridge
    by its own id, so a new name does not break them.
    """
    if not _clean_name(requested):
        raise HomeAssistantError("The name needs at least one letter or number")
    name = available_name(hass, requested, entry.entry_id)
    if name == entry.data.get("name"):
        return {}
    return {
        "title": f"{name}:{entry.data['port']}",
        "data": {**entry.data, "name": name},
    }


async def _async_rename_linked(
    hass: HomeAssistant, store: BridgeBuilderStore, entry: ConfigEntry, old_name: str
) -> None:
    """Carry a new bridge name over to its own-pairing entries.

    They are named "<device> <bridge>". One the user renamed is left alone.
    """
    new_name = entry.data["name"]
    suffix = f" {old_name}"
    for acc_id, bridge_id in list(store.links.items()):
        acc = hass.config_entries.async_get_entry(acc_id)
        if bridge_id != entry.entry_id or acc is None:
            continue
        acc_name = acc.data.get("name", "")
        if not acc_name.endswith(suffix):
            continue
        requested = f"{acc_name.removesuffix(suffix)} {new_name}"
        if update := _name_update(hass, acc, requested):
            await _async_wait_started(acc)
            hass.config_entries.async_update_entry(acc, **update)


async def async_rename_bridge(
    hass: HomeAssistant, store: BridgeBuilderStore, entry_id: str, name: str
) -> None:
    """Rename a bridge, leaving what it shares and how it decides that alone."""
    entry = _get_bridge(hass, entry_id)
    if _mode(entry) != MODE_BRIDGE:
        raise HomeAssistantError("Only bridges can be edited here")
    update = _name_update(hass, entry, name)
    if not update:
        return
    old_name = entry.data.get("name", "")
    await _async_wait_started(entry)
    hass.config_entries.async_update_entry(entry, **update)
    await _async_rename_linked(hass, store, entry, old_name)


async def async_set_bridge_entities(
    hass: HomeAssistant,
    store: BridgeBuilderStore,
    entry_id: str,
    entity_ids: list[str],
    name: str | None = None,
) -> None:
    """Replace a bridge's entities with exactly this list, and maybe its name.

    Both go in one update, because each update restarts the bridge.
    """
    entry = _get_bridge(hass, entry_id)
    if _mode(entry) != MODE_BRIDGE:
        raise HomeAssistantError("Only bridges can be edited here")
    update = _name_update(hass, entry, name) if name is not None else {}
    old_name = entry.data.get("name", "")
    exclude_accessory_mode = entry.data.get("exclude_accessory_mode", False)
    linked = {
        acc_id: hass.config_entries.async_get_entry(acc_id)
        for acc_id, bridge_id in list(store.links.items())
        if bridge_id == entry_id
    }
    have = {}
    for acc_id, acc in linked.items():
        if acc is None:
            store.links.pop(acc_id, None)
            continue
        include = _entry_value(acc, "filter", {}).get("include_entities", [])
        if include:
            have[include[0]] = acc
    if exclude_accessory_mode:
        on_bridge, own = _split_selection(hass, entity_ids, have)
    else:
        # Older bridges keep locks and TVs on the bridge itself
        on_bridge, own = sorted(set(entity_ids)), []
    if len(on_bridge) > MAX_BRIDGE_ACCESSORIES:
        raise HomeAssistantError(
            f"A bridge can hold at most {MAX_BRIDGE_ACCESSORIES} accessories"
        )

    options = deepcopy(dict(entry.options))
    for key in ("filter", "mode", "entity_config", "devices"):
        if key not in options and key in entry.data:
            options[key] = deepcopy(entry.data[key])
    options["filter"] = _exact_filter(on_bridge)
    # Keep per-entity settings only for entities that stay
    if entity_config := options.get("entity_config"):
        options["entity_config"] = {
            k: v for k, v in entity_config.items() if k in on_bridge
        }
    if options != dict(entry.options):
        update["options"] = options
    if update:
        await _async_wait_started(entry)
        hass.config_entries.async_update_entry(entry, **update)

    for entity_id, acc in have.items():
        if entity_id not in own:
            store.links.pop(acc.entry_id, None)
            await hass.config_entries.async_remove(acc.entry_id)
    # After the removals and before the additions: new ones get the new name anyway
    if "data" in update:
        await _async_rename_linked(hass, store, entry, old_name)
    for entity_id in own:
        if entity_id not in have:
            await _async_create_own_pairing(hass, store, entry, entity_id)
    store.async_save()


async def async_delete_bridge(
    hass: HomeAssistant, store: BridgeBuilderStore, entry_id: str
) -> None:
    """Delete a bridge and the own-pairing entries made for it."""
    entry = _get_bridge(hass, entry_id)
    for acc_id, bridge_id in list(store.links.items()):
        if bridge_id == entry_id:
            store.links.pop(acc_id)
            if hass.config_entries.async_get_entry(acc_id):
                await hass.config_entries.async_remove(acc_id)
    store.links.pop(entry_id, None)
    store.async_save()
    await hass.config_entries.async_remove(entry.entry_id)


@callback
def async_reset_pairing(hass: HomeAssistant, entry_id: str) -> None:
    """Forget every Apple Home this bridge is paired with, showing a new code."""
    entry = _get_bridge(hass, entry_id)
    runtime = getattr(entry, "runtime_data", None)
    homekit = getattr(runtime, "homekit", None)
    if homekit is None or homekit.driver is None:
        raise HomeAssistantError("The bridge is not running")
    homekit.async_unpair()
