// Bridge Builder panel: build HomeKit bridges with a room-by-room picker
// and a preview of how the result looks in Apple Home.
// Plain web component, no build step. Talks to the homekit_bridge_builder/*
// websocket commands.

const MAX_ACCESSORIES = 149;
const TEMPLATE_FILE_TYPE = "bridge_builder_templates";
const TEMPLATE_FILE_VERSION = 1;

const ICONS = {
  light: ["mdi:lightbulb", "mdi:lightbulb-outline"],
  switch: ["mdi:toggle-switch", "mdi:toggle-switch-off-outline"],
  outlet: ["mdi:power-socket-eu", "mdi:power-socket-eu"],
  momentary: ["mdi:gesture-tap-button", "mdi:gesture-tap-button"],
  select: ["mdi:format-list-bulleted", "mdi:format-list-bulleted"],
  fan: ["mdi:fan", "mdi:fan-off"],
  purifier: ["mdi:air-purifier", "mdi:air-purifier-off"],
  humidifier: ["mdi:air-humidifier", "mdi:air-humidifier-off"],
  thermostat: ["mdi:thermostat", "mdi:thermostat"],
  heatercooler: ["mdi:hvac", "mdi:hvac-off"],
  blinds: ["mdi:blinds-horizontal", "mdi:blinds-horizontal-closed"],
  garage: ["mdi:garage-open", "mdi:garage"],
  window: ["mdi:window-open-variant", "mdi:window-closed-variant"],
  door: ["mdi:door-open", "mdi:door-closed"],
  lock: ["mdi:lock-open-variant", "mdi:lock"],
  security: ["mdi:shield-home", "mdi:shield-off-outline"],
  tv: ["mdi:television", "mdi:television-off"],
  camera: ["mdi:cctv", "mdi:cctv"],
  valve: ["mdi:valve-open", "mdi:valve-closed"],
  faucet: ["mdi:faucet", "mdi:faucet"],
  shower: ["mdi:shower-head", "mdi:shower-head"],
  sprinkler: ["mdi:sprinkler-variant", "mdi:sprinkler-variant"],
  vacuum: ["mdi:robot-vacuum", "mdi:robot-vacuum-off"],
  mower: ["mdi:robot-mower", "mdi:robot-mower-outline"],
  temperature: ["mdi:thermometer", "mdi:thermometer"],
  humidity: ["mdi:water-percent", "mdi:water-percent"],
  air: ["mdi:air-filter", "mdi:air-filter"],
  co: ["mdi:molecule-co", "mdi:molecule-co"],
  co2: ["mdi:molecule-co2", "mdi:molecule-co2"],
  lightlevel: ["mdi:brightness-5", "mdi:brightness-5"],
  contact: ["mdi:door-open", "mdi:door-closed"],
  motion: ["mdi:motion-sensor", "mdi:motion-sensor-off"],
  occupancy: ["mdi:account", "mdi:account-outline"],
  leak: ["mdi:water-alert", "mdi:water-off-outline"],
  smoke: ["mdi:smoke-detector-alert", "mdi:smoke-detector"],
};

// Tiles Apple Home shows as sensors rather than controls
const SENSOR_KINDS = new Set([
  "temperature", "humidity", "air", "co", "co2", "lightlevel",
  "contact", "motion", "occupancy", "leak", "smoke",
]);

const ON_STATES = new Set([
  "on", "open", "opening", "unlocked", "unlocking", "playing", "home",
  "cleaning", "mowing", "heat", "cool", "heat_cool", "auto", "dry", "fan_only",
  "armed_home", "armed_away", "armed_night", "armed_vacation",
  "armed_custom_bypass", "triggered",
]);

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);

function fmtNum(v, digits = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits).replace(/\.0+$/, "") : null;
}

// What Apple Home would print under the accessory name
function tileStatus(kind, st) {
  if (!st) return { text: "Not loaded", active: false, dead: true };
  const s = st.state;
  const a = st.attributes || {};
  if (s === "unavailable" || s === "unknown" && !SENSOR_KINDS.has(kind)) {
    return { text: "No Response", active: false, dead: true };
  }
  const on = ON_STATES.has(s);
  switch (kind) {
    case "light":
      if (!on) return { text: "Off", active: false };
      return {
        text: a.brightness != null ? `${Math.round((a.brightness / 255) * 100)}%` : "On",
        active: true,
      };
    case "momentary":
      return { text: "Off", active: false };
    case "select":
      return { text: s, active: true };
    case "thermostat":
    case "heatercooler": {
      const cur = fmtNum(a.current_temperature, 1);
      if (s === "off") return { text: cur ? `${cur}° · Off` : "Off", active: false };
      const target = fmtNum(a.temperature, 1);
      const mode = { heat: "Heat", cool: "Cool", heat_cool: "Auto", auto: "Auto", dry: "Dry", fan_only: "Fan" }[s] || s;
      return { text: `${cur ? cur + "°" : ""}${target ? ` · ${mode} to ${target}°` : ` · ${mode}`}`, active: true };
    }
    case "blinds":
      if (a.current_position != null) {
        const p = a.current_position;
        return { text: p === 0 ? "Closed" : p === 100 ? "Open" : `${p}% Open`, active: p > 0 };
      }
      return { text: on ? "Open" : "Closed", active: on };
    case "garage":
    case "window":
    case "door":
      return { text: on ? "Open" : "Closed", active: on };
    case "lock":
      return { text: s === "locked" ? "Locked" : s === "jammed" ? "Jammed" : "Unlocked", active: s !== "locked" };
    case "security": {
      const m = { disarmed: "Off", armed_home: "Home", armed_away: "Away", armed_night: "Night", triggered: "Triggered" };
      return { text: m[s] || s, active: s !== "disarmed" };
    }
    case "camera":
      return { text: "Camera", active: true };
    case "temperature": {
      const v = fmtNum(s, 1);
      return { text: v ? `${v}°` : "—", active: false, value: true };
    }
    case "humidity": {
      const v = fmtNum(s);
      return { text: v ? `${v}%` : "—", active: false, value: true };
    }
    case "lightlevel": {
      const v = fmtNum(s);
      return { text: v ? `${v} lx` : "—", active: false, value: true };
    }
    case "air":
    case "co":
    case "co2": {
      if (st.entity_id.startsWith("binary_sensor.")) {
        return { text: on ? "Detected" : "Normal", active: on };
      }
      const v = fmtNum(s);
      return { text: v ? `${v} ${a.unit_of_measurement || ""}`.trim() : "—", active: false, value: true };
    }
    case "contact":
      return { text: on ? "Open" : "Closed", active: on };
    case "motion":
      return { text: on ? "Detected" : "Not Detected", active: on };
    case "occupancy":
      return { text: on ? "Detected" : "Not Detected", active: on };
    case "leak":
      return { text: on ? "Leak Detected" : "No Leak", active: on };
    case "smoke":
      return { text: on ? "Smoke Detected" : "No Smoke", active: on };
    default:
      return { text: on ? "On" : "Off", active: on };
  }
}

// Apple Home hides the room name at the start of an accessory name
function tileName(name, roomName) {
  if (roomName && name.toLowerCase().startsWith(roomName.toLowerCase() + " ")) {
    const rest = name.slice(roomName.length + 1).trim();
    if (rest) return rest;
  }
  return name;
}

