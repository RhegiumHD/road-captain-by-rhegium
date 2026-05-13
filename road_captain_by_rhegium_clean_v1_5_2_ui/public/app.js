
const $ = id => document.getElementById(id);

let map, routeLine;
let markers = [];
let latestFuelPrice = null;

function log(message) { $("log").textContent = message || ""; }
function euro(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "Non disponibile";
  return new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(value);
}
function minutesText(min) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
function clearSuggestions(id) { $(id).innerHTML = ""; }

async function api(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "Errore API");
  return data;
}

async function loadConfig() {
  try {
    const data = await api("/api/config");
    $("status").textContent = data.googleConfigured
      ? "Google API configurata · Mappa OSM"
      : "Mappa OSM · Google API non configurata";
  } catch {
    $("status").textContent = "Mappa OSM";
  }
  initMap();
}

function initMap() {
  if (!window.L) {
    log("Leaflet non caricato. Controlla connessione/CDN.");
    return;
  }
  map = L.map("map", { zoomControl: true }).setView([41.9, 12.5], 6);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap"
  }).addTo(map);
}

function drawPlan(plan) {
  if (!map || !window.L) return;

  if (routeLine) routeLine.remove();
  markers.forEach(m => m.remove());
  markers = [];

  const path = plan.route.polyline.map(p => [p.lat, p.lng]);
  routeLine = L.polyline(path, { color: "#d71920", weight: 5, opacity: 1 }).addTo(map);

  const addMarker = (lat, lng, text) => {
    const marker = L.marker([lat, lng]).addTo(map).bindPopup(text);
    markers.push(marker);
  };

  addMarker(plan.geocoded.origin.lat, plan.geocoded.origin.lng, "Partenza");
  addMarker(plan.geocoded.destination.lat, plan.geocoded.destination.lng, "Arrivo");

  plan.geocoded.waypoints.forEach((w, idx) => {
    addMarker(w.lat, w.lng, `Tappa ${idx + 1}`);
  });

  plan.stops.filter(s => s.status !== "CRITICA").forEach(s => {
    addMarker(s.lat, s.lng, s.longStop ? `${s.name}<br>Sosta lunga` : s.name);
  });

  plan.pois.forEach(p => addMarker(p.lat, p.lng, p.name));

  map.fitBounds(routeLine.getBounds(), { padding: [24, 24] });
  setTimeout(() => map.invalidateSize(), 100);
}

async function directPublicSuggest(q) {
  const out = [];
  const seen = new Set();
  const push = (description, source) => {
    const clean = String(description || "").replace(/\s+/g, " ").trim();
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ description: clean, source });
  };

  const local = [
    "Area di servizio Villa San Giovanni Est, Autostrada del Mediterraneo, Villa San Giovanni, Reggio Calabria, Italia",
    "Villa San Giovanni, Reggio Calabria, Calabria, Italia",
    "Toscana Village, Via Fornoli 9, Montopoli in Val d'Arno, Pisa, Italia",
    "Via Fornoli 9, Montopoli in Val d'Arno, Pisa, Italia"
  ];
  local.forEach(x => { if (x.toLowerCase().includes(q.toLowerCase())) push(x, "locale"); });

  try {
    const r = await fetch("https://photon.komoot.io/api/?limit=8&lang=it&q=" + encodeURIComponent(q));
    const data = await r.json();
    for (const f of data.features || []) {
      const p = f.properties || {};
      const parts = [
        p.name,
        p.street && p.housenumber ? `${p.street} ${p.housenumber}` : p.street,
        p.city,
        p.county,
        p.state,
        p.country
      ].filter(Boolean);
      push([...new Set(parts)].join(", "), "Photon browser");
    }
  } catch {}

  try {
    const query = q.length < 6 ? `${q}, Italia` : q;
    const r = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=8&countrycodes=it&q=" + encodeURIComponent(query));
    const data = await r.json();
    if (Array.isArray(data)) data.forEach(x => push(x.display_name, "Nominatim browser"));
  } catch {}

  return out.slice(0, 8);
}

function setupSuggest(input, box) {
  let timer = null;

  async function runSuggest() {
    const q = input.value.trim();
    if (q.length < 2) {
      box.innerHTML = "";
      return;
    }

    box.innerHTML = `<div class="suggest-empty">Cerco indirizzi...</div>`;

    try {
      let items = [];
      try {
        const data = await api("/api/suggest?q=" + encodeURIComponent(q));
        items = Array.isArray(data.items) ? data.items : [];
      } catch {}

      if (!items.length) items = await directPublicSuggest(q);

      if (!items.length) {
        box.innerHTML = `<div class="suggest-empty">Nessun suggerimento trovato. Scrivi più dettagli.</div>`;
        return;
      }

      box.innerHTML = items
        .map(item => `<button type="button" title="${item.source || ""}">${item.description}</button>`)
        .join("");

      box.querySelectorAll("button").forEach(btn => {
        btn.onclick = () => {
          input.value = btn.textContent;
          box.innerHTML = "";
        };
      });
    } catch (err) {
      box.innerHTML = `<div class="suggest-empty">Errore suggerimenti: ${err.message}</div>`;
      log("Suggerimenti indirizzo: " + err.message);
    }
  }

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(runSuggest, 180);
  });

  input.addEventListener("focus", () => {
    if (input.value.trim().length >= 2) {
      clearTimeout(timer);
      timer = setTimeout(runSuggest, 80);
    }
  });

  document.addEventListener("click", event => {
    if (!box.contains(event.target) && event.target !== input) box.innerHTML = "";
  });
}

