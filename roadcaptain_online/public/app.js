const $ = id => document.getElementById(id);
function todayForDateInput(){
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const day = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}
$("date").value = todayForDateInput();
function log(m){ $("log").textContent = m || ""; }
async function api(url, opts={}) {
  const r = await fetch(url, opts);
  const data = await r.json();
  if (!data.ok) throw new Error(data.error || "Errore");
  return data;
}
$("date").addEventListener("click",()=>{ if ($("date").showPicker) $("date").showPicker(); });
$("dateBtn").onclick=()=>{ if ($("date").showPicker) $("date").showPicker(); else $("date").focus(); };

async function refreshStatus(){
  try{
    const d=await api("/api/status");
    if(!d.googleConfigured) log("Modalità fallback gratuita attiva. Per Google Routes/Places aggiungi GOOGLE_MAPS_API_KEY su Render.");
  }catch{}
}
refreshStatus();

function toNumber(value, fallback){
  const n = Number(String(value).replace(",","."));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function updateAutonomy(){
  const tank = toNumber($("tankCapacityL").value, 15.5);
  const consumption = toNumber($("consumptionKmL").value, 13);
  const km = tank * consumption;
  $("autonomyKm").textContent = km.toFixed(0) + " km";
  return km;
}
["tankCapacityL","consumptionKmL"].forEach(id => $(id).addEventListener("input", updateAutonomy));
updateAutonomy();

let waypointIndex = 0;
function refreshWaypointLabels(){
  [...document.querySelectorAll(".waypointRow")].forEach((row, idx) => {
    const title = row.querySelector(".waypointTitle");
    if (title) title.textContent = `Tappa intermedia ${idx + 1}`;
  });
}
function addWaypoint(value=""){
  const id = `waypoint_${++waypointIndex}`;
  const safeValue = String(value || "").replace(/"/g,'&quot;');
  const row = document.createElement("div");
  row.className = "waypointRow";
  row.innerHTML = `<label><span class="waypointTitle">Tappa intermedia</span><input id="${id}" class="waypointInput" autocomplete="off" placeholder="Es. Roma, Napoli, area di servizio..." value="${safeValue}"><div id="${id}_sug" class="suggestions"></div></label><button type="button" class="removeWaypoint">Rimuovi</button>`;
  $("waypoints").appendChild(row);
  setupSuggest(id, `${id}_sug`);
  row.querySelector(".removeWaypoint").onclick = () => { row.remove(); refreshWaypointLabels(); };
  refreshWaypointLabels();
  const input = row.querySelector("input");
  setTimeout(() => input?.focus(), 0);
}
$("addWaypointBtn").onclick = () => addWaypoint();
function getWaypoints(){
  return [...document.querySelectorAll(".waypointInput")].map(i=>i.value.trim()).filter(Boolean);
}

let rcMap = null;
let rcMapLayers = [];

function destroyMap(){
  try {
    if (rcMap) {
      rcMap.remove();
      rcMap = null;
    }
  } catch(e) {
    rcMap = null;
  }
  rcMapLayers = [];
  const mapEl = $("map");
  if (mapEl) {
    mapEl.classList.remove("leaflet-container", "leaflet-touch", "leaflet-fade-anim", "leaflet-grab", "leaflet-touch-drag", "leaflet-touch-zoom");
    mapEl.innerHTML = "";
  }
}

function createFreshMap(){
  const mapEl = $("map");
  if (typeof L === "undefined" || !mapEl) return null;
  if (mapEl.clientHeight < 100) mapEl.style.height = "720px";

  // Ricostruzione completa: evita il problema delle tiles spezzate o disegnate
  // dentro un riquadro più piccolo quando Leaflet conserva una dimensione vecchia.
  destroyMap();
  rcMap = L.map(mapEl, {
    scrollWheelZoom:false,
    zoomControl:true,
    preferCanvas:true
  }).setView([41.9, 12.5], 6);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom:19,
    attribution:"&copy; OpenStreetMap",
    crossOrigin:true
  }).addTo(rcMap);

  return rcMap;
}

