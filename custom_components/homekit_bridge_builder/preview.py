"""Predict how an entity appears in Apple Home through the HomeKit Bridge.

This mirrors get_accessory() in homeassistant/components/homekit/accessories.py
without creating any accessory, so the panel can preview a bridge before it
exists. Keep the branches in the same order as get_accessory().
"""

from typing import Any

from homeassistant.components.homekit.util import (
    get_media_player_features,
    state_needs_accessory_mode,
)
from homeassistant.const import (
    ATTR_DEVICE_CLASS,
    ATTR_SUPPORTED_FEATURES,
    ATTR_UNIT_OF_MEASUREMENT,
    LIGHT_LUX,
    PERCENTAGE,
    UnitOfTemperature,
)
from homeassistant.core import State

try:
    from homeassistant.components.homekit.accessories import (
        climate_supports_heater_cooler,
    )
except ImportError:  # Older Home Assistant without the HeaterCooler routing

    def climate_supports_heater_cooler(state: State) -> bool:
        """Report no HeaterCooler support."""
        return False


from homeassistant.components.cover import CoverEntityFeature
from homeassistant.components.lawn_mower import LawnMowerEntityFeature
from homeassistant.components.remote import RemoteEntityFeature
from homeassistant.components.vacuum import VacuumEntityFeature

_COVER_OPEN = CoverEntityFeature.OPEN
_COVER_CLOSE = CoverEntityFeature.CLOSE
_COVER_SET_POSITION = CoverEntityFeature.SET_POSITION
_COVER_SET_TILT_POSITION = CoverEntityFeature.SET_TILT_POSITION
_VACUUM_START = VacuumEntityFeature.START
_MOWER_START = LawnMowerEntityFeature.START_MOWING
_MOWER_DOCK = LawnMowerEntityFeature.DOCK
_REMOTE_ACTIVITY = RemoteEntityFeature.ACTIVITY

# Binary sensor device class -> (kind, HomeKit service)
_BINARY_SENSOR_KINDS = {
    "co": ("co", "Carbon Monoxide Sensor"),
    "gas": ("co", "Carbon Monoxide Sensor"),
    "door": ("contact", "Contact Sensor"),
    "garage_door": ("contact", "Contact Sensor"),
    "opening": ("contact", "Contact Sensor"),
    "window": ("contact", "Contact Sensor"),
    "moisture": ("leak", "Leak Sensor"),
    "motion": ("motion", "Motion Sensor"),
    "occupancy": ("occupancy", "Occupancy Sensor"),
    "smoke": ("smoke", "Smoke Sensor"),
}

_SENSOR_BY_CLASS = {
    "pm10": ("air", "Air Quality Sensor (PM10)"),
    "pm25": ("air", "Air Quality Sensor (PM2.5)"),
    "nitrogen_dioxide": ("air", "Air Quality Sensor (NO2)"),
    "volatile_organic_compounds": ("air", "Air Quality Sensor (VOC)"),
    "ozone": ("air", "Air Quality Sensor (Ozone)"),
    "sulphur_dioxide": ("air", "Air Quality Sensor (SO2)"),
    "gas": ("air", "Air Quality Sensor"),
    "co": ("co", "Carbon Monoxide Sensor"),
    "carbon_monoxide": ("co", "Carbon Monoxide Sensor"),
    "co2": ("co2", "Carbon Dioxide Sensor"),
    "carbon_dioxide": ("co2", "Carbon Dioxide Sensor"),
}

_SWITCH_TYPES = {
    "faucet": ("faucet", "Faucet"),
    "outlet": ("outlet", "Outlet"),
    "shower": ("shower", "Shower"),
    "sprinkler": ("sprinkler", "Sprinkler"),
    "switch": ("switch", "Switch"),
    "valve": ("valve", "Valve"),
}


def _result(kind: str | None, service: str | None, note: str | None = None):
    return {"kind": kind, "service": service, "note": note}