function addWaypoint(value = "") {
  const wrap = document.createElement("div");
  wrap.className = "waypoint";
  const index = document.querySelectorAll(".waypoint input").length + 1;
  wrap.innerHTML = `
    <label>Tappa intermedia ${index}
      <div class="waypoint-row">
        <div>
          <input class="waypointInput" autocomplete="off" placeholder="Inserisci una tappa" value="${value}">
          <div class="suggestions waypointSug"></div>
        </div>
        <button type="button">×</button>
      </div>
    </label>
  `;
  wrap.querySelector("button").onclick = () => wrap.remove();
  $("waypoints").appendChild(wrap);
  setupSuggest(wrap.querySelector(".waypointInput"), wrap.querySelector(".waypointSug"));
}

async function refreshFuelPrice() {
  try {
    const data = await api("/api/fuel-price?type=" + encodeURIComponent($("fuelType").value));
    latestFuelPrice = data.fuel.price;
    const ts = new Date(data.fuel.timestamp).toLocaleString("it-IT");
    $("fuelPriceInfo").textContent = `${euro(latestFuelPrice)}/L - ${data.fuel.source} - ${ts}`;
  } catch (err) {
    $("fuelPriceInfo").textContent = "Prezzo carburante non disponibile: " + err.message;
  }
}

function collectPayload() {
  return {
    origin: $("origin").value.trim(),
    destination: $("destination").value.trim(),
    waypoints: [...document.querySelectorAll(".waypointInput")].map(x => x.value.trim()).filter(Boolean),
    date: $("date").value,
    time: $("time").value,
    mode: $("mode").value,
    fuelType: $("fuelType").value,
    tankLiters: $("tankLiters").value,
    consumptionKmL: $("consumptionKmL").value,
    maxAutonomyKm: $("maxAutonomyKm").value,
    targetStopKm: $("targetStopKm").value,
    forwardWindowKm: $("forwardWindowKm").value,
    longStop: {
      enabled: Boolean($("longStopType").value),
      type: $("longStopType").value,
      time: $("longStopTime").value,
      durationMinutes: $("longStopDuration").value
    }
  };
}

function renderPlan(plan) {
  $("km").textContent = plan.route.distanceKm.toFixed(1);
  $("duration").textContent = minutesText(plan.schedule.totalMinutes);
  $("stopCount").textContent = String(plan.stopCount);
  $("fuelCost").textContent = euro(plan.fuel.cost);
  $("tollCost").textContent = plan.route.tollTotal === null ? "Non disponibile" : euro(plan.route.tollTotal);
  $("departure").textContent = plan.schedule.departure;
  $("arrival").textContent = plan.schedule.arrival;

  $("stops").innerHTML = plan.stops.map(stop => {
    if (stop.status === "CRITICA") {
      return `<div class="item"><span class="badge crit">CRITICA</span><h4>⛽ ${stop.name}</h4><p>${stop.message}</p></div>`;
    }
    const badge = stop.longStop ? "long" : (stop.status === "VALIDA" ? "valid" : "warn");
    const type = stop.longStop ? stop.type.toUpperCase() : "Sosta carburante";
    const eta = stop.etaIso ? new Date(stop.etaIso).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }) : "";
    return `
      <div class="item">
        <span class="badge ${badge}">${stop.status}${stop.longStop ? " / SOSTA LUNGA" : ""}</span>
        <h4>⛽ ${stop.name}</h4>
        <p>km ${stop.routeKm.toFixed(1)} · ${eta} · ${type} · ${stop.durationMinutes} min</p>
        <p>${stop.address || ""}</p>
        <p>Scostamento rotta: ${stop.offsetMeters} m</p>
      </div>
    `;
  }).join("") || `<div class="muted">Nessuna sosta necessaria.</div>`;

  const poiItems = (plan.pois || []).slice(0, 6);
  $("pois").innerHTML = poiItems.map(p => `
    <div class="poi-card">
      <strong>📍 ${p.name}</strong>
      <span>km ${p.routeKm.toFixed(1)} · ${p.detourKm.toFixed(1)} km dalla rotta</span>
      <small>${p.address || ""}</small>
    </div>
  `).join("") || `<div class="muted">Nessun suggerimento trovato lungo la tratta.</div>`;

  drawPlan(plan);
}

async function calculate() {
  log("Calcolo itinerario in corso...");
  try {
    const payload = collectPayload();
    if (!payload.origin || !payload.destination) {
      throw new Error("Inserisci partenza e arrivo.");
    }
    const plan = await api("/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    renderPlan(plan);
    log(plan.route.tollTotal === null ? "Itinerario calcolato. Nota: " + plan.route.tollStatus : "Itinerario calcolato.");
  } catch (err) {
    log("Errore: " + err.message);
  }
}

$("date").value = new Date().toISOString().slice(0, 10);

function refreshModeLabels() {
  const timeInput = $("time");
  const label = timeInput.closest("label");
  if (label && label.childNodes.length) {
    label.childNodes[0].textContent = $("mode").value === "arrive" ? "Ora arrivo desiderata " : "Ora partenza ";
  }
}

$("date").addEventListener("click", () => { if ($("date").showPicker) $("date").showPicker(); });
$("date").addEventListener("focus", () => { if ($("date").showPicker) $("date").showPicker(); });
$("openCalendar").onclick = () => { if ($("date").showPicker) $("date").showPicker(); else $("date").focus(); };
setupSuggest($("origin"), $("originSug"));
setupSuggest($("destination"), $("destinationSug"));
$("addWaypoint").onclick = () => addWaypoint();
$("fuelPriceBtn").onclick = refreshFuelPrice;
$("fuelType").onchange = refreshFuelPrice;
$("mode").addEventListener("change", refreshModeLabels);
refreshModeLabels();
$("planBtn").onclick = calculate;

loadConfig().catch(err => log(err.message));
refreshFuelPrice();
