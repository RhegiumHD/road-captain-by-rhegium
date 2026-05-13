
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
  const data = await api("/api/config");
  $("status").textContent = data.googleConfigured ? "Google API configurata" : "Google API non configurata";
  if (!data.googleConfigured) return;

  const script = document.createElement("script");
  script.src = data.mapsScriptUrl;
  script.async = true;
  script.defer = true;
  script.onload = initMap;
  document.head.appendChild(script);
}

function initMap() {
  map = new google.maps.Map($("map"), {
    center: { lat: 41.9, lng: 12.5 },
    zoom: 6,
    mapTypeControl: false,
    fullscreenControl: true,
    streetViewControl: false
  });
}

function drawPlan(plan) {
  if (!map || !window.google) return;

  if (routeLine) routeLine.setMap(null);
  markers.forEach(m => m.setMap(null));
  markers = [];

  const path = plan.route.polyline.map(p => ({ lat: p.lat, lng: p.lng }));
  routeLine = new google.maps.Polyline({
    path,
    geodesic: true,
    strokeColor: "#d71920",
    strokeOpacity: 1,
    strokeWeight: 5
  });
  routeLine.setMap(map);

  const bounds = new google.maps.LatLngBounds();
  path.forEach(p => bounds.extend(p));

  function addMarker(position, title, label) {
    const marker = new google.maps.Marker({ position, map, title, label });
    markers.push(marker);
    bounds.extend(position);
  }

  addMarker({ lat: plan.geocoded.origin.lat, lng: plan.geocoded.origin.lng }, "Partenza", "P");
  addMarker({ lat: plan.geocoded.destination.lat, lng: plan.geocoded.destination.lng }, "Arrivo", "A");

  plan.geocoded.waypoints.forEach((w, idx) => {
    addMarker({ lat: w.lat, lng: w.lng }, `Tappa ${idx + 1}`, String(idx + 1));
  });

  plan.stops.filter(s => s.status !== "CRITICA").forEach((s, idx) => {
    addMarker({ lat: s.lat, lng: s.lng }, s.name, s.longStop ? "L" : "S");
  });

  plan.pois.forEach((p, idx) => {
    addMarker({ lat: p.lat, lng: p.lng }, p.name, "★");
  });

  map.fitBounds(bounds);
}

function setupSuggest(input, box) {
  let timer = null;

  async function runSuggest() {
    const q = input.value.trim();
    if (q.length < 3) {
      box.innerHTML = "";
      return;
    }

    try {
      const data = await api("/api/suggest?q=" + encodeURIComponent(q));
      const items = Array.isArray(data.items) ? data.items : [];

      if (!items.length) {
        box.innerHTML = `<div class="suggest-empty">Nessun suggerimento trovato</div>`;
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
    timer = setTimeout(runSuggest, 250);
  });

  input.addEventListener("focus", () => {
    if (input.value.trim().length >= 3) {
      clearTimeout(timer);
      timer = setTimeout(runSuggest, 100);
    }
  });

  document.addEventListener("click", event => {
    if (!box.contains(event.target) && event.target !== input) {
      box.innerHTML = "";
    }
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
  $("tollCost").textContent = plan.route.tollTotal === null ? plan.route.tollStatus : euro(plan.route.tollTotal);
  $("departure").textContent = plan.schedule.departure;
  $("arrival").textContent = plan.schedule.arrival;

  $("stops").innerHTML = plan.stops.map(stop => {
    if (stop.status === "CRITICA") {
      return `<div class="item"><span class="badge crit">CRITICA</span><h4>${stop.name}</h4><p>${stop.message}</p></div>`;
    }
    const badge = stop.longStop ? "long" : (stop.status === "VALIDA" ? "valid" : "warn");
    const type = stop.longStop ? stop.type.toUpperCase() : "Sosta carburante";
    const eta = stop.etaIso ? new Date(stop.etaIso).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }) : "";
    return `
      <div class="item">
        <span class="badge ${badge}">${stop.status}${stop.longStop ? " / SOSTA LUNGA" : ""}</span>
        <h4>${stop.name}</h4>
        <p>km ${stop.routeKm.toFixed(1)} · ${eta} · ${type} · ${stop.durationMinutes} min</p>
        <p>${stop.address || ""}</p>
        <p>Scostamento rotta: ${stop.offsetMeters} m</p>
      </div>
    `;
  }).join("") || `<div class="muted">Nessuna sosta necessaria.</div>`;

  $("pois").innerHTML = plan.pois.map(p => `
    <div class="item">
      <h4>${p.name}</h4>
      <p>km ${p.routeKm.toFixed(1)} · distanza dalla rotta ${p.detourKm.toFixed(1)} km</p>
      <p>${p.address || ""}</p>
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
    log("Itinerario calcolato.");
  } catch (err) {
    log("Errore: " + err.message);
  }
}

$("date").value = new Date().toISOString().slice(0, 10);
setupSuggest($("origin"), $("originSug"));
setupSuggest($("destination"), $("destinationSug"));
$("addWaypoint").onclick = () => addWaypoint();
$("fuelPriceBtn").onclick = refreshFuelPrice;
$("fuelType").onchange = refreshFuelPrice;
$("planBtn").onclick = calculate;

loadConfig().catch(err => log(err.message));
refreshFuelPrice();