def classify(state: State, config: dict[str, Any] | None = None) -> dict[str, Any]:
    """Return how the HomeKit Bridge would expose this entity.

    kind is the tile style the panel draws (None when unsupported),
    service is the HomeKit accessory name Apple Home shows in settings,
    and needs_own_pairing is set for entities the bridge leaves out
    because they must be paired on their own (accessory mode).
    """
    config = config or {}
    domain = state.domain
    attrs = state.attributes
    features = attrs.get(ATTR_SUPPORTED_FEATURES, 0) or 0
    device_class = attrs.get(ATTR_DEVICE_CLASS)
    res = _result(None, None)

    if domain == "alarm_control_panel":
        res = _result("security", "Security System")
    elif domain == "binary_sensor":
        if device_class in _BINARY_SENSOR_KINDS:
            res = _result(*_BINARY_SENSOR_KINDS[device_class])
        else:
            res = _result(
                "occupancy",
                "Occupancy Sensor",
                "Sensors without a matching HomeKit type appear as occupancy sensors.",
            )
    elif domain in ("device_tracker", "person"):
        res = _result("occupancy", "Occupancy Sensor", "Home means occupied.")
    elif domain == "climate":
        ctype = config.get("type")
        if ctype == "heater_cooler" or (
            ctype is None and climate_supports_heater_cooler(state)
        ):
            res = _result("heatercooler", "Heater Cooler")
        else:
            res = _result("thermostat", "Thermostat")
    elif domain == "cover":
        if device_class in ("garage", "gate") and features & (
            _COVER_OPEN | _COVER_CLOSE
        ):
            res = _result("garage", "Garage Door")
        elif device_class == "window" and features & _COVER_SET_POSITION:
            res = _result("window", "Window")
        elif device_class == "door" and features & _COVER_SET_POSITION:
            res = _result("door", "Door")
        elif features & _COVER_SET_POSITION:
            res = _result("blinds", "Window Covering")
        elif features & (_COVER_OPEN | _COVER_CLOSE):
            res = _result("blinds", "Window Covering (open/close only)")
        elif features & _COVER_SET_TILT_POSITION:
            res = _result("blinds", "Window Covering (tilt)")
    elif domain == "fan":
        if config.get("type") == "air_purifier":
            res = _result("purifier", "Air Purifier")
        else:
            res = _result("fan", "Fan")
    elif domain == "humidifier":
        res = _result("humidifier", "Humidifier-Dehumidifier")
    elif domain == "light":
        res = _result("light", "Lightbulb")
    elif domain == "lock":
        res = _result("lock", "Lock")
    elif domain == "media_player":
        if device_class == "receiver":
            res = _result("tv", "Receiver (TV accessory)")
        elif device_class in ("tv", "projector"):
            res = _result("tv", "Television")
        elif get_media_player_features(state):
            res = _result(
                "switch",
                "Switches",
                "Each supported action (on/off, play/pause, mute) becomes a switch.",
            )
    elif domain == "sensor":
        unit = attrs.get(ATTR_UNIT_OF_MEASUREMENT)
        eid = state.entity_id
        if device_class == "temperature" or unit in (
            UnitOfTemperature.CELSIUS,
            UnitOfTemperature.FAHRENHEIT,
        ):
            res = _result("temperature", "Temperature Sensor")
        elif device_class == "humidity" and unit == PERCENTAGE:
            res = _result("humidity", "Humidity Sensor")
        elif device_class in _SENSOR_BY_CLASS:
            res = _result(*_SENSOR_BY_CLASS[device_class])
        elif device_class == "illuminance" or unit == LIGHT_LUX:
            res = _result("lightlevel", "Light Sensor")
        elif "pm10" in eid or "pm25" in eid or "gas" in eid:
            res = _result("air", "Air Quality Sensor")
        elif "co2" in eid:
            res = _result("co2", "Carbon Dioxide Sensor")
    elif domain == "switch":
        if (stype := config.get("type")) in _SWITCH_TYPES:
            res = _result(*_SWITCH_TYPES[stype])
        elif device_class == "outlet":
            res = _result("outlet", "Outlet")
        else:
            res = _result("switch", "Switch")
    elif domain == "valve":
        res = _result("valve", "Valve")
    elif domain == "vacuum" and features & _VACUUM_START:
        res = _result("vacuum", "Switch (start / dock)")
    elif (
        domain == "lawn_mower"
        and features & _MOWER_DOCK
        and features & _MOWER_START
    ):
        res = _result("mower", "Switch (mow / dock)")
    elif domain == "remote" and features & _REMOTE_ACTIVITY:
        res = _result("tv", "Television (activities as inputs)")
    elif domain in ("automation", "input_boolean", "remote"):
        res = _result("switch", "Switch")
    elif domain in ("button", "input_button", "scene", "script"):
        res = _result(
            "momentary", "Switch", "Turns itself off again a moment after you tap it."
        )
    elif domain in ("input_select", "select"):
        res = _result(
            "select", "Switches", "Each option becomes its own switch in Apple Home."
        )
    elif domain == "water_heater":
        res = _result("thermostat", "Thermostat (water heater)")
    elif domain == "camera":
        res = _result("camera", "Camera")

    res["supported"] = res["kind"] is not None
    res["needs_own_pairing"] = res["supported"] and state_needs_accessory_mode(state)
    if res["needs_own_pairing"]:
        res["note"] = (
            "HomeKit needs this one paired on its own, so it gets its own code "
            "next to the bridge's."
        )
    return res
