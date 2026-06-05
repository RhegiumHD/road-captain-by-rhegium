const $ = id => document.getElementById(id);

/* ---- Sistema icone SVG (coerente, niente emoji) ---- */
const _svg = (inner, opt={}) => `<svg viewBox="0 0 24 24" fill="${opt.fill||"none"}" stroke="${opt.stroke||"currentColor"}" stroke-width="${opt.sw||2}" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const ICONS = {
  fuel: _svg('<path d="M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3 21h14"/><path d="M15 9h2.5a1.5 1.5 0 0 1 1.5 1.5V17a1.6 1.6 0 0 0 3 0v-6l-2.3-2.3"/><path d="M8 8h4"/>'),
  pin: _svg('<path d="M12 21s7-6.3 7-12a7 7 0 1 0-14 0c0 5.7 7 12 7 12z"/><circle cx="12" cy="9" r="2.4"/>'),
  flag: _svg('<path d="M5 21V4M5 4c3-1.6 6 1.6 9 0v8c-3 1.6-6-1.6-9 0"/>'),
  alert: _svg('<path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17.5v.01"/>'),
  star: _svg('<path d="M12 2.5l2.7 5.9 6.4.7-4.8 4.3 1.3 6.3L12 16.9 6.4 19.7l1.3-6.3-4.8-4.3 6.4-.7z"/>', {fill:"currentColor", stroke:"none"}),
  museum: _svg('<path d="M3 9l9-5 9 5M4 9h16M6 9v8M10 9v8M14 9v8M18 9v8M3 21h18"/>'),
  park: _svg('<path d="M12 14v7M7 14h10l-5-9zM9.5 9.5L12 5l2.5 4.5"/>'),
  church: _svg('<path d="M12 2v6M9 5h6M5 21v-7l7-4 7 4v7M9 21v-4h6v4M3 21h18"/>'),
  castle: _svg('<path d="M4 21V8l2 1V6l2 1V5l4 .0 4 0v2l2-1v3l2-1v13M4 21h16M10 21v-4h4v4"/>'),
  viewpoint: _svg('<path d="M3 18l5-7 4 5 3-4 6 6M3 18h18"/><circle cx="8" cy="7" r="2"/>'),
  beach: _svg('<path d="M3 20h18M12 20V9M12 9c-3-3-7-2-9 1 5-1 7 1 9-1zM12 9c2-3 6-3 9-1-5-1-7 1-9 1z"/>'),
  food: _svg('<path d="M6 3v7a2 2 0 0 0 4 0V3M8 10v11M17 3c-1.5 0-2.5 1.6-2.5 4S15.5 13 17 13zM17 13v8"/>'),
  historic: _svg('<path d="M10 3h4l-1 4h-2zM10.5 7h3l.7 10h-4.4zM8 21h8M9 17h6"/>'),
  poi: _svg('<path d="M12 21s7-6.3 7-12a7 7 0 1 0-14 0c0 5.7 7 12 7 12z"/><circle cx="12" cy="9" r="2.4"/>')
};
const poiIcon = key => ICONS[key] || ICONS.poi;

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
  if (r.status === 401) { showGate(); throw new Error("Accesso richiesto: inserisci il codice."); }
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
  const rawTank = String($("tankCapacityL").value).trim();
  const rawCons = String($("consumptionKmL").value).trim();
  const tank = toNumber(rawTank, 0);
  const consumption = toNumber(rawCons, 0);
  if (!rawTank || !rawCons || tank <= 0 || consumption <= 0){
    $("autonomyKm").textContent = "—";
    return null;
  }
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
  row.innerHTML = `<label><span class="waypointTitle">Tappa intermedia</span><input id="${id}" class="waypointInput" autocomplete="off" placeholder="Es. Roma, Napoli, area di servizio..." value="${safeValue}"><div id="${id}_sug" class="suggestions"></div></label><button type="button" class="removeWaypoint"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg> Rimuovi</button>`;
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

  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    maxZoom:20,
    subdomains:"abcd",
    attribution:"&copy; OpenStreetMap, &copy; CARTO",
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
    // Percorso ben visibile su mappa chiara: linea blu brillante con bordo scuro
    // (casing) sotto, così risalta sul terreno e non si confonde con i segnaposto rossi.
    const routeCasing = L.polyline(line, {color:"#0b2a4a", weight:9, opacity:.9, lineJoin:"round", lineCap:"round"}).addTo(map);
    const routeLayer = L.polyline(line, {color:"#2f7bff", weight:5, opacity:1, lineJoin:"round", lineCap:"round"}).addTo(map);
    rcMapLayers.push(routeCasing, routeLayer);
    line.forEach(x => bounds.push(x));
  }

  const baseIcon = (html, cls, size=30) => L.divIcon({className:cls, html, iconSize:[size,size], iconAnchor:[size/2,size/2]});

  const points = [];
  if (data.geocoded?.origin) points.push({label:"Partenza", icon:ICONS.pin, ...data.geocoded.origin});
  (data.geocoded?.waypoints || []).forEach((w,i)=>points.push({label:`Tappa ${i+1}`, icon:ICONS.pin, ...w}));
  if (data.geocoded?.destination) points.push({label:"Arrivo", icon:ICONS.flag, ...data.geocoded.destination});
  points.forEach(p => {
    if (!p.lat || !p.lng) return;
    const m = L.marker([p.lat,p.lng], {icon:baseIcon(p.icon, "rc-point-marker", 30)}).bindPopup(`<strong>${p.label}</strong><br>${p.address || ""}`).addTo(map);
    rcMapLayers.push(m); bounds.push([p.lat,p.lng]);
  });

  (data.stops || []).forEach((s, i) => {
    if (!s.lat || !s.lng) return;
    const label = s.type === "long" ? `${s.longType || "Sosta lunga"}` : `Sosta ${i+1}`;
    const critical = s.status === "CRITICA";
    const cls = critical ? "rc-critical-marker" : "rc-stop-marker";
    const glyph = critical ? ICONS.alert : ICONS.fuel;
    const m = L.marker([s.lat,s.lng], {icon:baseIcon(glyph, cls, 36)}).bindPopup(`<strong>${label}</strong><br>${s.displayName || s.name || s.message || ""}<br><small>km ${Number(s.routeKm||0).toFixed(1)}</small>`).addTo(map);
    rcMapLayers.push(m); bounds.push([s.lat,s.lng]);
  });

  (data.routePois || []).forEach((p, i) => {
    if (!p.lat || !p.lng) return;
    const rate = p.rating ? ` &middot; &#9733; ${Number(p.rating).toFixed(1)}${p.userRatingCount?` (${p.userRatingCount})`:""}` : "";
    const m = L.marker([p.lat,p.lng], {icon:baseIcon(poiIcon(p.icon), "rc-poi-marker", 30)}).bindPopup(`<strong>${p.name || "Luogo di interesse"}</strong><br>${p.address || ""}<br><small>km ${Number(p.routeKm||0).toFixed(1)} &middot; fuori rotta ${Math.round((p.offsetMeters||0)/100)/10} km &middot; ${p.category || "POI"}${rate}</small>`).addTo(map);
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