function refreshMapSize(callback){
  if (!rcMap) return;
  const run = () => {
    try { rcMap.invalidateSize(false); } catch(e) {}
    if (callback) callback();
  };
  requestAnimationFrame(run);
  setTimeout(run, 120);
  setTimeout(run, 450);
}

function renderMap(data){
  const map = createFreshMap();
  if (!map || typeof L === "undefined") return;

  const bounds = [];
  const line = (data.route?.polyline || []).map(p => [p.lat, p.lng]);
  if (line.length) {
    const routeLayer = L.polyline(line, {color:"#d8c8ad", weight:5, opacity:.95}).addTo(map);
    rcMapLayers.push(routeLayer);
    line.forEach(x => bounds.push(x));
  }

  const baseIcon = (html, cls, size=30) => L.divIcon({className:cls, html, iconSize:[size,size], iconAnchor:[size/2,size/2]});

  const points = [];
  if (data.geocoded?.origin) points.push({label:"Partenza", ...data.geocoded.origin});
  (data.geocoded?.waypoints || []).forEach((w,i)=>points.push({label:`Tappa ${i+1}`, ...w}));
  if (data.geocoded?.destination) points.push({label:"Arrivo", ...data.geocoded.destination});
  points.forEach(p => {
    if (!p.lat || !p.lng) return;
    const m = L.marker([p.lat,p.lng], {icon:baseIcon("●", "rc-point-marker", 24)}).bindPopup(`<strong>${p.label}</strong><br>${p.address || ""}`).addTo(map);
    rcMapLayers.push(m); bounds.push([p.lat,p.lng]);
  });

  (data.stops || []).forEach((s, i) => {
    if (!s.lat || !s.lng) return;
    const label = s.type === "long" ? `${s.longType || "Sosta lunga"}` : `Sosta ${i+1}`;
    const cls = s.status === "CRITICA" ? "rc-critical-marker" : "rc-stop-marker";
    const m = L.marker([s.lat,s.lng], {icon:baseIcon("⛽", cls, 34)}).bindPopup(`<strong>${label}</strong><br>${s.displayName || s.name || s.message || ""}<br><small>km ${Number(s.routeKm||0).toFixed(1)}</small>`).addTo(map);
    rcMapLayers.push(m); bounds.push([s.lat,s.lng]);
  });

  (data.routePois || []).forEach((p, i) => {
    if (!p.lat || !p.lng) return;
    const m = L.marker([p.lat,p.lng], {icon:baseIcon("★", "rc-poi-marker", 28)}).bindPopup(`<strong>POI ${i+1}: ${p.name || "Luogo di interesse"}</strong><br>${p.address || ""}<br><small>km ${Number(p.routeKm||0).toFixed(1)} · fuori rotta ${Math.round((p.offsetMeters||0)/100)/10} km</small>`).addTo(map);
    rcMapLayers.push(m); bounds.push([p.lat,p.lng]);
  });

  refreshMapSize(() => {
    if (bounds.length) {
      try { map.fitBounds(bounds, {padding:[28,28], maxZoom:13}); } catch(e) {}
    }
  });
}

function initMapPlaceholder(){
  // Inizializza dopo il primo layout reale: evita dimensioni 0 e riquadro vuoto.
  setTimeout(() => {
    const map = createFreshMap();
    if (!map) return;
    refreshMapSize();
  }, 80);
}
initMapPlaceholder();