const STYLES = `
:host { display:block; height:100%; background:var(--primary-background-color); color:var(--primary-text-color);
  font-family:var(--paper-font-body1_-_font-family, Roboto, system-ui, sans-serif); }
* { box-sizing:border-box; }
.toolbar { display:flex; align-items:center; gap:8px; height:56px; padding:0 12px; background:var(--app-header-background-color, var(--primary-color));
  color:var(--app-header-text-color, #fff); position:sticky; top:0; z-index:5; }
.toolbar h1 { font-size:20px; font-weight:400; margin:0 0 0 4px; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.toolbar button.tb { background:none; border:0; color:inherit; font:inherit; font-size:14px; padding:8px 12px; border-radius:6px; cursor:pointer; }
.toolbar button.tb:hover { background:rgba(255,255,255,.12); }
.content { padding:16px; max-width:1500px; margin:0 auto; }
button.btn { font:inherit; font-size:14px; font-weight:500; border-radius:8px; padding:8px 14px; cursor:pointer; border:1px solid var(--divider-color);
  background:var(--card-background-color); color:var(--primary-text-color); }
button.btn:hover { border-color:var(--primary-color); }
button.btn.primary { background:var(--primary-color); color:var(--text-primary-color, #fff); border-color:var(--primary-color); }
button.btn.danger { color:var(--error-color, #db4437); }
button.btn:disabled { opacity:.5; cursor:default; }
button.link { background:none; border:0; color:var(--primary-color); font:inherit; font-size:13px; cursor:pointer; padding:2px 4px; }
.row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.muted { color:var(--secondary-text-color); }
.small { font-size:12px; }
.card { background:var(--card-background-color); border-radius:var(--ha-card-border-radius, 12px); border:1px solid var(--divider-color); padding:16px; }
.grid-cards { display:grid; grid-template-columns:repeat(auto-fill, minmax(330px, 1fr)); gap:14px; margin-top:12px; }
.bridge h3 { margin:0; font-size:17px; font-weight:500; display:flex; gap:8px; align-items:center; }
.badge { display:inline-flex; align-items:center; gap:4px; font-size:12px; font-weight:500; padding:2px 8px; border-radius:99px; background:var(--secondary-background-color); color:var(--secondary-text-color); }
.badge.ok { background:rgba(67,160,71,.15); color:var(--success-color, #43a047); }
.badge.wait { background:rgba(255,152,0,.15); color:var(--warning-color, #ff9800); }
.badge.err { background:rgba(219,68,55,.15); color:var(--error-color, #db4437); }
.stats { display:flex; gap:16px; margin:10px 0; font-size:13px; }
.stats b { font-size:18px; font-weight:500; display:block; }
.sub { margin-top:10px; padding-top:10px; border-top:1px solid var(--divider-color); font-size:13px; display:flex; flex-direction:column; gap:6px; }
.section-title { font-size:15px; font-weight:500; margin:22px 0 4px; }
.empty { padding:28px; text-align:center; }

/* editor */
.editor { display:grid; grid-template-columns:minmax(0, 1.05fr) minmax(0, 1fr); gap:16px; align-items:start; }
.editor.narrow { grid-template-columns:minmax(0,1fr); }
.top { display:flex; flex-wrap:wrap; gap:10px; align-items:end; margin-bottom:14px; }
.field { display:flex; flex-direction:column; gap:4px; flex:1 1 240px; }
.field label { font-size:12px; color:var(--secondary-text-color); }
input[type=text], input[type=search], select { font:inherit; font-size:15px; padding:9px 11px; border-radius:8px; border:1px solid var(--divider-color);
  background:var(--card-background-color); color:var(--primary-text-color); width:100%; }
input:focus, select:focus { outline:2px solid var(--primary-color); outline-offset:-1px; }
.picker { padding:0; overflow:hidden; }
.pick-head { padding:12px; border-bottom:1px solid var(--divider-color); display:flex; flex-direction:column; gap:10px; }
#list { max-height:calc(100vh - 330px); min-height:260px; overflow:auto; }
.chips { display:flex; gap:6px; flex-wrap:wrap; }
.chip { font:inherit; font-size:12.5px; padding:4px 10px; border-radius:99px; border:1px solid var(--divider-color); background:none; color:var(--primary-text-color); cursor:pointer; }
.chip.on { background:var(--primary-color); color:var(--text-primary-color, #fff); border-color:var(--primary-color); }
.count { display:flex; justify-content:space-between; font-size:13px; }
.meter { height:6px; border-radius:3px; background:var(--secondary-background-color); overflow:hidden; }
.meter i { display:block; height:100%; background:var(--primary-color); }
.meter.over i { background:var(--error-color, #db4437); }
.area { border-bottom:1px solid var(--divider-color); }
.area-h { display:flex; align-items:center; gap:10px; padding:10px 12px; cursor:pointer; user-select:none; background:var(--secondary-background-color); }
.area-h .nm { flex:1; font-weight:500; font-size:14px; }
.area-h .ct { font-size:12px; color:var(--secondary-text-color); }
.area-h .chev { transition:transform .15s; color:var(--secondary-text-color); }
.area.closed .chev { transform:rotate(-90deg); }
.area.closed .items { display:none; }
.item { display:grid; grid-template-columns:22px 28px minmax(0,1fr) auto; gap:10px; align-items:center; padding:7px 12px; cursor:pointer; }
.item:hover { background:var(--secondary-background-color); }
.item.unsup { opacity:.45; cursor:default; }
.item .nm { font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.item .id { font-size:11.5px; color:var(--secondary-text-color); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.item ha-icon { --mdc-icon-size:20px; color:var(--state-icon-color, #44739e); }
.pill { font-size:11px; padding:2px 7px; border-radius:6px; background:var(--secondary-background-color); color:var(--secondary-text-color); white-space:nowrap; }
.pill.own { background:rgba(255,152,0,.15); color:var(--warning-color, #ff9800); }
input[type=checkbox] { width:17px; height:17px; accent-color:var(--primary-color); margin:0; cursor:pointer; }
.actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:14px; }
.warn { margin-top:10px; padding:10px 12px; border-radius:8px; background:rgba(255,152,0,.12); font-size:13px; }

/* Apple Home preview */
.phone { position:sticky; top:72px; border-radius:28px; overflow:hidden; border:1px solid var(--divider-color);
  background:linear-gradient(160deg, #f4c58a 0%, #e98d6b 32%, #8b6fb0 70%, #4a5d9c 100%); color:#fff; min-height:520px; }
.phone.dark { background:linear-gradient(160deg, #3a2f4b 0%, #22263d 55%, #14161f 100%); }
.ph-top { padding:18px 18px 6px; display:flex; align-items:baseline; justify-content:space-between; gap:8px; }
.ph-top h2 { margin:0; font-size:26px; font-weight:700; letter-spacing:-.02em; font-family:-apple-system, "SF Pro Display", system-ui, sans-serif; }
.ph-top .mode { font-size:12px; background:rgba(255,255,255,.2); border:0; color:#fff; border-radius:99px; padding:4px 10px; cursor:pointer; }
.ph-scroll { max-height:calc(100vh - 170px); overflow:auto; padding:0 14px 18px; }
.ph-sum { display:flex; gap:8px; overflow-x:auto; padding:6px 4px 10px; }
.ph-sum span { flex:none; font-size:12px; font-weight:600; background:rgba(255,255,255,.22); backdrop-filter:blur(10px); border-radius:99px; padding:6px 11px; }
.ph-room { font-family:-apple-system, "SF Pro Text", system-ui, sans-serif; font-size:17px; font-weight:700; margin:16px 4px 8px; display:flex; justify-content:space-between; }
.ph-room small { font-size:12px; font-weight:500; opacity:.8; }
.ph-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:9px; }
.tile { display:flex; align-items:center; gap:10px; padding:10px 11px; border-radius:16px; min-height:62px; cursor:pointer;
  background:rgba(255,255,255,.28); backdrop-filter:blur(14px); -webkit-backdrop-filter:blur(14px); color:#fff; border:0; text-align:left; font:inherit;
  font-family:-apple-system, "SF Pro Text", system-ui, sans-serif; transition:transform .1s; }
.phone.dark .tile { background:rgba(255,255,255,.12); }
.tile:hover { transform:scale(1.02); }
.phone .tile.on { background:rgba(255,255,255,.94); color:#1c1c1e; }
.tile .ic { flex:none; width:34px; height:34px; border-radius:50%; display:grid; place-items:center; background:rgba(255,255,255,.22); }
.tile.on .ic { background:var(--tint, #f7b733); color:#fff; }
.tile .ic ha-icon { --mdc-icon-size:20px; }
.tile .tx { min-width:0; }
.tile .tn { font-size:13.5px; font-weight:600; line-height:1.15; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.tile .ts { font-size:12.5px; opacity:.75; margin-top:1px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.tile.on .ts { opacity:.6; }
.tile.dead .ts { color:#ffd0d0; opacity:1; }
.tile.on.dead .ts { color:#c0392b; }
.tile.sensor .ic { background:none; }
.tile .val { font-size:15px; font-weight:700; }
.tile.wide { grid-column:1 / -1; min-height:120px; align-items:flex-end; background:linear-gradient(0deg, rgba(0,0,0,.55), rgba(0,0,0,.15)), rgba(40,40,50,.6); }
.ph-own { margin-top:18px; padding:12px; border-radius:16px; background:rgba(0,0,0,.22); font-size:12.5px; line-height:1.4; }
.ph-empty { padding:60px 20px; text-align:center; opacity:.85; font-size:14px; }
.detail { position:fixed; inset:0; background:rgba(0,0,0,.45); display:grid; place-items:center; z-index:20; padding:16px; }
.detail .card { max-width:460px; width:100%; max-height:90vh; overflow:auto; }
.detail h3 { margin:0 0 6px; }
.qr { display:flex; gap:16px; align-items:center; flex-wrap:wrap; margin:10px 0; }
.qr .code { background:#fff; border-radius:10px; padding:8px; line-height:0; }
.qr .code svg { width:150px; height:150px; }
.pin { font-family:ui-monospace, Menlo, Consolas, monospace; font-size:24px; letter-spacing:.06em; }
.spinner { width:28px; height:28px; border:3px solid var(--divider-color); border-top-color:var(--primary-color); border-radius:50%; animation:spin 1s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
.toast { position:fixed; left:50%; bottom:20px; transform:translateX(-50%); background:#323232; color:#fff; padding:10px 16px; border-radius:8px; font-size:14px; z-index:30; }
@media (max-width: 900px) { .editor { grid-template-columns:minmax(0,1fr); } .phone { position:static; } .ph-scroll { max-height:none; } }
`;

class BridgeBuilderPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._view = "list"; // list | editor
    this._bridges = [];
    this._templates = [];
    this._catalog = null;
    this._ed = null; // editor state
    this._previewDark = matchMedia("(prefers-color-scheme: dark)").matches;
    this._loaded = false;
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) {
      this._renderShell();
      this._load();
      return;
    }
    if (this._menuBtn) this._menuBtn.hass = hass;
    // Live state in the preview, at most every 2 s
    if (this._view === "editor" && !this._previewTimer) {
      this._previewTimer = setTimeout(() => {
        this._previewTimer = null;
        this._renderPreview();
      }, 2000);
    }
  }
  get hass() { return this._hass; }

  set narrow(v) { this._narrow = v; if (this._menuBtn) this._menuBtn.narrow = v; }
  set panel(v) { this._panel = v; }
  set route(v) { this._route = v; }

  // ---------- data ----------
  async _ws(msg) { return this._hass.callWS(msg); }

  async _load() {
    try {
      const res = await this._ws({ type: "homekit_bridge_builder/bridges" });
      this._bridges = res.bridges;
      this._templates = res.templates;
      this._loaded = true;
    } catch (e) {
      this._toast(`Could not load bridges: ${e.message}`);
    }
    if (this._view === "list") this._renderList();
  }

  async _loadCatalog(entryId) {
    const res = await this._ws(entryId ? { type: "homekit_bridge_builder/catalog", entry_id: entryId } : { type: "homekit_bridge_builder/catalog" });
    this._catalog = res;
    this._byId = new Map(res.entities.map((e) => [e.entity_id, e]));
    this._areaName = new Map(res.areas.map((a) => [a.area_id, a.name]));
  }

  // ---------- shell ----------
  _renderShell() {
    this.shadowRoot.innerHTML = `<style>${STYLES}</style>
      <div class="toolbar"><span id="menu"></span><h1 id="title">Bridge Builder</h1><span id="tbactions"></span></div>
      <div class="content" id="content"></div><div id="overlay"></div>`;
    const menu = document.createElement("ha-menu-button");
    menu.hass = this._hass;
    menu.narrow = this._narrow;
    this.shadowRoot.getElementById("menu").appendChild(menu);
    this._menuBtn = menu;
    this._content = this.shadowRoot.getElementById("content");
    this._content.innerHTML = `<div class="empty"><div class="spinner" style="margin:auto"></div></div>`;
  }

  _setToolbar(title, actionsHtml = "") {
    this.shadowRoot.getElementById("title").textContent = title;
    this.shadowRoot.getElementById("tbactions").innerHTML = actionsHtml;
  }

  _toast(text) {
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = text;
    this.shadowRoot.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }

  _overlay(html) {
    const o = this.shadowRoot.getElementById("overlay");
    o.innerHTML = html ? `<div class="detail" id="dlg"><div class="card">${html}</div></div>` : "";
    if (html) {
      o.querySelector("#dlg").addEventListener("click", (ev) => {
        if (ev.target.id === "dlg" || ev.target.closest("[data-close]")) this._overlay("");
      });
    }
    return o;
  }

  // ---------- list view ----------
  _renderList() {
    this._view = "list";
    this._ed = null;
    this._setToolbar("Bridge Builder");
    if (!this._loaded) return;
    const bridges = this._bridges.filter((b) => b.mode === "bridge");
    const own = this._bridges.filter((b) => b.mode === "accessory");
    const linked = (id) => own.filter((a) => a.linked_to === id);
    const standalone = own.filter((a) => !a.linked_to || !bridges.some((b) => b.entry_id === a.linked_to));

    const tplOptions = this._templates.map((t) => `<option value="${esc(t.id)}">${esc(t.name)} (${t.entities.length})</option>`).join("");
    let html = `
      <div class="row" style="justify-content:space-between">
        <div>
          <div class="section-title" style="margin-top:4px">Bridges</div>
          <div class="muted small">One bridge per person you share with. Each bridge has its own code for their Apple Home.</div>
        </div>
        <div class="row">
          ${this._templates.length ? `<select id="tplpick" style="width:auto"><option value="">New from template…</option>${tplOptions}</select>` : ""}
          <button class="btn primary" id="newbridge">+ New bridge</button>
        </div>
      </div>`;

    if (!bridges.length) {
      html += `<div class="card empty" style="margin-top:12px"><div style="font-size:16px;margin-bottom:6px">No HomeKit bridges yet</div>
        <div class="muted">Create one, choose what to share, and scan its code in the Home app.</div></div>`;
    }
    html += `<div class="grid-cards">${bridges.map((b) => this._bridgeCard(b, linked(b.entry_id))).join("")}</div>`;

    if (standalone.length) {
      html += `<div class="section-title">Accessories paired on their own</div>
        <div class="muted small">Locks, cameras and TVs need their own pairing in HomeKit. These are not linked to a bridge here.</div>
        <div class="grid-cards">${standalone.map((a) => this._accessoryCard(a)).join("")}</div>`;
    }

    html += `<div class="row" style="justify-content:space-between;align-items:flex-end">
        <div>
          <div class="section-title">Templates</div>
          <div class="muted small">A saved selection you can start new bridges from. Make one from the editor with "Save as template".</div>
        </div>
        <div class="row">
          <button class="btn" id="tplimport">Import</button>
          ${this._templates.length ? `<button class="btn" id="tplexport">Export all</button>` : ""}
        </div>
      </div>`;
    html += this._templates.length
      ? `<div class="grid-cards">${this._templates.map((t) => `
        <div class="card"><div class="row" style="justify-content:space-between"><b>${esc(t.name)}</b><span class="muted small">${t.entities.length} entities</span></div>
        <div class="actions"><button class="btn primary" data-tpl-new="${esc(t.id)}">New bridge from this</button>
        <button class="btn" data-tpl-edit="${esc(t.id)}">Edit</button>
        <button class="btn" data-tpl-export="${esc(t.id)}">Export</button>
        <button class="btn danger" data-tpl-del="${esc(t.id)}">Delete</button></div></div>`).join("")}</div>`
      : `<div class="card empty muted" style="margin-top:12px">No templates yet.</div>`;

    this._content.innerHTML = html;
    const $ = (s) => this._content.querySelector(s);
    $("#newbridge").onclick = () => this._openEditor({ mode: "create" });
    if ($("#tplpick")) $("#tplpick").onchange = (ev) => ev.target.value && this._openEditor({ mode: "create", templateId: ev.target.value });
    this._content.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => this._openEditor({ mode: "edit", entryId: b.dataset.edit })));
    this._content.querySelectorAll("[data-code]").forEach((b) => (b.onclick = () => this._showCodes(b.dataset.code)));
    this._content.querySelectorAll("[data-reset]").forEach((b) => (b.onclick = () => this._resetPairing(b.dataset.reset)));
    this._content.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => this._deleteBridge(b.dataset.del)));
    this._content.querySelectorAll("[data-tpl-new]").forEach((b) => (b.onclick = () => this._openEditor({ mode: "create", templateId: b.dataset.tplNew })));
    this._content.querySelectorAll("[data-tpl-edit]").forEach((b) => (b.onclick = () => this._openEditor({ mode: "template", templateId: b.dataset.tplEdit })));
    this._content.querySelectorAll("[data-tpl-del]").forEach((b) => (b.onclick = () => this._deleteTemplate(b.dataset.tplDel)));
    this._content.querySelectorAll("[data-tpl-export]").forEach((b) => (b.onclick = () => this._exportTemplates(this._templates.filter((t) => t.id === b.dataset.tplExport))));
    $("#tplimport").onclick = () => this._pickTemplateFile();
    if ($("#tplexport")) $("#tplexport").onclick = () => this._exportTemplates(this._templates);
  }

  _statusBadge(b) {
    if (!b.running) return `<span class="badge err">Not running</span>`;
    if (b.paired) return `<span class="badge ok">● Paired</span>`;
    return `<span class="badge wait">● Waiting for pairing</span>`;
  }

  _bridgeCard(b, accessories) {
    const leftOut = b.left_out.length && !accessories.length
      ? `<div class="muted small">${b.left_out.length} entit${b.left_out.length === 1 ? "y" : "ies"} need their own pairing and are not on this bridge.</div>` : "";
    const notLoaded = b.missing?.length
      ? `<div class="muted small">${b.missing.length} not loaded right now. ${b.missing.length === 1 ? "It stays" : "They stay"} on this bridge and return${b.missing.length === 1 ? "s" : ""} once loaded and the bridge restarts.</div>` : "";
    const subs = accessories.length
      ? `<div class="sub"><span class="muted small">Paired on their own for this bridge</span>${accessories.map((a) => `
          <div class="row" style="justify-content:space-between"><span>${esc(a.name)}</span>
          <span class="row">${a.paired ? `<span class="badge ok">Paired</span>` : `<button class="link" data-code="${a.entry_id}">Show code</button>`}
          ${a.yaml ? "" : `<button class="link" style="color:var(--error-color)" data-del="${a.entry_id}">Delete</button>`}</span></div>`).join("")}</div>`
      : "";
    const notExact = !b.exact_list && !b.yaml
      ? `<div class="muted small" style="margin-top:6px">Uses domain rules today. Saving here switches it to an exact list.</div>` : "";
    return `<div class="card bridge">
      <h3>${esc(b.name)} ${this._statusBadge(b)}</h3>
      <div class="muted small">Port ${esc(b.port)}${b.yaml ? " · set up in YAML (read only)" : ""}</div>
      <div class="stats">
        <div><b>${b.entities.length}</b><span class="muted">shared</span></div>
        <div><b>${b.paired_users}</b><span class="muted">Apple Home${b.paired_users === 1 ? "" : "s"}</span></div>
      </div>
      ${leftOut}${notLoaded}${notExact}
      <div class="actions">
        ${b.yaml ? "" : `<button class="btn primary" data-edit="${b.entry_id}">Edit</button>`}
        ${!b.paired && b.running ? `<button class="btn" data-code="${b.entry_id}">Show code</button>` : ""}
        ${b.paired && !b.yaml ? `<button class="btn" data-reset="${b.entry_id}">Reset pairing</button>` : ""}
        ${b.yaml ? "" : `<button class="btn danger" data-del="${b.entry_id}">Delete</button>`}
      </div>${subs}</div>`;
  }

  _accessoryCard(a) {
    return `<div class="card bridge"><h3>${esc(a.name)} ${this._statusBadge(a)}</h3>
      <div class="muted small">${esc(a.own_pairing_for || "")} · port ${esc(a.port)}</div>
      <div class="actions">${!a.paired && a.running ? `<button class="btn" data-code="${a.entry_id}">Show code</button>` : ""}
        ${a.yaml ? "" : `<button class="btn danger" data-del="${a.entry_id}">Delete</button>`}</div></div>`;
  }

  async _showCodes(entryId, intro = "") {
    const show = (b) => {
      if (!b) return `<div class="muted">This entry no longer exists.</div>`;
      if (b.paired) return `<h3>${esc(b.name)}</h3><div class="badge ok">Already paired</div>`;
      if (!b.pairing) return `<h3>${esc(b.name)}</h3><div class="row"><div class="spinner"></div><span class="muted">Starting…</span></div>`;
      return `<h3>${esc(b.name)}</h3><div class="qr">${b.pairing.qr_svg ? `<div class="code">${b.pairing.qr_svg}</div>` : ""}
        <div><div class="muted small">Setup code</div><div class="pin">${esc(b.pairing.pin)}</div></div></div>`;
    };
    const ids = [entryId, ...this._bridges.filter((a) => a.linked_to === entryId).map((a) => a.entry_id)];
    const render = () => {
      const blocks = ids.map((id) => show(this._bridges.find((b) => b.entry_id === id)));
      this._overlay(`${intro}${blocks.join(`<hr style="border:0;border-top:1px solid var(--divider-color);margin:14px 0">`)}
        <div class="muted small" style="margin-top:12px">On the person's iPhone: Home app → + → Add Accessory → scan the code.
        If the bridge is not shown, tap "More options" and pick it from the list. They add it to their own Home.</div>
        <div class="actions"><button class="btn primary" data-close>Done</button></div>`);
    };
    render();
    // The bridge may still be starting; refresh until every code is there
    for (let i = 0; i < 15; i++) {
      const waiting = ids.some((id) => { const b = this._bridges.find((x) => x.entry_id === id); return !b || (!b.paired && !b.pairing); });
      if (!waiting) break;
      await new Promise((r) => setTimeout(r, 1500));
      if (!this.shadowRoot.getElementById("dlg")) return;
      await this._load();
      if (this._view === "list") this._renderList();
      render();
    }
  }

  async _resetPairing(entryId) {
    const b = this._bridges.find((x) => x.entry_id === entryId);
    if (!confirm(`Reset pairing for "${b.name}"?\n\nIt disappears from every Apple Home it is in, and shows a new code.`)) return;
    try {
      await this._ws({ type: "homekit_bridge_builder/reset_pairing", entry_id: entryId });
      await this._load();
      this._showCodes(entryId);
    } catch (e) { this._toast(e.message); }
  }

  async _deleteBridge(entryId) {
    const b = this._bridges.find((x) => x.entry_id === entryId);
    const n = this._bridges.filter((a) => a.linked_to === entryId).length;
    if (!confirm(`Delete "${b.name}"${n ? ` and its ${n} separately paired accessor${n === 1 ? "y" : "ies"}` : ""}?\n\nEverything it shares disappears from the Apple Home it is paired with.`)) return;
    try {
      await this._ws({ type: "homekit_bridge_builder/delete_bridge", entry_id: entryId });
      this._toast(`Deleted ${b.name}`);
      await this._load();
    } catch (e) { this._toast(e.message); }
  }

  async _deleteTemplate(id) {
    const t = this._templates.find((x) => x.id === id);
    if (!confirm(`Delete template "${t.name}"? Bridges made from it are not changed.`)) return;
    await this._ws({ type: "homekit_bridge_builder/delete_template", template_id: id });
    await this._load();
  }

  _exportTemplates(templates) {
    const data = {
      type: TEMPLATE_FILE_TYPE,
      version: TEMPLATE_FILE_VERSION,
      templates: templates.map((t) => ({ name: t.name, entities: t.entities })),
    };
    const slug = templates.length === 1 ? templates[0].name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : "";
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json" }));
    link.download = slug ? `bridge-builder-template-${slug}.json` : "bridge-builder-templates.json";
    this.shadowRoot.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  }

  _pickTemplateFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = () => input.files[0] && this._importTemplateFile(input.files[0]);
    input.click();
  }

  async _importTemplateFile(file) {
    const notOurs = "This is not a Bridge Builder templates file.";
    let templates;
    try {
      if (file.size > 1024 * 1024) throw new Error(notOurs);
      const data = JSON.parse(await file.text());
      if (data?.type !== TEMPLATE_FILE_TYPE) throw new Error(notOurs);
      if (data.version !== TEMPLATE_FILE_VERSION) throw new Error("This file was made by a newer version of Bridge Builder.");
      const valid = Array.isArray(data.templates) && data.templates.every((t) =>
        typeof t?.name === "string" && Array.isArray(t.entities) && t.entities.every((id) => typeof id === "string"));
      if (!valid) throw new Error(notOurs);
      templates = data.templates.map((t) => ({ name: t.name, entities: t.entities }));
    } catch (e) {
      this._toast(e instanceof SyntaxError ? notOurs : e.message);
      return;
    }
    try {
      const res = await this._ws({ type: "homekit_bridge_builder/import_templates", templates });
      await this._load();
      const parts = [`Imported ${res.added} template${res.added === 1 ? "" : "s"}.`];
      if (res.skipped) parts.push(`${res.skipped} already here.`);
      const n = res.not_found.length;
      if (n) parts.push(`${n} entit${n === 1 ? "y is" : "ies are"} not on this Home Assistant and show${n === 1 ? "s" : ""} as Not loaded.`);
      this._toast(parts.join(" "));
    } catch (e) { this._toast(e.message); }
  }

  // ---------- editor ----------
  async _openEditor({ mode, entryId, templateId }) {
    this._view = "editor";
    this._setToolbar(mode === "edit" ? "Edit bridge" : mode === "template" ? "Edit template" : "New bridge",
      `<button class="tb" id="back">✕ Close</button>`);
    this.shadowRoot.getElementById("back").onclick = () => this._renderList();
    this._content.innerHTML = `<div class="empty"><div class="spinner" style="margin:auto"></div></div>`;
    await this._loadCatalog(mode === "edit" ? entryId : null);

    const bridge = entryId ? this._bridges.find((b) => b.entry_id === entryId) : null;
    const tpl = templateId ? this._templates.find((t) => t.id === templateId) : null;
    let selected = [];
    if (bridge) {
      selected = [...bridge.entities, ...this._bridges.filter((a) => a.linked_to === entryId).map((a) => a.own_pairing_for).filter(Boolean)];
    } else if (tpl) {
      selected = tpl.entities;
    }
    const name = mode === "edit" ? bridge.name : mode === "template" ? tpl.name : tpl ? "" : "";
    this._ed = {
      mode, entryId, templateId,
      name,
      originalName: name,
      selected: new Set(selected),
      original: new Set(selected),
      search: "",
      supportedOnly: true,
      showHidden: false,
      domain: "",
      closed: new Set(),
    };
    this._renderEditor();
  }

  _renderEditor() {
    const ed = this._ed;
    const isTpl = ed.mode === "template";
    const tplOptions = this._templates.filter((t) => t.id !== ed.templateId)
      .map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("");
    this._content.innerHTML = `
      <div class="top">
        <div class="field"><label>${isTpl ? "Template name" : "Bridge name (also what it is called while pairing)"}</label>
          <input type="text" id="name" value="${esc(ed.name)}" placeholder="${isTpl ? "e.g. Guests" : "e.g. Anna"}">
          <div class="muted small" id="namehint"></div></div>
        ${tplOptions ? `<div class="field" style="flex:0 1 220px"><label>Copy a template's selection</label>
          <select id="usetpl"><option value="">Choose…</option>${tplOptions}</select></div>` : ""}
      </div>
      <div class="editor ${this._narrow ? "narrow" : ""}">
        <div>
          <div class="card picker">
            <div class="pick-head">
              <input type="search" id="search" placeholder="Search name, room, device or entity id" value="${esc(ed.search)}">
              <div class="chips" id="chips"></div>
              <div>
                <div class="count"><span id="cnt"></span><span id="cnt2" class="muted"></span></div>
                <div class="meter" id="meter"><i></i></div>
              </div>
              <div class="row small">
                <button class="link" id="selvis">Select all shown</button>
                <button class="link" id="clrvis">Clear shown</button>
                <span style="flex:1"></span>
                <label class="row muted"><input type="checkbox" id="suponly" ${ed.supportedOnly ? "checked" : ""}> HomeKit-compatible only</label>
                <label class="row muted"><input type="checkbox" id="hidden" ${ed.showHidden ? "checked" : ""}> Hidden &amp; diagnostic</label>
              </div>
            </div>
            <div id="list"></div>
          </div>
          <div id="changes"></div>
          <div class="actions">
            <button class="btn primary" id="save"></button>
            ${isTpl ? "" : `<button class="btn" id="savetpl">Save as template</button>`}
            <button class="btn" id="cancel">Cancel</button>
          </div>
        </div>
        <div id="preview"></div>
      </div>`;

    const $ = (s) => this._content.querySelector(s);
    $("#name").oninput = (ev) => { ed.name = ev.target.value; this._renderNameHint(); this._renderCounts(); this._renderPreview(); };
    $("#search").oninput = (ev) => { ed.search = ev.target.value; this._renderPicker(); };
    $("#suponly").onchange = (ev) => { ed.supportedOnly = ev.target.checked; this._renderPicker(); };
    $("#hidden").onchange = (ev) => { ed.showHidden = ev.target.checked; this._renderPicker(); };
    $("#selvis").onclick = () => { this._visible().forEach((e) => e.homekit.supported && ed.selected.add(e.entity_id)); this._changed(); };
    $("#clrvis").onclick = () => { this._visible().forEach((e) => ed.selected.delete(e.entity_id)); this._changed(); };
    if ($("#usetpl")) $("#usetpl").onchange = (ev) => {
      const t = this._templates.find((x) => x.id === ev.target.value);
      if (t) { t.entities.forEach((id) => this._byId.has(id) && ed.selected.add(id)); this._changed(); this._toast(`Added ${t.name}`); }
      ev.target.value = "";
    };
    $("#cancel").onclick = () => this._renderList();
    $("#save").onclick = () => this._save();
    if ($("#savetpl")) $("#savetpl").onclick = () => this._saveAsTemplate();
    this._renderNameHint();
    this._renderChips();
    this._changed();
  }

  _renderNameHint() {
    const ed = this._ed;
    const hint = this._content.querySelector("#namehint");
    const changes = ed.mode !== "template" && /[^A-Za-z0-9 '’]/.test(ed.name);
    const paired = this._nameChanged() && this._bridges.find((b) => b.entry_id === ed.entryId)?.paired;
    hint.textContent = [
      changes ? "HomeKit names allow plain letters and numbers only, so this is saved without special characters: Ş becomes S, and symbols are removed." : "",
      paired ? "Apple Home may keep showing the old name for this bridge. It can be renamed there." : "",
    ].filter(Boolean).join(" ");
  }

  _nameChanged() {
    const ed = this._ed;
    return ed.mode === "edit" && ed.name.trim() !== ed.originalName;
  }

  _selectionChanged() {
    const ed = this._ed;
    return ed.selected.size !== ed.original.size || [...ed.selected].some((id) => !ed.original.has(id));
  }

  _renderChips() {
    const ed = this._ed;
    const counts = {};
    for (const e of this._catalog.entities) if (e.homekit.supported && !e.missing) counts[e.domain] = (counts[e.domain] || 0) + 1;
    const doms = Object.keys(counts).sort();
    const chips = this._content.querySelector("#chips");
    chips.innerHTML = [`<button class="chip ${ed.domain === "" ? "on" : ""}" data-d="">All</button>`,
      ...doms.map((d) => `<button class="chip ${ed.domain === d ? "on" : ""}" data-d="${esc(d)}">${esc(d.replace(/_/g, " "))} <span class="muted">${counts[d]}</span></button>`)].join("");
    chips.querySelectorAll(".chip").forEach((c) => (c.onclick = () => { ed.domain = c.dataset.d; this._renderChips(); this._renderPicker(); }));
  }

  _visible() {
    const ed = this._ed;
    const q = ed.search.trim().toLowerCase();
    return this._catalog.entities.filter((e) => {
      if (e.missing && !ed.selected.has(e.entity_id) && !ed.original.has(e.entity_id)) return false;
      if (ed.supportedOnly && !e.homekit.supported && !ed.selected.has(e.entity_id)) return false;
      if (!ed.showHidden && (e.hidden || e.category) && !ed.selected.has(e.entity_id)) return false;
      if (ed.domain && e.domain !== ed.domain) return false;
      if (q) {
        const hay = `${e.name} ${e.entity_id} ${e.device || ""} ${this._areaName.get(e.area_id) || ""} ${e.homekit.service || ""}`.toLowerCase();
        if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
      }
      return true;
    });
  }

  _groupByArea(entities) {
    const groups = new Map();
    for (const e of entities) {
      const key = e.area_id || "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
    const order = [...groups.keys()].sort((a, b) => {
      if (!a) return 1; if (!b) return -1;
      return (this._areaName.get(a) || a).localeCompare(this._areaName.get(b) || b);
    });
    return order.map((k) => ({ areaId: k, name: k ? this._areaName.get(k) || k : "No room", items: groups.get(k).sort((x, y) => x.name.localeCompare(y.name)) }));
  }

  _changed() {
    this._renderPicker();
    this._renderCounts();
    this._renderPreview();
  }

  _renderCounts() {
    const ed = this._ed;
    const sel = [...ed.selected].map((id) => this._byId.get(id)).filter(Boolean);
    const own = sel.filter((e) => e.homekit.needs_own_pairing).length;
    const onBridge = sel.length - own;
    const $ = (s) => this._content.querySelector(s);
    $("#cnt").innerHTML = `<b>${onBridge}</b> on the bridge <span class="muted">/ ${MAX_ACCESSORIES} max</span>`;
    $("#cnt2").textContent = own ? `+ ${own} with their own code` : "";
    const meter = $("#meter");
    meter.classList.toggle("over", onBridge > MAX_ACCESSORIES);
    meter.querySelector("i").style.width = `${Math.min(100, (onBridge / MAX_ACCESSORIES) * 100)}%`;

    const save = $("#save");
    save.textContent = ed.mode === "edit" ? "Save changes" : ed.mode === "template" ? "Save template" : "Create bridge";
    // A rename alone needs no valid selection: it does not touch what is shared
    const renameOnly = this._nameChanged() && !this._selectionChanged();
    save.disabled = !renameOnly && (!sel.length || onBridge > MAX_ACCESSORIES);

    let changes = "";
    if (ed.mode === "edit") {
      const added = [...ed.selected].filter((id) => !ed.original.has(id));
      const removed = [...ed.original].filter((id) => !ed.selected.has(id));
      if (added.length || removed.length) {
        changes = `<div class="warn">${added.length ? `<b>+${added.length}</b> added. ` : ""}${removed.length ? `<b>−${removed.length}</b> removed: they disappear from the Apple Home this bridge is paired with, together with any scenes or automations there that use them.` : ""}
          ${!this._bridges.find((b) => b.entry_id === ed.entryId)?.exact_list ? "<br>This bridge used domain rules before; it will now share exactly this list, so new devices are not added automatically." : ""}</div>`;
      }
    }
    $("#changes").innerHTML = changes;
  }

  _renderPicker() {
    const ed = this._ed;
    const list = this._content.querySelector("#list");
    if (!list) return;
    const groups = this._groupByArea(this._visible());
    if (!groups.length) {
      list.innerHTML = `<div class="empty muted">Nothing matches.</div>`;
      return;
    }
    list.innerHTML = groups.map((g) => {
      const supported = g.items.filter((e) => e.homekit.supported);
      const n = supported.filter((e) => ed.selected.has(e.entity_id)).length;
      const all = supported.length && n === supported.length;
      const closed = ed.closed.has(g.areaId) && !ed.search;
      return `<div class="area ${closed ? "closed" : ""}" data-area="${esc(g.areaId)}">
        <div class="area-h"><input type="checkbox" data-areacheck ${all ? "checked" : ""} ${supported.length ? "" : "disabled"}>
          <span class="nm">${esc(g.name)}</span><span class="ct">${n} / ${supported.length}</span><span class="chev">▾</span></div>
        <div class="items">${g.items.map((e) => this._itemRow(e)).join("")}</div></div>`;
    }).join("");

    list.querySelectorAll(".area").forEach((areaEl) => {
      const g = groups.find((x) => x.areaId === areaEl.dataset.area);
      const cb = areaEl.querySelector("[data-areacheck]");
      const n = g.items.filter((e) => e.homekit.supported && ed.selected.has(e.entity_id)).length;
      cb.indeterminate = n > 0 && !cb.checked;
      cb.onclick = (ev) => {
        ev.stopPropagation();
        g.items.forEach((e) => e.homekit.supported && (cb.checked ? ed.selected.add(e.entity_id) : ed.selected.delete(e.entity_id)));
        this._changed();
      };
      areaEl.querySelector(".area-h").onclick = () => {
        ed.closed.has(g.areaId) ? ed.closed.delete(g.areaId) : ed.closed.add(g.areaId);
        areaEl.classList.toggle("closed");
      };
    });
    list.querySelectorAll(".item[data-id]").forEach((row) => {
      row.onclick = (ev) => {
        const id = row.dataset.id;
        const e = this._byId.get(id);
        if (!e.homekit.supported && !ed.selected.has(id)) return;
        ed.selected.has(id) ? ed.selected.delete(id) : ed.selected.add(id);
        if (ev.target.tagName !== "INPUT") row.querySelector("input").checked = ed.selected.has(id);
        this._renderCounts();
        this._renderPreview();
        this._refreshAreaHeader(row.closest(".area"));
      };
    });
  }

  _refreshAreaHeader(areaEl) {
    const ids = [...areaEl.querySelectorAll(".item[data-id]")].map((r) => this._byId.get(r.dataset.id)).filter((e) => e.homekit.supported);
    const n = ids.filter((e) => this._ed.selected.has(e.entity_id)).length;
    const cb = areaEl.querySelector("[data-areacheck]");
    cb.checked = ids.length > 0 && n === ids.length;
    cb.indeterminate = n > 0 && n < ids.length;
    areaEl.querySelector(".ct").textContent = `${n} / ${ids.length}`;
  }

  _itemRow(e) {
    const sel = this._ed.selected.has(e.entity_id);
    const hk = e.homekit;
    const st = this._hass.states[e.entity_id];
    const icon = st?.attributes?.icon || (hk.kind ? ICONS[hk.kind][0] : "mdi:help-circle-outline");
    const pill = !hk.supported
      ? `<span class="pill">Not supported</span>`
      : hk.needs_own_pairing
        ? `<span class="pill own" title="${esc(hk.note)}">${esc(hk.service)} · own code</span>`
        : `<span class="pill" title="${esc(hk.note || "")}">${esc(hk.service)}</span>`;
    const extra = [e.device && e.device !== e.name ? e.device : null, e.hidden ? "hidden" : null, e.category].filter(Boolean).join(" · ");
    return `<div class="item ${hk.supported ? "" : "unsup"}" data-id="${esc(e.entity_id)}">
      <input type="checkbox" ${sel ? "checked" : ""} ${hk.supported || sel ? "" : "disabled"}>
      <ha-icon icon="${esc(icon)}"></ha-icon>
      <div style="min-width:0"><div class="nm">${esc(e.name)}</div><div class="id">${esc(e.entity_id)}${extra ? ` · ${esc(extra)}` : ""}</div></div>
      ${pill}</div>`;
  }

  // ---------- Apple Home preview ----------
  _renderPreview() {
    const ed = this._ed;
    const host = this._content?.querySelector("#preview");
    if (!ed || !host) return;
    const scroll = host.querySelector(".ph-scroll")?.scrollTop || 0;
    const sel = [...ed.selected].map((id) => this._byId.get(id)).filter((e) => e && e.homekit.supported);
    const title = ed.mode === "template" ? (ed.name || "Template") : (ed.name ? `${ed.name}'s Home` : "Home");

    let body = "";
    if (!sel.length) {
      body = `<div class="ph-empty">Pick devices on the left to see how they will look in Apple Home.</div>`;
    } else {
      // Summary pills like the top of the Home app
      const sum = [];
      const temps = sel.filter((e) => e.homekit.kind === "temperature").map((e) => Number(this._hass.states[e.entity_id]?.state)).filter(Number.isFinite);
      if (temps.length) {
        const lo = Math.min(...temps).toFixed(0);
        const hi = Math.max(...temps).toFixed(0);
        sum.push(`🌡 ${lo === hi ? lo : `${lo}–${hi}`}°`);
      }
      const lightsOn = sel.filter((e) => e.homekit.kind === "light" && this._hass.states[e.entity_id]?.state === "on").length;
      if (sel.some((e) => e.homekit.kind === "light")) sum.push(`💡 ${lightsOn ? `${lightsOn} On` : "Off"}`);
      const locks = sel.filter((e) => e.homekit.kind === "lock");
      if (locks.length) sum.push(`🔒 ${locks.every((e) => this._hass.states[e.entity_id]?.state === "locked") ? "Locked" : "Unlocked"}`);
      const open = sel.filter((e) => ["contact", "door", "window", "garage"].includes(e.homekit.kind) && ON_STATES.has(this._hass.states[e.entity_id]?.state)).length;
      if (open) sum.push(`🚪 ${open} Open`);
      body += sum.length ? `<div class="ph-sum">${sum.map((s) => `<span>${esc(s)}</span>`).join("")}</div>` : "";

      for (const g of this._groupByArea(sel)) {
        const cams = g.items.filter((e) => e.homekit.kind === "camera");
        const rest = g.items.filter((e) => e.homekit.kind !== "camera");
        // Apple Home lists controls first, sensors after
        rest.sort((a, b) => (SENSOR_KINDS.has(a.homekit.kind) - SENSOR_KINDS.has(b.homekit.kind)) || a.name.localeCompare(b.name));
        body += `<div class="ph-room">${esc(g.areaId ? g.name : "Default Room")}<small>${g.items.length}</small></div>
          <div class="ph-grid">${[...cams, ...rest].map((e) => this._tile(e, g.areaId ? g.name : "")).join("")}</div>`;
      }
      const own = sel.filter((e) => e.homekit.needs_own_pairing);
      body += `<div class="ph-own">Rooms follow your Home Assistant areas here. In Apple Home, the person picks a room for each accessory while adding the bridge; until then everything sits in <b>Default Room</b>.
        ${own.length ? `<br><br><b>${own.length}</b> of these (${own.map((e) => esc(e.name)).join(", ")}) get${own.length === 1 ? "s" : ""} a separate code, because HomeKit only allows locks, cameras and TVs to be paired on their own.` : ""}</div>`;
    }
    host.innerHTML = `<div class="phone ${this._previewDark ? "dark" : ""}">
      <div class="ph-top"><h2>${esc(title)}</h2><button class="mode" id="phmode">${this._previewDark ? "☀︎ Light" : "☾ Dark"}</button></div>
      <div class="ph-scroll">${body}</div></div>`;
    host.querySelector(".ph-scroll").scrollTop = scroll;
    host.querySelector("#phmode").onclick = () => { this._previewDark = !this._previewDark; this._renderPreview(); };
    host.querySelectorAll(".tile").forEach((t) => (t.onclick = () => this._tileDetail(t.dataset.id)));
  }

  _tile(e, roomName) {
    const kind = e.homekit.kind;
    const st = this._hass.states[e.entity_id];
    const s = tileStatus(kind, st);
    const icon = (ICONS[kind] || ["mdi:help"])[s.active ? 0 : 1];
    const tint = { light: "#f7b733", thermostat: "#ff8a3d", heatercooler: "#ff8a3d", lock: "#2f80ed", security: "#2f80ed",
      fan: "#2fb5d1", purifier: "#2fb5d1", humidifier: "#2fb5d1", tv: "#7d5cff", blinds: "#3fb27f", garage: "#3fb27f",
      door: "#3fb27f", window: "#3fb27f", contact: "#ff9f0a", motion: "#ff9f0a", occupancy: "#ff9f0a", leak: "#ff453a", smoke: "#ff453a" }[kind] || "#34c759";
    const name = tileName(e.name, roomName);
    if (kind === "camera") {
      return `<button class="tile wide" data-id="${esc(e.entity_id)}"><div class="tx"><div class="tn">${esc(name)}</div><div class="ts">Live · tap for details</div></div></button>`;
    }
    const sensor = SENSOR_KINDS.has(kind);
    const ic = sensor && s.value
      ? `<div class="ic"><span class="val">${esc(s.text.replace(/ (lx|ppm|µg\/m³)$/, ""))}</span></div>`
      : `<div class="ic" style="--tint:${tint}"><ha-icon icon="${icon}"></ha-icon></div>`;
    return `<button class="tile ${s.active ? "on" : ""} ${s.dead ? "dead" : ""} ${sensor ? "sensor" : ""}" data-id="${esc(e.entity_id)}">
      ${ic}<div class="tx"><div class="tn">${esc(name)}</div>${sensor && s.value ? "" : `<div class="ts">${esc(s.text)}</div>`}</div></button>`;
  }

  _tileDetail(id) {
    const e = this._byId.get(id);
    const hk = e.homekit;
    this._overlay(`<h3>${esc(e.name)}</h3><div class="muted small">${esc(e.entity_id)}</div>
      <p><b>Shows up as:</b> ${esc(hk.service)}</p>
      ${hk.note ? `<p class="muted">${esc(hk.note)}</p>` : ""}
      <p class="muted small">Room in this preview: ${esc(this._areaName.get(e.area_id) || "none")}. The status is live from Home Assistant.</p>
      <div class="actions"><button class="btn danger" id="rm">Remove from bridge</button><button class="btn primary" data-close>Close</button></div>`);
    this.shadowRoot.getElementById("rm").onclick = () => { this._ed.selected.delete(id); this._overlay(""); this._changed(); };
  }

  // ---------- save ----------
  async _save() {
    const ed = this._ed;
    const btn = this._content.querySelector("#save");
    const entities = [...ed.selected];
    if (!ed.name.trim()) {
      this._toast("Give it a name first");
      this._content.querySelector("#name").focus();
      return;
    }
    if (ed.mode === "edit") {
      const removed = [...ed.original].filter((id) => !ed.selected.has(id)).length;
      if (removed && !confirm(`Remove ${removed} accessor${removed === 1 ? "y" : "ies"} from this bridge?`)) return;
    }
    btn.disabled = true;
    btn.textContent = "Working…";
    try {
      if (ed.mode === "template") {
        await this._ws({ type: "homekit_bridge_builder/save_template", template_id: ed.templateId, name: ed.name.trim(), entities });
        await this._load();
        this._renderList();
        this._toast("Template saved");
      } else if (ed.mode === "edit") {
        const typed = ed.name.trim();
        const renamed = this._nameChanged();
        if (renamed && !this._selectionChanged()) {
          await this._ws({ type: "homekit_bridge_builder/rename_bridge", entry_id: ed.entryId, name: typed });
        } else {
          await this._ws({ type: "homekit_bridge_builder/set_entities", entry_id: ed.entryId, entities, ...(renamed ? { name: typed } : {}) });
        }
        await this._load();
        this._renderList();
        const saved = this._bridges.find((b) => b.entry_id === ed.entryId)?.name;
        this._toast(`${renamed && saved && saved !== typed ? `Saved as "${saved}".` : "Saved."} The bridge restarts and Apple Home updates in a few seconds.`);
        const added = this._bridges.filter((a) => a.linked_to === ed.entryId && !a.paired);
        if (added.length) this._showCodes(ed.entryId, `<div class="muted" style="margin-bottom:10px">New accessories that need their own code:</div>`);
      } else {
        const res = await this._ws({ type: "homekit_bridge_builder/create_bridge", name: ed.name.trim(), entities });
        await this._load();
        this._renderList();
        this._showCodes(res.entry_id, `<div style="font-size:15px;margin-bottom:12px">Bridge created. Send these to the person, or scan them with their iPhone.</div>`);
      }
    } catch (e) {
      this._toast(e.message || String(e));
      btn.disabled = false;
      this._renderCounts();
    }
  }

  async _saveAsTemplate() {
    const ed = this._ed;
    const name = prompt("Template name", ed.name || "");
    if (!name) return;
    await this._ws({ type: "homekit_bridge_builder/save_template", name, entities: [...ed.selected] });
    const res = await this._ws({ type: "homekit_bridge_builder/bridges" });
    this._templates = res.templates;
    this._toast(`Saved template "${name}"`);
  }
}

// The script can load again in the same page, such as after a restart
if (!customElements.get("bridge-builder-panel")) {
  customElements.define("bridge-builder-panel", BridgeBuilderPanel);
}