function setupSuggestEl(input, box){
  let timer=null;
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
function setupSuggest(inputId, boxId){ setupSuggestEl($(inputId), $(boxId)); }
setupSuggest("origin","originSug"); setupSuggest("destination","destSug");

// Soste lunghe multiple: righe aggiunte dinamicamente.
let lsSeq = 0;
function addLongStopRow(){
  const i = lsSeq++;
  const row = document.createElement("div");
  row.className = "longStopRow";
  row.innerHTML =
    '<div class="row">'+
      '<label>Tipo sosta <select class="lsType"><option value="pranzo">Pranzo</option><option value="cena">Cena</option><option value="relax">Relax</option></select></label>'+
      '<label>Orario indicativo <input class="lsTime" type="time" value="13:00"></label>'+
    '</div>'+
    '<div class="row">'+
      '<label>Durata <select class="lsMinutes"><option value="30">30 minuti</option><option value="45">45 minuti</option><option value="60" selected>60 minuti</option><option value="90">90 minuti</option><option value="120">120 minuti</option></select></label>'+
      '<button type="button" class="secondaryBtn lsRemove">Rimuovi</button>'+
    '</div>'+
    '<label>Indirizzo specifico <span class="optional">opzionale</span>'+
      '<input class="lsAddress" id="lsAddr'+i+'" autocomplete="off" placeholder="Es. ristorante, area di servizio, località...">'+
      '<div class="suggestions lsSug" id="lsSug'+i+'"></div>'+
    '</label>';
  $("longStopList").appendChild(row);
  setupSuggestEl(row.querySelector(".lsAddress"), row.querySelector(".lsSug"));
  row.querySelector(".lsRemove").onclick = ()=> row.remove();
  return row;
}
$("addLongStopBtn").onclick = ()=> addLongStopRow();
async function updateFuelPrice(){
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
}
$("fuelBtn").onclick = updateFuelPrice;
$("fuelType").addEventListener("change", updateFuelPrice);
// Aggiornamento automatico all'avvio (se il gate e' attivo e non sei loggato, parte dopo il login).
updateFuelPrice();

// --- Esporta PDF stampabile (stampa del browser -> "Salva come PDF") ---
function escHtml(s){ return String(s==null?"":s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }
function exportPdf(){
  const o=$("origin").value||"—", d=$("destination").value||"—";
  const dt=(($("date").value||"")+" "+($("time").value||"")).trim()||"—";
  const km=($("km").textContent||"—").trim();
  $("printHeader").innerHTML =
    '<div class="phTitle">Road Captain · Itinerario</div>'+
    '<div class="phRow"><strong>Partenza:</strong> '+escHtml(o)+'</div>'+
    '<div class="phRow"><strong>Arrivo:</strong> '+escHtml(d)+'</div>'+
    '<div class="phMeta">Km totali: '+escHtml(km)+'  ·  Riferimento orario: '+escHtml(dt)+'  ·  Stampato il '+new Date().toLocaleString("it-IT")+'</div>';
  setTimeout(()=>window.print(), 60);
}
if($("printBtn")) $("printBtn").addEventListener("click", exportPdf);
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
      origin:$("origin").value,destination:$("destination").value,waypoints:getWaypoints(),date:$("date").value,time:$("time").value,mode:$("mode").value,avoidTolls:$("avoidTolls").checked,
      tankCapacityL:$("tankCapacityL").value,stopEveryKm:$("stopEveryKm").value,forwardWindowKm:$("forwardWindowKm").value,
      consumptionKmL:$("consumptionKmL").value,autonomyKm:updateAutonomy(),fuelPrice:$("fuelPrice").value,fuelType:$("fuelType").value,
      longStops:Array.from(document.querySelectorAll("#longStopList .longStopRow")).map(r=>({type:r.querySelector(".lsType").value, time:r.querySelector(".lsTime").value, minutes:Number(r.querySelector(".lsMinutes").value||0), address:r.querySelector(".lsAddress").value.trim()})).filter(x=>x.minutes>0)
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
    let tollEstimate = null;
    if (d.tolls?.amount !== null && d.tolls?.amount !== undefined) {
      tollAmount = Number(d.tolls.amount);
      $("tolls").textContent = "€ " + tollAmount.toFixed(2);
      $("tolls").title = (d.tolls.source || "") + " - " + (d.tolls.note || "");
    } else if (d.tolls?.available && d.tolls?.estimatedAmount != null) {
      tollEstimate = Number(d.tolls.estimatedAmount);
      $("tolls").textContent = "≈ € " + tollEstimate.toFixed(2);
      $("tolls").title = d.tolls.estimateNote || "Stima approssimativa del pedaggio";
    } else if (d.tolls?.available) {
      $("tolls").textContent = "Presente, N/D";
      $("tolls").title = d.tolls.note || "Pedaggio presente ma importo non disponibile";
    } else {
      $("tolls").textContent = "N/D";
      $("tolls").title = d.tolls?.note || "Pedaggio non disponibile";
    }
    const tollForTotal = tollAmount !== null ? tollAmount : tollEstimate;
    if (tollForTotal !== null && tollForTotal !== undefined) {
      const prefix = (tollAmount === null && tollEstimate !== null) ? "≈ € " : "€ ";
      $("totalCost").textContent = prefix + (fuelCost + tollForTotal).toFixed(2);
    } else {
      $("totalCost").textContent = "—";
    }
    const notice = $("notice");
    if (d.tollNotice && d.tollNotice.text) {
      notice.textContent = d.tollNotice.text;
      notice.className = "notice notice-" + (d.tollNotice.level || "info");
    } else {
      notice.className = "notice hidden";
      notice.textContent = "";
    }
    $("stops").innerHTML=d.stops.map(s=>{
      const prev = Number.isFinite(s.fromPreviousKm) ? ` <small>(+${s.fromPreviousKm.toFixed(1)} km dalla sosta precedente)</small>` : "";
      const eta = s.eta ? `<p><strong>Arrivo sosta:</strong> ${s.eta}</p>` : "";
      const stopDuration = Number.isFinite(Number(s.stopMinutes)) ? `<p><strong>Durata sosta normale:</strong> ${Number(s.stopMinutes)} min</p>` : "";
      const departureEta = s.departureEta ? `<p><strong>Ripartenza prevista:</strong> ${s.departureEta}</p>` : "";
      const long = s.longStopMinutes ? `<p class="longStopNote">Sosta lunga ${s.longStopType || "programmata"}: ${s.longStopMinutes} minuti${s.longStopTargetTime ? `, richiesta intorno alle ${s.longStopTargetTime}` : ""}</p>${s.longStopAddress ? `<p><strong>Indirizzo sosta lunga:</strong> ${s.longStopAddress}</p>` : ""}${s.longStopWarning ? `<p class="longStopWarn">⚠ ${s.longStopWarning}</p>` : ""}` : "";
      return s.status==="CRITICA" ? 
      `<div class="stop"><span class="badge CRITICA">CRITICA</span><strong>km ${s.routeKm}</strong>${prev}<p>${s.message}</p></div>` :
      `<div class="stop"><span class="badge ${s.status}">${s.status}</span><strong>km ${s.routeKm.toFixed(1)} totali</strong>${prev}<h3>${s.displayName || s.name}</h3><p>${s.address}</p>${eta}${stopDuration}${long}${departureEta}<small>${s.brand && s.brand !== (s.displayName || s.name) ? s.brand + " · " : ""}${s.source} | scostamento rotta ${s.offsetMeters} m</small></div>`
    }).join("") || "Nessuna sosta necessaria.";
    const routePois = d.routePois || [];
    $("routePois").innerHTML = routePois.length ? routePois.map((p,i)=>`<div class="poiItem"><span class="poiIco">${poiIcon(p.icon)}</span><div class="poiBody"><strong>${i+1}. ${p.name || "Luogo di interesse"}</strong><p>${p.address || ""}</p><small>km ${Number(p.routeKm||0).toFixed(1)} &middot; fuori rotta ${(Number(p.offsetMeters||0)/1000).toFixed(1)} km &middot; ${p.category || "POI"}${p.rating?` &middot; &#9733; ${Number(p.rating).toFixed(1)}${p.userRatingCount?` (${p.userRatingCount})`:""}`:""}</small></div></div>`).join("") : "Nessun POI vicino alla rotta trovato.";
    renderMap(d);
    log("Calcolo completato. Motore: "+d.mode+".");
  }catch(e){log("Errore: "+e.message);}
};

/* ---- Controllo accessi (codice) ---- */
function showGate(){ const g=$("authGate"); if(g) g.classList.remove("hidden"); }
function hideGate(){ const g=$("authGate"); if(g) g.classList.add("hidden"); }
async function doLogin(){
  const code=$("authCode").value.trim();
  $("authErr").textContent="";
  try{
    const r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code})});
    const d=await r.json();
    if(r.ok&&d.ok){ hideGate(); $("authCode").value=""; updateFuelPrice(); }
    else { $("authErr").textContent=d.error||"Codice non valido"; }
  }catch{ $("authErr").textContent="Errore di rete, riprova."; }
}
async function checkGate(){
  try{
    const r=await fetch("/api/session"); const d=await r.json();
    if(d.gateEnabled && !d.authed) showGate();
  }catch{}
}
if($("authBtn")) $("authBtn").addEventListener("click", doLogin);
if($("authCode")) $("authCode").addEventListener("keydown", e=>{ if(e.key==="Enter") doLogin(); });
checkGate();