function setupSuggest(inputId, boxId){
  const input=$(inputId), box=$(boxId); let timer=null;
  input.addEventListener("input",()=>{
    clearTimeout(timer);
    const q=input.value.trim();
    if(q.length<3){box.innerHTML="";return;}
    timer=setTimeout(async()=>{
      try{
        const d=await api("/api/suggest?q="+encodeURIComponent(q));
        const items = Array.isArray(d.items) ? d.items : [];
        box.innerHTML=items.map(x=>`<button type="button">${x.description || x.address || x.name || ""}</button>`).join("");
        box.querySelectorAll("button").forEach(b=>b.onclick=()=>{input.value=b.textContent;box.innerHTML="";});
      }catch(e){log("Suggerimenti: "+e.message);}
    },350);
  });
}
setupSuggest("origin","originSug"); setupSuggest("destination","destSug"); setupSuggest("longStopAddress","longStopSug");
let longStopActive = false;
function setLongStopActive(active){
  longStopActive = Boolean(active);
  $("longStopEditor").classList.toggle("hidden", !longStopActive);
  $("addLongStopBtn").classList.toggle("hidden", longStopActive);
}
$("addLongStopBtn").onclick = () => setLongStopActive(true);
$("removeLongStopBtn").onclick = () => {
  setLongStopActive(false);
  $("longStopAddress").value = "";
};
$("fuelType").addEventListener("change",()=> $("fuelBtn").click());
$("fuelBtn").onclick=async()=>{
  const btn = $("fuelBtn");
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Aggiorno...";
  log("Aggiornamento prezzo carburante in corso...");
  try{
    const d=await api("/api/fuel?type="+encodeURIComponent($("fuelType").value)+"&ts="+Date.now());
    $("fuelPrice").value=String(d.price).replace(".",",");
    log("Prezzo carburante aggiornato: "+(d.source || "fonte non indicata")+(d.warning ? " ("+d.warning+")" : ""));
  }catch(e){
    log("Prezzo carburante: "+e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
};
$("parseBtn").onclick=()=>{
  const t=$("natural").value;
  const from=t.match(/partire da\s+(.+?)\s+(?:ed|e)\s+arrivare/i);
  const to=t.match(/arrivare (?:al|a|alla)\s+(.+?)(?:\.|,|\s+pianifica|\s+considera|$)/i);
  const tm=t.match(/(?:ore|alle)\s+(\d{1,2})[:.](\d{2})/i);
  const date=t.match(/(\d{1,2})\s+maggio\s+(\d{4})/i);
  const cons=t.match(/(\d+(?:[,.]\d+)?)\s*km\/l/i);
  const via=t.match(/(?:passando da|passa da|con tappa a|tappe a)\s+(.+?)(?:\.|,?\s+(?:e poi arrivare|arrivare|voglio|devo|considera|con consumo|serbatoio)|$)/i);
  if(from) $("origin").value=from[1].trim();
  if(to) $("destination").value=to[1].trim();
  if(via){
    $("waypoints").innerHTML = "";
    waypointIndex = 0;
    via[1].split(/\s*(?:,|;|\se\s|\spoi\s)\s*/i).map(x=>x.trim()).filter(Boolean).forEach(x=>addWaypoint(x));
  }
  if(tm) $("time").value=`${tm[1].padStart(2,"0")}:${tm[2]}`;
  if(date) $("date").value=`${date[2]}-05-${date[1].padStart(2,"0")}`;
  if(cons) $("consumptionKmL").value=cons[1].replace(",",".");
  const tank=t.match(/(serbatoio|capienza)\s*(?:da|di)?\s*(\d+(?:[,.]\d+)?)\s*l/i);
  if(tank) $("tankCapacityL").value=tank[2].replace(",",".");
  updateAutonomy();
  log("Testo analizzato. Controlla gli indirizzi selezionando il suggerimento se compare.");
};
$("calcBtn").onclick=async()=>{
  log("Calcolo in corso...");
  try{
    const body={
      origin:$("origin").value,destination:$("destination").value,waypoints:getWaypoints(),date:$("date").value,time:$("time").value,mode:$("mode").value,
      tankCapacityL:$("tankCapacityL").value,stopEveryKm:$("stopEveryKm").value,forwardWindowKm:$("forwardWindowKm").value,
      consumptionKmL:$("consumptionKmL").value,autonomyKm:updateAutonomy(),fuelPrice:$("fuelPrice").value,fuelType:$("fuelType").value,
      longStop:{enabled:longStopActive, type:$("longStopType").value, time:$("longStopTime").value, minutes:Number($("longStopMinutes").value||0), address:$("longStopAddress").value.trim()}
    };
    const d=await api("/api/plan",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    $("km").textContent=d.route.distanceKm.toFixed(1);
    $("drive").textContent=d.route.durationHours.toFixed(1)+" h";
    $("dep").textContent=d.times.departure; $("arr").textContent=d.times.arrival;
    $("liters").textContent=d.fuel.liters.toFixed(1); $("cost").textContent="€ "+d.fuel.cost.toFixed(2);
    if (d.fuel.autonomyKm) $("autonomyKm").textContent=d.fuel.autonomyKm.toFixed(0)+" km";
    const programmedStops = d.stops.filter(s=>s.status!=="CRITICA").length;
    $("pois").textContent=String(programmedStops);
    const fuelCost = Number(d.fuel.cost || 0);
    let tollAmount = null;
    if (d.tolls?.amount !== null && d.tolls?.amount !== undefined) {
      tollAmount = Number(d.tolls.amount);
      $("tolls").textContent = "€ " + tollAmount.toFixed(2);
      $("tolls").title = (d.tolls.source || "") + " - " + (d.tolls.note || "");
    } else if (d.tolls?.available) {
      $("tolls").textContent = "Presente, N/D";
      $("tolls").title = d.tolls.note || "Pedaggio presente ma importo non disponibile";
    } else {
      $("tolls").textContent = "N/D";
      $("tolls").title = d.tolls?.note || "Pedaggio non disponibile";
    }
    $("totalCost").textContent = tollAmount !== null ? "€ " + (fuelCost + tollAmount).toFixed(2) : "—";
    $("stops").innerHTML=d.stops.map(s=>{
      const prev = Number.isFinite(s.fromPreviousKm) ? ` <small>(+${s.fromPreviousKm.toFixed(1)} km dalla sosta precedente)</small>` : "";
      const eta = s.eta ? `<p><strong>Arrivo sosta:</strong> ${s.eta}</p>` : "";
      const stopDuration = Number.isFinite(Number(s.stopMinutes)) ? `<p><strong>Durata sosta normale:</strong> ${Number(s.stopMinutes)} min</p>` : "";
      const departureEta = s.departureEta ? `<p><strong>Ripartenza prevista:</strong> ${s.departureEta}</p>` : "";
      const long = s.longStopMinutes ? `<p class="longStopNote">Sosta lunga ${s.longStopType || "programmata"}: ${s.longStopMinutes} minuti${s.longStopTargetTime ? `, richiesta intorno alle ${s.longStopTargetTime}` : ""}</p>${s.longStopAddress ? `<p><strong>Indirizzo sosta lunga:</strong> ${s.longStopAddress}</p>` : ""}` : "";
      return s.status==="CRITICA" ? 
      `<div class="stop"><span class="badge CRITICA">CRITICA</span><strong>km ${s.routeKm}</strong>${prev}<p>${s.message}</p></div>` :
      `<div class="stop"><span class="badge ${s.status}">${s.status}</span><strong>km ${s.routeKm.toFixed(1)} totali</strong>${prev}<h3>${s.displayName || s.name}</h3><p>${s.address}</p>${eta}${stopDuration}${long}${departureEta}<small>${s.source} | scostamento rotta ${s.offsetMeters} m</small></div>`
    }).join("") || "Nessuna sosta necessaria.";
    const routePois = d.routePois || [];
    $("routePois").innerHTML = routePois.length ? routePois.map((p,i)=>`<div class="poiItem"><strong>${i+1}. ${p.name || "Luogo di interesse"}</strong><p>${p.address || ""}</p><small>km ${Number(p.routeKm||0).toFixed(1)} · fuori rotta ${(Number(p.offsetMeters||0)/1000).toFixed(1)} km · ${p.category || "POI"}</small></div>`).join("") : "Nessun POI vicino alla rotta trovato.";
    renderMap(d);
    log("Calcolo completato. Motore: "+d.mode+".");
  }catch(e){log("Errore: "+e.message);}
};
