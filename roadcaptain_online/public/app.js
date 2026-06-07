const $ = id => document.getElementById(id);

/* ---- Overlay di caricamento (icona animata + messaggio, home sullo sfondo) ---- */
function showLoader(type, msg){
  const l = $("loader"); if (!l) return;
  l.classList.remove("hidden", "fuel", "route");
  l.classList.add(type);                 // "fuel" (pompa) o "route" (ruota)
  if ($("loaderMsg")) $("loaderMsg").textContent = msg || "";
}
function hideLoader(){ const l = $("loader"); if (l) l.classList.add("hidden"); }

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
// Descrizione sintetica del POI: usa il riassunto reale di Google se disponibile,
// altrimenti una riga generica basata sulla categoria (nessun fatto inventato).
function poiDescription(p){
  if (p && p.summary && String(p.summary).trim()) return String(p.summary).trim();
  const c = (p && p.category || "").toLowerCase();
  const rules = [
    [/castell|fort/, "Castello/fortezza di interesse storico, visibile lungo il percorso."],
    [/torre|tower/, "Torre storica, riconoscibile lungo la strada."],
    [/faro|lighthouse/, "Faro affacciato sulla costa, punto di riferimento panoramico."],
    [/panoram|belvedere|viewpoint|piazzale|piazza/, "Punto panoramico, ottimo per una sosta fotografica."],
    [/chiesa|church|duomo|basilica|cattedral|abbazia|abbey|santuario|culto/, "Edificio religioso di pregio, facciata visibile dal percorso."],
    [/monument|memorial|riferimento|landmark|storico|sito/, "Punto di riferimento storico lungo l'itinerario."],
    [/riserva|nazionale|naturale|oasi/, "Area naturale protetta, paesaggio di interesse."],
    [/parco|giardin|garden/, "Parco o giardino, area verde lungo il percorso."],
    [/cascat|gola|lago|fiume|monte|montagn/, "Elemento naturale paesaggistico visibile lungo la strada."],
  ];
  for (const [re,txt] of rules) if (re.test(c)) return txt;
  return `${(p && p.category) || "Luogo di interesse"} lungo l'itinerario.`;
}

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
    if(d.version && $("appVersion")) $("appVersion").textContent = d.version;
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
const _stopUnitSel = $("stopEveryUnit");
if (_stopUnitSel) _stopUnitSel.addEventListener("change", () => {
  const f = $("stopEveryKm");
  if (_stopUnitSel.value === "h") { if (Number(f.value) > 24) f.value = 2; }
  else { if (Number(f.value) <= 24) f.value = 150; }
});
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

  const addedKeySet = new Set(addedPois.map(x => `${x.lat.toFixed(5)},${x.lng.toFixed(5)}`));
  const points = [];
  if (data.geocoded?.origin) points.push({label:"Partenza", icon:ICONS.pin, ...data.geocoded.origin});
  (data.geocoded?.waypoints || []).forEach((w,i)=>{
    if (w && w.lat != null && addedKeySet.has(`${Number(w.lat).toFixed(5)},${Number(w.lng).toFixed(5)}`)) return; // disegnato in verde sotto
    points.push({label:`Tappa ${i+1}`, icon:ICONS.pin, ...w});
  });
  if (data.geocoded?.destination) points.push({label:"Arrivo", icon:ICONS.flag, ...data.geocoded.destination});
  points.forEach(p => {
    if (!p.lat || !p.lng) return;
    const m = L.marker([p.lat,p.lng], {icon:baseIcon(p.icon, "rc-point-marker", 30)}).bindPopup(`<strong>${p.label}</strong><br>${p.address || ""}`).addTo(map);
    rcMapLayers.push(m); bounds.push([p.lat,p.lng]);
  });

  // POI inseriti nell'itinerario: marker VERDE per distinguerli a colpo d'occhio.
  addedPois.forEach(x => {
    if (!Number.isFinite(x.lat) || !Number.isFinite(x.lng)) return;
    const m = L.circleMarker([x.lat, x.lng], {radius:9, color:"#117a3a", weight:3, fillColor:"#28c463", fillOpacity:.92})
      .bindPopup(`<strong>${x.label}</strong><br><small>Tappa aggiunta all'itinerario</small>`).addTo(map);
    rcMapLayers.push(m); bounds.push([x.lat, x.lng]);
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

  const addedIdSet = new Set(addedPois.map(x => x.key));
  (data.routePois || []).forEach((p, i) => {
    if (!p.lat || !p.lng) return;
    if (addedIdSet.has(poiKey(p)) || addedKeySet.has(`${Number(p.lat).toFixed(5)},${Number(p.lng).toFixed(5)}`)) return; // mostrato in verde
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
async function updateFuelPrice(showOverlay){
  const btn = $("fuelBtn");
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Aggiorno...";
  if (showOverlay) showLoader("fuel", "Sto aggiornando il costo medio nazionale del carburante…");
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
    if (showOverlay) hideLoader();
  }
}
$("fuelBtn").onclick = () => updateFuelPrice(true);
$("fuelType").addEventListener("change", () => updateFuelPrice(true));
// Aggiornamento automatico all'avvio (silenzioso, senza overlay a tutto schermo).
updateFuelPrice(false);

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
// POI inseriti nell'itinerario come tappe (chiave stabile -> coord/etichetta).
let addedPois = [];
let lastPlan = null;
function poiKey(p){ return p.id || `${p.lat},${p.lng}`; }
function isPoiAdded(p){ const k = poiKey(p); return addedPois.some(x => x.key === k); }
function togglePoi(p){
  const k = poiKey(p);
  const i = addedPois.findIndex(x => x.key === k);
  if (i >= 0) addedPois.splice(i, 1);
  else addedPois.push({key:k, lat:Number(p.lat), lng:Number(p.lng), routeKm:Number(p.routeKm)||0, label:p.name||"POI"});
  renderAddedPoiBar();
  runCalc();
}
function renderAddedPoiBar(){
  const bar = $("addedPoiBar"); if (!bar) return;
  if (!addedPois.length){ bar.classList.add("hidden"); bar.innerHTML=""; return; }
  bar.classList.remove("hidden");
  bar.innerHTML = '<span class="apbTitle">Tappe da POI:</span>' + addedPois
    .slice().sort((a,b)=>a.routeKm-b.routeKm)
    .map(x => `<span class="apbChip">${escHtml(x.label)}<button type="button" class="apbX" data-key="${escHtml(x.key)}" title="Rimuovi">&times;</button></span>`).join("");
  bar.querySelectorAll(".apbX").forEach(b => b.addEventListener("click", () => {
    const i = addedPois.findIndex(x => x.key === b.dataset.key);
    if (i >= 0) { addedPois.splice(i,1); renderAddedPoiBar(); runCalc(); }
  }));
}

$("calcBtn").onclick = runCalc;

/* ---- Feedback (recapitato all'autore lato server) ---- */
(function(){
  const open = $("feedbackBtn"), modal = $("feedbackModal");
  if (!open || !modal) return;
  const close = () => modal.classList.add("hidden");
  open.onclick = () => { modal.classList.remove("hidden"); $("fbStatus").textContent = ""; $("fbMessage").focus(); };
  $("fbCancel").onclick = close;
  modal.addEventListener("click", e => { if (e.target === modal) close(); });
  $("fbSend").onclick = async () => {
    const message = $("fbMessage").value.trim();
    if (!message){ $("fbStatus").textContent = "Scrivi un messaggio prima di inviare."; return; }
    $("fbSend").disabled = true; $("fbStatus").textContent = "Invio in corso…";
    try {
      const r = await fetch("/api/feedback", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({message, contact:$("fbContact").value.trim()})});
      const d = await r.json().catch(()=>({}));
      if (r.ok && d.ok){ $("fbStatus").textContent = "Grazie! Feedback inviato."; $("fbMessage").value=""; $("fbContact").value=""; setTimeout(close, 1300); }
      else $("fbStatus").textContent = "Non sono riuscito a inviare: " + (d.error || "riprova più tardi.");
    } catch(e){ $("fbStatus").textContent = "Errore di rete, riprova."; }
    finally { $("fbSend").disabled = false; }
  };
})();

/* ---- Esportazioni: GPX (waypoint + traccia) e link Google Maps ---- */
function xmlEsc(s){ return String(s||"").replace(/[<>&'"]/g, c=>({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c])); }
function buildGpx(d){
  const c = n => Number(n).toFixed(6);
  const wpts = [];
  if (d.geocoded?.origin) wpts.push({lat:d.geocoded.origin.lat, lng:d.geocoded.origin.lng, name:"Partenza"});
  (d.stops||[]).forEach((s,i)=>{ if (s.lat && s.lng && s.status!=="CRITICA") wpts.push({lat:s.lat, lng:s.lng, name:(s.displayName||s.name||`Sosta ${i+1}`)}); });
  addedPois.forEach(x => wpts.push({lat:x.lat, lng:x.lng, name:x.label}));
  if (d.geocoded?.destination) wpts.push({lat:d.geocoded.destination.lat, lng:d.geocoded.destination.lng, name:"Arrivo"});
  // Traccia dal percorso reale; decimata per tenere il file leggero.
  let line = d.route?.polyline || [];
  if (line.length > 2500){ const step = Math.ceil(line.length/2500); line = line.filter((_,i)=> i%step===0 || i===line.length-1); }
  const wptXml = wpts.map(w => `  <wpt lat="${c(w.lat)}" lon="${c(w.lng)}"><name>${xmlEsc(w.name)}</name></wpt>`).join("\n");
  const trk = line.length ? `\n  <trk><name>Road Captain - itinerario</name><trkseg>\n${line.map(p=>`    <trkpt lat="${c(p.lat)}" lon="${c(p.lng)}"></trkpt>`).join("\n")}\n  </trkseg></trk>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Road Captain by Rhegium" xmlns="http://www.topografix.com/GPX/1/1">\n${wptXml}${trk}\n</gpx>\n`;
}
function downloadFile(name, content, mime){
  const blob = new Blob([content], {type:mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 1500);
}
function googleMapsUrl(d){
  const o = d.geocoded?.origin, de = d.geocoded?.destination;
  if (!o || !de) return null;
  // Google Maps accetta poche tappe nell'URL: includo i POI scelti (max 9), non le soste carburante.
  const wp = addedPois.slice().sort((a,b)=>a.routeKm-b.routeKm).slice(0,9).map(x=>`${x.lat},${x.lng}`).join("|");
  let u = `https://www.google.com/maps/dir/?api=1&origin=${o.lat},${o.lng}&destination=${de.lat},${de.lng}&travelmode=driving`;
  if (wp) u += `&waypoints=${encodeURIComponent(wp)}`;
  return u;
}
$("gpxBtn").onclick = () => {
  if (!lastPlan){ log("Calcola prima un itinerario, poi esporta il GPX."); return; }
  downloadFile("road-captain-itinerario.gpx", buildGpx(lastPlan), "application/gpx+xml");
  log("Traccia GPX generata (partenza, soste, POI inseriti, arrivo + percorso).");
};
$("gmapsBtn").onclick = () => {
  if (!lastPlan){ log("Calcola prima un itinerario, poi aprilo in Google Maps."); return; }
  const u = googleMapsUrl(lastPlan);
  if (u) window.open(u, "_blank", "noopener");
  else log("Servono partenza e arrivo per aprire Google Maps.");
};
async function runCalc(){
  showLoader("route", "Sto calcolando il tuo itinerario…");
  log("Calcolo in corso...");
  try{
    const poiWaypoints = addedPois.slice().sort((a,b)=>a.routeKm-b.routeKm).map(x => `${x.lat},${x.lng}`);
    const body={
      origin:$("origin").value,destination:$("destination").value,waypoints:[...getWaypoints(), ...poiWaypoints],date:$("date").value,time:$("time").value,mode:$("mode").value,pace:$("pace").value,avoidTolls:$("avoidTolls").checked,
      tankCapacityL:$("tankCapacityL").value,stopEveryKm:$("stopEveryKm").value,forwardWindowKm:$("forwardWindowKm").value,
      consumptionKmL:$("consumptionKmL").value,autonomyKm:updateAutonomy(),fuelPrice:$("fuelPrice").value,fuelType:$("fuelType").value,stopEveryUnit:$("stopEveryUnit").value,
      longStops:Array.from(document.querySelectorAll("#longStopList .longStopRow")).map(r=>({type:r.querySelector(".lsType").value, time:r.querySelector(".lsTime").value, minutes:Number(r.querySelector(".lsMinutes").value||0), address:r.querySelector(".lsAddress").value.trim()})).filter(x=>x.minutes>0)
    };
    const d=await api("/api/plan",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    lastPlan = d;
    $("km").textContent=d.route.distanceKm.toFixed(1);
    const fmtHM = m => { m = Math.max(0, Math.round(Number(m)||0)); const h=Math.floor(m/60), mm=m%60; return h ? `${h}h ${String(mm).padStart(2,"0")}m` : `${mm}m`; };
    const tt = d.times || {};
    $("drive").textContent = fmtHM(tt.totalMinutes != null ? tt.totalMinutes : d.route.durationHours*60);
    if ($("driveBreak")) $("driveBreak").textContent = (tt.driveMinutes != null) ? `guida ${fmtHM(tt.driveMinutes)} · soste ${fmtHM(tt.pauseMinutes)}` : "";
    $("dep").textContent=d.times.departure; $("arr").textContent=d.times.arrival;
    $("liters").textContent = (d.fuel.liters != null) ? d.fuel.liters.toFixed(1) : "—";
    $("cost").textContent = (d.fuel.cost != null) ? "€ "+d.fuel.cost.toFixed(2) : "—";
    $("autonomyKm").textContent = d.fuel.autonomyKm ? d.fuel.autonomyKm.toFixed(0)+" km" : "—";
    const programmedStops = d.stops.filter(s=>s.status!=="CRITICA").length;
    $("pois").textContent=String(programmedStops);
    const fuelCost = (d.fuel.cost != null) ? Number(d.fuel.cost) : null;
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
    if (fuelCost == null && (tollForTotal == null)) {
      $("totalCost").textContent = "—";
    } else if (tollForTotal !== null && tollForTotal !== undefined) {
      const prefix = (tollAmount === null && tollEstimate !== null) ? "≈ € " : "€ ";
      $("totalCost").textContent = prefix + ((fuelCost||0) + tollForTotal).toFixed(2);
    } else if (fuelCost != null) {
      $("totalCost").textContent = "€ " + fuelCost.toFixed(2);
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
      const leg = (s.legDriveMinutes != null) ? `<p class="legInfo"><strong>Dalla tappa precedente:</strong> guida ${fmtHM(s.legDriveMinutes)}${s.legAvgSpeed ? ` &middot; media <b>${s.legAvgSpeed} km/h</b>` : ""}</p>` : "";
      const eta = s.eta ? `<p><strong>Arrivo sosta:</strong> ${s.eta}</p>` : "";
      const stopDuration = Number.isFinite(Number(s.stopMinutes)) ? `<p><strong>Durata sosta normale:</strong> ${Number(s.stopMinutes)} min</p>` : "";
      const departureEta = s.departureEta ? `<p><strong>Ripartenza prevista:</strong> ${s.departureEta}</p>` : "";
      const long = s.longStopMinutes ? `<p class="longStopNote">Sosta lunga ${s.longStopType || "programmata"}: ${s.longStopMinutes} minuti${s.longStopTargetTime ? `, richiesta intorno alle ${s.longStopTargetTime}` : ""}</p>${s.longStopAddress ? `<p><strong>Indirizzo sosta lunga:</strong> ${s.longStopAddress}</p>` : ""}${s.longStopWarning ? `<p class="longStopWarn">⚠ ${s.longStopWarning}</p>` : ""}` : "";
      return s.status==="CRITICA" ? 
      `<div class="stop"><span class="badge CRITICA">CRITICA</span><strong>km ${s.routeKm}</strong>${prev}<p>${s.message}</p></div>` :
      `<div class="stop"><span class="badge ${s.status}">${s.status}</span><strong>km ${s.routeKm.toFixed(1)} totali</strong>${prev}<h3>${s.displayName || s.name}</h3><p>${s.address}</p>${leg}${eta}${stopDuration}${long}${departureEta}<small>${s.brand && s.brand !== (s.displayName || s.name) ? s.brand + " · " : ""}${s.source} | scostamento rotta ${s.offsetMeters} m</small></div>`
    }).join("") || "Nessuna sosta necessaria.";
    const routePois = d.routePois || [];
    const routeKeys = new Set(routePois.map(poiKey));
    // POI aggiunti ma non piu' presenti nella lista ricalcolata: li tengo "fissati" in cima,
    // sempre rimovibili (cosi' il primo non sparisce quando ne aggiungi un secondo).
    const pinnedHtml = addedPois.filter(x => !routeKeys.has(x.key)).map(x =>
      `<div class="poiItem isAdded pinnedPoi"><span class="poiIco">${poiIcon("attraction")}</span><div class="poiBody"><strong>${escHtml(x.label)}</strong><p><small>Tappa aggiunta all'itinerario · km ${Number(x.routeKm||0).toFixed(1)}</small></p><a class="poiLink" href="https://www.google.com/maps/search/?api=1&query=${x.lat},${x.lng}" target="_blank" rel="noopener">Apri in Maps</a><button type="button" class="poiAdd added" data-key="${escHtml(x.key)}">✓ Rimuovi dall'itinerario</button></div></div>`
    ).join("");
    const routeHtml = routePois.map((p,i)=>{
      const wiki = `https://it.wikipedia.org/w/index.php?search=${encodeURIComponent(p.name||"")}`;
      const maps = (Number.isFinite(p.lat)&&Number.isFinite(p.lng)) ? `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name||"")}`;
      const added = isPoiAdded(p);
      const canAdd = Number.isFinite(p.lat) && Number.isFinite(p.lng);
      const addBtn = canAdd ? `<button type="button" class="poiAdd${added?" added":""}" data-i="${i}">${added?"✓ Rimuovi dall'itinerario":"+ Inserisci nell'itinerario"}</button>` : "";
      return `<div class="poiItem${added?" isAdded":""}"><span class="poiIco">${poiIcon(p.icon)}</span><div class="poiBody"><strong>${i+1}. ${p.name || "Luogo di interesse"}</strong><p>${p.address || ""}</p><small>km ${Number(p.routeKm||0).toFixed(1)} &middot; fuori rotta ${(Number(p.offsetMeters||0)/1000).toFixed(1)} km &middot; ${p.category || "POI"}${p.rating?` &middot; &#9733; ${Number(p.rating).toFixed(1)}${p.userRatingCount?` (${p.userRatingCount})`:""}`:""} &middot; <span class="poiToggle">cos'è?</span></small><div class="poiDesc">${escHtml(poiDescription(p))}<div class="poiLinks"><a href="${wiki}" target="_blank" rel="noopener">Wikipedia</a><a href="${maps}" target="_blank" rel="noopener">Apri in Maps</a></div></div>${addBtn}</div></div>`;
    }).join("");
    $("routePois").innerHTML = (pinnedHtml + routeHtml) || "Nessun POI vicino alla rotta trovato.";
    $("routePois").querySelectorAll(".poiItem").forEach(el => el.addEventListener("click", (e) => { if (e.target.closest("a") || e.target.closest(".poiAdd")) return; el.classList.toggle("open"); }));
    $("routePois").querySelectorAll(".poiAdd[data-i]").forEach(btn => btn.addEventListener("click", (e) => { e.stopPropagation(); togglePoi(routePois[Number(btn.dataset.i)]); }));
    $("routePois").querySelectorAll(".poiAdd[data-key]").forEach(btn => btn.addEventListener("click", (e) => { e.stopPropagation(); const i = addedPois.findIndex(x=>x.key===btn.dataset.key); if(i>=0){ addedPois.splice(i,1); renderAddedPoiBar(); runCalc(); } }));
    renderAddedPoiBar();
    renderMap(d);
    log("Calcolo completato. Motore: "+d.mode+".");
  }catch(e){log("Errore: "+e.message);}finally{hideLoader();}
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
    if(r.ok&&d.ok){ hideGate(); $("authCode").value=""; updateFuelPrice(false); }
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

// In stampa la mappa cambia dimensione (pagina intera): forza Leaflet a ridisegnare le tiles.
window.addEventListener("beforeprint", ()=>{ try{ if(rcMap) rcMap.invalidateSize(false); }catch(e){} });
window.addEventListener("afterprint", ()=>{ try{ if(rcMap) rcMap.invalidateSize(false); }catch(e){} });
