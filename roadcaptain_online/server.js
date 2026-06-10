
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cumulativeKm, pointAtKm, locateOnRouteKm, planStops, calculateAutonomyKm } from "./engine.js";
import { addMinutes, fmtRome, parseRomeDateTime } from "./time-utils.js";
import { extractGoogleTollInfo, estimateAspitollClassA } from "./toll-utils.js";
import { parseAccessCodes, findCode, signSession, verifySession, parseCookies, clientIp } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const PORT = process.env.PORT || 10000;
const APP_VERSION = "7.0.0";
const GOOGLE_KEY = (process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_KEY || process.env.MAPS_API_KEY || "").trim();
const MIMIT_PRICE_URL = "https://www.mimit.gov.it/images/exportCSV/prezzo_alle_8.csv";
// Wikipedia richiede uno User-Agent descrittivo con un riferimento di contatto/progetto.
const WIKI_UA = "RoadCaptainByRhegium/1.0 (https://road-captain-by-rhegium.onrender.com; trip planner)";
let mimitFuelCache = {ts:0, text:null};

// --- Controllo accessi (codice) ---
const ACCESS_CODES = parseAccessCodes(process.env.ACCESS_CODES || process.env.ACCESS_CODE || "");
const GATE_ON = ACCESS_CODES.length > 0;                 // protezione attiva solo se sono configurati codici
const SESSION_SECRET = (process.env.SESSION_SECRET || ACCESS_CODES.map(c=>c.code).join("|") || "road-captain").trim();
const ADMIN_CODE = (process.env.ADMIN_CODE || "").trim();
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
const SESSION_COOKIE = "rc_sess";
const accessLog = [];                                    // log recente in memoria (non persistente)
function logAccess(entry){ accessLog.push({ts:new Date().toISOString(), ...entry}); if (accessLog.length > 300) accessLog.shift(); }
// Feedback: destinatario tenuto SOLO lato server (mai inviato al client).
const FEEDBACK_TO = "a.travia+rc@gmail.com";
const feedbackStore = [];

// --- Cache Places per PERCORSO (azzera i costi sui ricalcoli) ---
// Le chiamate a pagamento sono i due collector Places (carburante Pro + POI Enterprise).
// Cambiare andatura/autonomia/intervallo/soste NON cambia il percorso: stessa polyline,
// stessi POI e stesse aree. Qui le raccolgo UNA volta per percorso e le riuso, cosi' i
// ricalcoli non rifanno chiamate Google. Chiave = punti (origine/arrivo/tappe) + pedaggi + carburante.
const planCache = new Map();                 // key -> {ts, route, pois, routePois}
const PLAN_CACHE_TTL_MS = 60 * 60 * 1000;    // 60 minuti
const PLAN_CACHE_MAX = 60;
function roundCoord(p){ return p && Number.isFinite(p.lat) && Number.isFinite(p.lng) ? `${(+p.lat).toFixed(5)},${(+p.lng).toFixed(5)}` : ""; }
function planCacheKey(origin, destination, waypoints, avoidTolls, fuelType){
  return JSON.stringify({o:roundCoord(origin), d:roundCoord(destination), w:(waypoints||[]).map(roundCoord), t:!!avoidTolls, f:fuelType||"benzina"});
}
function planCacheGet(key){
  const e = planCache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > PLAN_CACHE_TTL_MS){ planCache.delete(key); return null; }
  planCache.delete(key); planCache.set(key, e);   // LRU: rinfresca posizione
  return e;
}
function planCacheSet(key, val){
  planCache.set(key, {ts:Date.now(), ...val});
  while (planCache.size > PLAN_CACHE_MAX){ planCache.delete(planCache.keys().next().value); }
}
function sessionFromReq(req){
  if (!GATE_ON) return {valid:true, label:"(aperto)"};
  const cookies = parseCookies(req.headers.cookie);
  return verifySession(cookies[SESSION_COOKIE], SESSION_SECRET);
}

function send(res, status, data, type="application/json") {
  res.writeHead(status, {"Content-Type": type, "Access-Control-Allow-Origin":"*"});
  res.end(type === "application/json" ? JSON.stringify(data) : data);
}
function fail(res, status, message, detail=null) { send(res, status, {ok:false, error:message, detail}); }
async function getJson(url, options={}) {
  const headers = {"User-Agent":"RoadCaptainByRhegium/3.1.3", ...(options.headers||{})};
  const r = await fetch(url, {...options, headers});
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = {raw:text}; }
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${text.slice(0,250)}`);
  return data;
}
function decodeGooglePolyline(str) {
  let index = 0, lat = 0, lng = 0, coordinates = [];
  while (index < str.length) {
    let b, shift = 0, result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    const dlat = ((result & 1) ? ~(result >> 1) : (result >> 1)); lat += dlat;
    shift = 0; result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    const dlng = ((result & 1) ? ~(result >> 1) : (result >> 1)); lng += dlng;
    coordinates.push({lat: lat / 1e5, lng: lng / 1e5});
  }
  return coordinates;
}
async function geocodeGoogle(address) {
  const data = await getJson("https://maps.googleapis.com/maps/api/geocode/json?address=" + encodeURIComponent(address) + "&region=it&key=" + GOOGLE_KEY);
  if (data.status !== "OK" || !data.results?.length) throw new Error(`Geocoding Google fallito: ${data.status}`);
  const r = data.results[0];
  return {address:r.formatted_address, lat:r.geometry.location.lat, lng:r.geometry.location.lng, place_id:r.place_id, source:"Google"};
}
async function geocodeFallback(address) {
  const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=it&q=" + encodeURIComponent(address);
  const d = await getJson(url);
  if (!Array.isArray(d) || !d.length) throw new Error("Geocoding fallback non ha trovato indirizzo.");
  return {address:d[0].display_name, lat:Number(d[0].lat), lng:Number(d[0].lon), source:"Nominatim fallback"};
}
async function geocode(address) {
  // Waypoint da coordinate (es. POI inserito nell'itinerario): "lat,lng" -> usa direttamente.
  const m = String(address || "").trim().match(/^(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)$/);
  if (m) return {lat:parseFloat(m[1]), lng:parseFloat(m[2]), address:`${m[1]},${m[2]}`};
  return GOOGLE_KEY ? geocodeGoogle(address) : geocodeFallback(address);
}
async function suggestGoogle(q) {
  const data = await getJson("https://maps.googleapis.com/maps/api/place/autocomplete/json?input=" + encodeURIComponent(q) + "&language=it&components=country:it&types=geocode|establishment&key=" + GOOGLE_KEY);
  if (data.status !== "OK" && data.status !== "ZERO_RESULTS") throw new Error(`Places autocomplete: ${data.status}`);
  return (data.predictions || []).slice(0,6).map(p => ({description:p.description, source:"Google"}));
}
async function suggestFallback(q) {
  const url = "https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=6&countrycodes=it&q=" + encodeURIComponent(q);
  const d = await getJson(url);
  return (Array.isArray(d) ? d : []).map(x => ({description:x.display_name, source:"Nominatim"}));
}
async function routeGoogle(origin, destination, waypoints=[], opts={}) {
  const routeModifiers = {vehicleInfo: {emissionType: "GASOLINE"}};
  if (opts.avoidTolls) routeModifiers.avoidTolls = true;
  const body = {
    origin: {location:{latLng:{latitude:origin.lat, longitude:origin.lng}}},
    destination: {location:{latLng:{latitude:destination.lat, longitude:destination.lng}}},
    intermediates: waypoints.map(w => ({location:{latLng:{latitude:w.lat, longitude:w.lng}}})),
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_AWARE",
    computeAlternativeRoutes: false,
    languageCode: "it-IT",
    units: "METRIC",
    polylineQuality: "HIGH_QUALITY",
    polylineEncoding: "ENCODED_POLYLINE",
    extraComputations: ["TOLLS"],
    routeModifiers
  };
  const data = await getJson("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "X-Goog-Api-Key": GOOGLE_KEY,
      "X-Goog-FieldMask": "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.travelAdvisory.tollInfo"
    },
    body: JSON.stringify(body)
  });
  if (!data.routes?.length) throw new Error("Nessuna rotta restituita da Google Routes.");
  const r = data.routes[0];
  const meters = r.distanceMeters || 0;
  const seconds = Number(String(r.duration || "0s").replace("s","")) || 0;
  return {distanceKm: meters/1000, durationHours: seconds/3600, polyline: decodeGooglePolyline(r.polyline.encodedPolyline), tollInfo: r.travelAdvisory?.tollInfo || null, avoidTollsApplied: Boolean(opts.avoidTolls), source:"Google Routes"};
}
async function routeFallback(origin, destination, waypoints=[], opts={}) {
  const coords = [origin, ...waypoints, destination].map(p => `${p.lng},${p.lat}`).join(";");
  const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`;
  const data = await getJson(url);
  if (data.code !== "Ok" || !data.routes?.length) throw new Error("OSRM fallback non ha trovato una rotta.");
  const r = data.routes[0];
  const polyline = r.geometry.coordinates.map(([lng,lat]) => ({lat,lng}));
  return {distanceKm:r.distance/1000, durationHours:r.duration/3600, polyline, tollInfo:null, avoidTollsApplied:false, source:"OSRM fallback"};
}
async function route(origin, destination, waypoints=[], opts={}) {
  return GOOGLE_KEY ? routeGoogle(origin,destination,waypoints,opts) : routeFallback(origin,destination,waypoints,opts);
}
async function nearbyGasGoogle(lat, lng, fuelType) {
  const body = {
    includedTypes: ["gas_station"],
    maxResultCount: 20,
    locationRestriction: {circle:{center:{latitude:lat, longitude:lng}, radius: 6000}},
    languageCode: "it"
  };
  const data = await getJson("https://places.googleapis.com/v1/places:searchNearby", {
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "X-Goog-Api-Key": GOOGLE_KEY,
      "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location,places.id"
    },
    body: JSON.stringify(body)
  });
  return (data.places || []).map(p => ({
    id:p.id, name:p.displayName?.text || "Stazione carburante", address:p.formattedAddress || "",
    lat:p.location?.latitude, lng:p.location?.longitude, source:"Google Places", fuelType
  })).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}
async function nearbyGasFallback(lat,lng,fuelType) {
  const q = `[out:json][timeout:20];node(around:3500,${lat},${lng})[amenity=fuel];out center tags 20;`;
  const data = await getJson("https://overpass-api.de/api/interpreter", {method:"POST", body:q, headers:{"Content-Type":"text/plain"}});
  return (data.elements||[]).map(e => ({
    id:String(e.id), name:e.tags?.name || "Distributore", address:"", lat:e.lat, lng:e.lon,
    source:"Overpass fallback", fuelType
  }));
}
// Esegue fn su tutti gli item con al massimo `limit` chiamate in volo: accelera
// molto le richieste Places (decine di campioni lungo la rotta) senza raffiche.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker(){ while (i < items.length){ const idx = i++; out[idx] = await fn(items[idx], idx); } }
  await Promise.all(Array.from({length: Math.max(1, Math.min(limit, items.length))}, worker));
  return out;
}

async function collectFuelPois(polyline, cum, routeKm, fuelType) {
  const seen = new Map();
  const sampleStep = GOOGLE_KEY ? 35 : 30;
  const points = [];
  for (let km = 15; km < routeKm; km += sampleStep) { const p = pointAtKm(polyline, cum, km); if (p) points.push(p); }
  const batches = await mapLimit(points, 6, async (p) => {
    try { return GOOGLE_KEY ? await nearbyGasGoogle(p.lat, p.lng, fuelType) : await nearbyGasFallback(p.lat,p.lng,fuelType); } catch { return []; }
  });
  for (const pois of batches) {
    for (const poi of pois) {
      const loc = locateOnRouteKm({lat:poi.lat,lng:poi.lng}, polyline, cum);
      const onMotorway = /autostrada|\ba\d{1,2}\b|raccordo|area\s+(?:di\s+)?servizio/i.test(`${poi.name||""} ${poi.address||""}`);
      // Le VERE aree di servizio autostradali stanno spesso a 200-400 m dalla polilinea
      // semplificata di Google: tollerare solo 150 m le scartava, lasciando buchi enormi.
      // Aree autostradali: fino a 800 m. Benzinai generici: 150 m stretti (escludono le
      // stazioni su strade parallele, vicine in linea d'aria ma raggiungibili solo uscendo).
      const maxOffKm = onMotorway ? 0.8 : 0.15;
      if (loc.distKm <= maxOffKm) {
        const key = poi.id || `${poi.name}-${poi.lat.toFixed(4)}-${poi.lng.toFixed(4)}`;
        // Lato di marcia (in Italia si guida a destra: l'area giusta e' a DESTRA). Finestra
        // ampia (±1 km) per stabilizzare la direzione sulla polilinea semplificata.
        const a = pointAtKm(polyline, cum, Math.max(0, loc.km - 1.0));
        const c = pointAtKm(polyline, cum, loc.km + 1.0);
        let side = "unknown";
        if (a && c) {
          const dx = c.lng - a.lng, dy = c.lat - a.lat;
          const vx = poi.lng - a.lng, vy = poi.lat - a.lat;
          const cross = dx*vy - dy*vx;            // <0 = destra del senso di marcia, >0 = sinistra
          if (Math.abs(cross) > 1e-9) side = cross < 0 ? "right" : "left";
        }
        if (!seen.has(key)) seen.set(key, {...poi, routeKm:loc.km, offsetMeters:Math.round(loc.distKm*1000), onMotorway, side});
      }
    }
  }
  return [...seen.values()].sort((a,b)=>a.routeKm-b.routeKm);
}

// Classifica un titolo Wikipedia in una categoria/tipo riconoscibile "di passaggio".
// Wikipedia restituisce qualunque voce con coordinate (anche paesi, fiumi, stazioni): qui
// teniamo solo i tipi-landmark; il generico ("Localita'") viene poi scartato da isLandmarkVisible.
export function classifyWikiTitle(title = "") {
  const t = " " + String(title).toLowerCase() + " ";
  const out = (category, type) => ({category, primaryType:type, types:[type]});
  if (/castell|\brocca\b|fortezz|\bforte\b|\btorre |torrione|bastion/.test(t)) return out("Castello", "castle");
  if (/duomo|cattedral|basilica|abbazia|santuario|chiesa|battister|collegiata|convento|monaster|certosa|\bpieve\b|tempio/.test(t)) return out("Luogo di culto", "church");
  if (/parco nazionale|riserva natural|\boasi\b|area marina|parco regional/.test(t)) return out("Area naturale protetta", "national_park");
  if (/\blago\b|cascat|\bgola\b|\bgole |grott|\bmonte\b|massiccio|vulcano|\bcima\b|altopiano|riviera|promontorio/.test(t)) return out("Natura", "viewpoint");
  if (/\bparco\b|giardin|orto botanico/.test(t)) return out("Parco", "park");
  if (/\bponte\b|acquedotto|\bfaro\b|\bmura\b|cinta muraria|anfiteatro|\barena\b|teatro romano|necropoli|sito archeolog|villa romana|terme romane/.test(t)) return out("Sito storico", "historic");
  if (/\bpiazza\b|palazzo|\bvilla\b|\bborgo\b|centro storico|monument|fontana|obelisco|arco di/.test(t)) return out("Luogo storico", "historic");
  if (/\bmuseo\b|pinacotec|galleria d'arte/.test(t)) return out("Museo", "museum"); // poi escluso (non visibile di passaggio)
  return out("Localita'", "locality"); // generico -> scartato da isLandmarkVisible
}

// Attrazioni da Wikipedia (geosearch) — GRATIS, nessuna chiave. Restituisce le voci con
// pagina vicino al punto: una pagina Wikipedia implica notabilita', quindi qualita' molto
// migliore dei nodi grezzi OSM. Raggio massimo geosearch = 10 km.
async function nearbyAttractionsWikipedia(lat, lng) {
  const url = `https://it.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&list=geosearch&gscoord=${lat}%7C${lng}&gsradius=10000&gslimit=20`;
  const data = await getJson(url, {headers:{"User-Agent": WIKI_UA}});
  const list = (data && data.query && data.query.geosearch) || [];
  return list.map(g => {
    const cls = classifyWikiTitle(g.title);
    return {
      id: "wp" + g.pageid, pageid: g.pageid, name: g.title, address: "",
      category: cls.category, primaryType: cls.primaryType, types: cls.types,
      rating: 0, userRatingCount: 0, lat: g.lat, lng: g.lon,
      wikipediaUrl: "https://it.wikipedia.org/?curid=" + g.pageid, source: "Wikipedia"
    };
  }).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

// Arricchisce i POI scelti con l'incipit della voce (descrizione reale, niente testo generico).
// Una sola chiamata batch per tutti gli id. Best-effort: in caso di errore i POI restano senza estratto.
async function enrichWikipediaExtracts(items) {
  const ids = (items || []).map(x => x.pageid).filter(Boolean);
  if (!ids.length) return items;
  try {
    const url = `https://it.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&prop=extracts&exintro=1&explaintext=1&exsentences=2&pageids=${encodeURIComponent(ids.join("|"))}`;
    const data = await getJson(url, {headers:{"User-Agent": WIKI_UA}});
    const pages = (data && data.query && data.query.pages) || [];
    const byId = {};
    for (const p of pages) byId[p.pageid] = (p.extract || "").trim();
    for (const it of items) if (it.pageid && byId[it.pageid]) it.description = byId[it.pageid];
  } catch (e) { /* best-effort */ }
  return items;
}

// Rilevanza per la scelta del POI "migliore" per segmento: priorita' per tipo (riconoscibilita'
// di passaggio). La vecchia formula su voto/recensioni Google resta solo per retrocompatibilita'.
export function attractionScore(item) {
  const rating = Number(item.rating) || 0;
  const votes = Number(item.userRatingCount) || 0;
  if (rating > 0 || votes > 0) return (rating || 3.5) * Math.log10(votes + 10);
  const t = `${(item.types || []).join(" ")} ${item.primaryType || ""} ${item.category || ""}`.toLowerCase();
  let s = 1;
  if (/castle|fort|tower|castell|rocca|fortezz|torre/.test(t)) s += 3;
  else if (/church|duomo|cattedral|basilica|abbazia|santuario/.test(t)) s += 2.5;
  else if (/national_park|riserva|oasi/.test(t)) s += 2.5;
  else if (/viewpoint|panoram|lago|cascat|gola|grott|monte/.test(t)) s += 2;
  else if (/historic|monument|palazzo|villa|piazza|borgo|ponte|faro/.test(t)) s += 1.5;
  else if (/park|parco|giardin/.test(t)) s += 1.5;
  const tags = item.tags || {};
  if (tags.wikidata || tags.wikipedia) s += 1;
  if (item.name && item.name !== "Localita'") s += 0.3;
  return s;
}
// Categoria stabile del luogo (chiave): il frontend la traduce in un'icona SVG.
export function attractionIcon(item) {
  const t = `${(item.types || []).join(" ")} ${item.primaryType || ""} ${item.category || ""}`.toLowerCase();
  const has = re => re.test(t);
  if (has(/museum|gallery|museo|galler/)) return "museum";
  if (has(/park|garden|national_park|parco|giardin/)) return "park";
  if (has(/church|temple|mosque|synagogue|worship|chiesa|tempio|santuario|duomo|cattedral|abbazia|basilica/)) return "church";
  if (has(/castle|fort|tower|castello|forte|torre/)) return "castle";
  if (has(/viewpoint|scenic|panoram|belvedere|natura/)) return "viewpoint";
  if (has(/beach|spiagg|cala|lido/)) return "beach";
  if (has(/historic|landmark|monument|memorial|storic/)) return "historic";
  return "poi";
}
// "Visibile di passaggio": castelli, torri, fari, panorami, monumenti, chiese/abbazie, parchi,
// riserve. ESCLUDE cio' che richiede di fermarsi ed entrare (musei, terme, acquari, zoo, hotel...).
export function isLandmarkVisible(item) {
  const t = `${(item.types || []).join(" ")} ${item.primaryType || ""} ${item.category || ""}`.toLowerCase();
  if (/muse|galler|cantina|vinicol|winery|enotec|\bspa\b|terme|balneo|stabiliment|acquario|aquarium|\bzoo\b|acquatic|water_?park|divertiment|amusement|hotel|alberg|ristorant|restaurant|negozio|store|\bshop\b|attività sportive|\bsport|area picnic|picnic|cimiter|cemeter/.test(t)) return false;
  if (/\bcastle\b|\bchurch\b|\bpark\b|\bgarden\b|\bnational_park\b|\bviewpoint\b|\bhistoric\b|castell|fort|torre|tower|faro|lighthouse|ponte|bridge|monument|memorial|landmark|panoram|belvedere|scenic|chiesa|church|duomo|basilica|cattedral|abbazia|abbey|santuario|tempio|riserva|parco nazionale|national_park|cascat|gola|lago|montagn|natura|attrazione turistica|tourist_attraction/.test(t)) return true;
  return false;
}
// ~10 POI piu' rilevanti ma EQUAMENTE distribuiti su tutto l'itinerario: divide la rotta
// in 'count' segmenti uguali e in ognuno sceglie il landmark visibile piu' rilevante,
// preferendo quelli davvero sul tracciato (<=3 km) e allargando solo se il segmento e' vuoto.
export function distributeAttractions(items, routeKm, count = 10) {
  const visible = (items || []).filter(isLandmarkVisible);
  if (!visible.length) return [];
  const n = Math.max(1, count);
  const segLen = (routeKm || n) / n;
  const chosen = [];
  for (let i = 0; i < n; i++) {
    const lo = i * segLen, hi = (i + 1) * segLen;
    const inSeg = visible.filter(p => {
      const k = Number(p.routeKm) || 0;
      return k >= lo && (i === n - 1 ? k <= hi + 1 : k < hi);
    });
    if (!inSeg.length) continue;
    const near = inSeg.filter(p => Number(p.offsetMeters || 0) <= 3000);
    const pool = near.length ? near : inSeg;
    pool.sort((a, b) => (b.score || 0) - (a.score || 0));
    chosen.push(pool[0]);
  }
  return chosen.sort((a, b) => (a.routeKm || 0) - (b.routeKm || 0));
}
async function collectRouteAttractions(polyline, cum, routeKm) {
  const seen = new Map();
  const sampleStep = 20;                 // geosearch Wikipedia: raggio max 10 km
  const points = [];
  for (let km = 15; km < routeKm; km += sampleStep) { const p = pointAtKm(polyline, cum, km); if (p) points.push(p); }
  const batches = await mapLimit(points, 4, async (p) => {
    try { return await nearbyAttractionsWikipedia(p.lat, p.lng); } catch { return []; }
  });
  for (const items of batches) {
    for (const item of items) {
      const loc = locateOnRouteKm({lat:item.lat,lng:item.lng}, polyline, cum);
      // Raccolta generosa (<=8 km): la scelta per segmento preferira' i piu' sul tracciato.
      if (loc.distKm <= 8) {
        const key = item.id || `${item.name}-${item.lat.toFixed(4)}-${item.lng.toFixed(4)}`;
        if (!seen.has(key)) seen.set(key, {...item, routeKm:Number(loc.km.toFixed(1)), offsetMeters:Math.round(loc.distKm*1000), score:attractionScore(item), icon:attractionIcon(item)});
      }
    }
  }
  const chosen = distributeAttractions([...seen.values()], routeKm, 10);
  await enrichWikipediaExtracts(chosen);   // descrizioni reali dall'incipit della voce
  return chosen;
}

function titleCaseIt(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim()
    .replace(/\b([a-zàèéìòù])/g, m => m.toUpperCase());
}
// Sembra una ragione sociale (operatore) piu' che un toponimo? (Snc, Srl, SpA, & C, ...)
function looksLikeCompany(s){
  return /\b(s\.?n\.?c\.?|s\.?r\.?l\.?|s\.?p\.?a\.?|s\.?a\.?s\.?|soc\.?|&\s?c\b|carburanti|petrol|petroli|oil|energia|distribuzione)\b/i.test(s)
    || /&/.test(s);
}
// Estrae il nome dell'area di servizio. Se Google la nomina con l'operatore
// ("Area di servizio Biondi Antonio & C Snc"), preferisce il toponimo geografico
// che di solito sta nell'indirizzo ("...La Macchia Ovest").
// Parole "rumore" da scartare quando si cerca il toponimo dell'area autostradale.
const SA_NOISE = new Set(["shop","bar","area","stazione","servizio","di","del","della","sole","ads",
  "autostrada","eni","ip","q8","esso","tamoil","agip","api","gpl","gruppo","petroli","petrol",
  "carburanti","distributore","via","viale","piazza","contrada","localita","loc","strada","km","snc","srl"]);
// Estrae aree autostradali tipo "Arda Est", "La Macchia Est" dal pattern "<toponimo> Est/Ovest/Nord/Sud".
// Attivo SOLO in contesto autostradale (A<n>, autostrada, raccordo, area di servizio) per non
// scambiare nomi di strada tipo "Via Nazionale Nord" per aree di servizio.
function directionAreaName(text) {
  if (!/autostrada|\ba\d{1,2}\b|raccordo|area\s+(?:di\s+)?servizio/i.test(text)) return "";
  const tokens = text.replace(/[(),]/g, " ").split(/\s+/).filter(Boolean);
  const dirs = new Set(["est", "ovest", "nord", "sud"]);
  for (let i = 0; i < tokens.length; i++) {
    if (!dirs.has(tokens[i].toLowerCase().replace(/[.,]/g, ""))) continue;
    const prev = (tokens[i - 1] || "").toLowerCase();
    if (prev === "dir" || prev === "dir." || /-/.test(tokens[i - 1] || "")) continue; // evita "dir. Nord-Ovest"
    const before = [];
    for (let j = i - 1; j >= 0 && before.length < 3; j--) {
      const wl = tokens[j].toLowerCase().replace(/[.,]/g, "");
      if (!wl) continue;
      if (SA_NOISE.has(wl) || /^a\d{1,2}$/.test(wl) || /^ss\d*/.test(wl) || /^sp\d*/.test(wl) || /^\d/.test(wl)) {
        if (before.length) break; else continue;
      }
      before.unshift(tokens[j].replace(/[.,]/g, ""));
    }
    if (before.length) return `${before.join(" ")} ${tokens[i].replace(/[.,]/g, "")}`;
  }
  return "";
}
function serviceAreaName(name="", address="") {
  const text = `${name} , ${address}`.replace(/\s+/g, " ");
  const re = /(?:area\s+(?:di\s+)?servizio|a\.?\s?d\.?\s?s\.?)\s+(.+?)(?=,|\s+(?:a\d{1,2}\b|ss\.?\d|sp\.?\d|via\b|strada\b|km\b|\d{5})|$)/ig;
  const candidates = [];
  let m;
  while ((m = re.exec(text))) { const c = m[1].trim(); if (c) candidates.push(c); }
  const best = candidates.find(c => !looksLikeCompany(c)) || candidates[0];
  if (best) return titleCaseIt(best);
  const dir = directionAreaName(text);
  if (dir) return titleCaseIt(dir);
  return "";
}
// Comune dall'indirizzo Google: "..., 84025 Eboli SA, Italia" -> "Eboli".
function localityFromAddress(address="") {
  const m = String(address).match(/\b\d{5}\s+([^,]+?)\s+[A-Z]{2}\b/);
  return m ? titleCaseIt(m[1]) : "";
}
// Titolo della sosta: prima l'area di servizio, poi il comune, infine il nome grezzo.
// Il marchio (Esso/Eni/IP) NON e' il titolo: resta come dettaglio secondario.
export function normalizeServiceAreaName(name="", address="") {
  return serviceAreaName(name, address) || localityFromAddress(address) || String(name || "").trim() || "Sosta carburante";
}

// Quando una sosta in autostrada non ha un nome-area estraibile (resta il comune, es. "Marzi"),
// chiede a Google il vero nome dell'area di servizio piu' vicina a quel punto (es. "Rogliano Ovest").
// Le coordinate disambiguano la carreggiata (Est/Ovest). Fail-safe: in caso di errore ritorna "".
async function lookupServiceAreaName(lat, lng) {
  if (!GOOGLE_KEY || !Number.isFinite(lat) || !Number.isFinite(lng)) return "";
  try {
    const data = await getJson("https://places.googleapis.com/v1/places:searchText", {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "X-Goog-Api-Key": GOOGLE_KEY,
        "X-Goog-FieldMask": "places.displayName,places.formattedAddress"
      },
      body: JSON.stringify({
        textQuery: "area di servizio autostrada",
        locationBias: { circle: { center:{latitude:lat, longitude:lng}, radius: 1500 } },
        maxResultCount: 3,
        languageCode: "it"
      })
    });
    for (const p of (data.places || [])) {
      const nm = serviceAreaName(p.displayName?.text || "", p.formattedAddress || "");
      if (nm) return nm;
    }
  } catch {}
  return "";
}

function parseDelimitedLine(line, sep="|") {
  const out = [];
  let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === sep && !quoted) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(x => x.trim());
}
function median(values) {
  if (!values.length) return null;
  const a = [...values].sort((x,y)=>x-y);
  const mid = Math.floor(a.length/2);
  return a.length % 2 ? a[mid] : (a[mid-1] + a[mid]) / 2;
}
function fuelMatcher(type) {
  const t = String(type || "benzina").toLowerCase();
  if (t === "diesel") return name => {
    const n = name.toLowerCase();
    return (n === "gasolio" || n === "diesel") && !n.includes("blue") && !n.includes("premium") && !n.includes("special");
  };
  if (t === "gpl") return name => name.toLowerCase() === "gpl";
  if (t === "metano") return name => name.toLowerCase().includes("metano");
  return name => name.toLowerCase() === "benzina";
}
export function parseMimitFuelPriceCsv(csvText, type="benzina") {
  const lines = String(csvText || "").split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  if (!lines.length) throw new Error("CSV MIMIT vuoto");
  const first = parseDelimitedLine(lines[0]);
  const hasHeader = first.some(x => /desc|carburante|prezzo|self/i.test(x));
  const start = hasHeader ? 1 : 0;
  const match = fuelMatcher(type);
  const prices = [];
  for (let i = start; i < lines.length; i++) {
    const row = parseDelimitedLine(lines[i]);
    if (row.length < 3) continue;
    const fuelName = row[1] || "";
    const price = Number(String(row[2] || "").replace(",", "."));
    const isSelf = String(row[3] ?? "").trim();
    if (!match(fuelName)) continue;
    if (isSelf !== "1") continue;
    if (!Number.isFinite(price) || price <= 0.2 || price >= 4) continue;
    prices.push(price);
  }
  const price = median(prices);
  if (!price) throw new Error(`Nessun prezzo MIMIT valido per ${type}`);
  return {price:Number(price.toFixed(3)), samples:prices.length};
}
async function getMimitFuelPrice(type="benzina") {
  const now = Date.now();
  if (!mimitFuelCache.text || now - mimitFuelCache.ts > 6 * 60 * 60 * 1000) {
    const r = await fetch(MIMIT_PRICE_URL, {headers:{"User-Agent":"RoadCaptainByRhegium/3.1.3"}});
    if (!r.ok) throw new Error(`MIMIT non raggiungibile: ${r.status} ${r.statusText}`);
    mimitFuelCache = {ts:now, text:await r.text()};
  }
  return parseMimitFuelPriceCsv(mimitFuelCache.text, type);
}

function buildTollSummary(routeData) {
  const google = extractGoogleTollInfo(routeData.tollInfo);
  if (google.available && google.amount !== null) return google;
  if (google.available) return google;
  if (routeData.source === "Google Routes") {
    return {available:false, amount:0, currency:"EUR", source:"Google Routes tollInfo", note:"Nessun pedaggio indicato per la rotta"};
  }
  return {available:false, amount:null, currency:null, source:"Fallback gratuito", note:"Pedaggio non calcolabile senza Google Routes o fonte pedaggi esterna"};
}

// Messaggio per l'opzione "evita pedaggi": comunica se il percorso e' davvero
// gratuito o se e' solo il piu' economico (pedaggio inevitabile).
export function buildTollNotice({avoidTolls, tolls, source}) {
  if (!avoidTolls) return null;
  if (source !== "Google Routes") {
    return {level:"info", text:"L'opzione \"evita pedaggi\" funziona solo con Google Routes attivo. Percorso calcolato senza evitarli."};
  }
  const amount = tolls && typeof tolls.amount === "number" ? tolls.amount : null;
  if (amount && amount > 0) {
    return {level:"warn", text:`Non esiste un percorso totalmente senza pedaggi: questo e' il piu' economico trovato (pedaggio stimato € ${amount.toFixed(2)}).`};
  }
  if (tolls && tolls.available && amount === null) {
    return {level:"warn", text:"Pedaggio inevitabile su questo percorso: e' stato scelto il piu' economico (importo non stimabile)."};
  }
  return {level:"ok", text:"Percorso calcolato evitando i pedaggi: nessun pedaggio previsto."};
}

// Quando Google segnala un pedaggio ma non ne fornisce l'importo, allega una
// stima approssimativa (tariffa classe A, valida per le moto) su base km, cosi'
// l'utente vede un numero indicativo invece di "Presente, N/D".
export function withTollEstimate(tolls, distanceKm, source) {
  if (source === "Google Routes" && tolls && tolls.available && (tolls.amount === null || tolls.amount === undefined)) {
    const est = estimateAspitollClassA(distanceKm);
    if (est && est > 0) {
      return {...tolls, estimatedAmount: est, estimateNote: "Stima approssimativa (classe A, moto) su base chilometrica: Google non ha fornito l'importo. Puo' sovrastimare dove l'autostrada e' gratuita (es. A2 Salerno-Reggio Calabria)."};
    }
  }
  return tolls;
}

function parseFuelPrice(v, fallback=1.85) {
  const n = Number(String(v ?? "").replace(",", ".").replace(/[^\d.]/g,""));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function api(req,res,url) {
  if (url.pathname === "/api/status") {
    return send(res,200,{ok:true, version:APP_VERSION, googleConfigured:Boolean(GOOGLE_KEY), mode:GOOGLE_KEY?"Google":"Fallback gratuito", gateEnabled:GATE_ON});
  }

  // --- Accessi ---
  if (url.pathname === "/api/session") {
    const s = sessionFromReq(req);
    return send(res,200,{ok:true, gateEnabled:GATE_ON, authed:Boolean(s.valid), label:s.valid?s.label:null});
  }
  if (url.pathname === "/api/login" && req.method === "POST") {
    let raw=""; req.on("data",c=>raw+=c);
    req.on("end",()=>{
      let code=""; try { code = JSON.parse(raw||"{}").code || ""; } catch {}
      const ip = clientIp(req);
      if (!GATE_ON) return send(res,200,{ok:true, label:"(aperto)"});
      const entry = findCode(ACCESS_CODES, code);
      if (!entry) { logAccess({event:"login_fallito", ip}); return fail(res,401,"Codice non valido"); }
      const exp = Date.now() + SESSION_DAYS*86400*1000;
      const token = signSession(entry.label, exp, SESSION_SECRET);
      res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_DAYS*86400}; SameSite=Lax; Secure`);
      logAccess({event:"login_ok", label:entry.label, ip});
      return send(res,200,{ok:true, label:entry.label});
    });
    return;
  }
  if (url.pathname === "/api/logout" && req.method === "POST") {
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure`);
    return send(res,200,{ok:true});
  }
  if (url.pathname === "/api/admin/log") {
    if (!ADMIN_CODE) return fail(res,403,"Registro non disponibile: imposta ADMIN_CODE.");
    if ((url.searchParams.get("key")||"") !== ADMIN_CODE) return fail(res,403,"Chiave admin errata");
    return send(res,200,{ok:true, count:accessLog.length, note:"Log in memoria: si azzera al riavvio del server.", log:[...accessLog].reverse()});
  }

  // --- Protezione endpoint a pagamento ---
  const protectedPaths = ["/api/suggest","/api/fuel","/api/plan"];
  if (protectedPaths.includes(url.pathname)) {
    const s = sessionFromReq(req);
    if (!s.valid) return fail(res,401,"Accesso richiesto: inserisci il codice.");
  }

  if (url.pathname === "/api/feedback" && req.method === "POST") {
    let raw = ""; req.on("data",c=>raw+=c);
    req.on("end", async()=>{
      try {
        const b = JSON.parse(raw || "{}");
        const message = String(b.message || "").trim().slice(0, 4000);
        const contact = String(b.contact || "").trim().slice(0, 200);
        if (!message) return fail(res, 400, "Messaggio vuoto.");
        // Solo archiviazione in memoria (leggibile da /api/admin/feedback). L'INVIO email
        // avviene lato browser via Web3Forms: dal server Render Cloudflare risponde 403.
        feedbackStore.push({ts:new Date().toISOString(), message, contact});
        if (feedbackStore.length > 500) feedbackStore.shift();
        return send(res, 200, {ok:true, stored:true});
      } catch(e) { return fail(res, 500, e.message); }
    });
    return;
  }

  if (url.pathname === "/api/admin/feedback") {
    if (!ADMIN_CODE || url.searchParams.get("key") !== ADMIN_CODE) return fail(res,403,"Non autorizzato");
    return send(res,200,{ok:true, count:feedbackStore.length, to:FEEDBACK_TO, note:"Feedback in memoria: si azzera al riavvio.", feedback:[...feedbackStore].reverse()});
  }

  if (url.pathname === "/api/suggest") {
    const q = url.searchParams.get("q") || "";
    if (q.trim().length < 3) return send(res,200,{ok:true,items:[],source:"none"});
    try {
      const items = GOOGLE_KEY ? await suggestGoogle(q) : await suggestFallback(q);
      return send(res,200,{ok:true,items,source:GOOGLE_KEY?"Google":"Nominatim fallback"});
    } catch(e) {
      try { return send(res,200,{ok:true,items:await suggestFallback(q),source:"Nominatim fallback"}); }
      catch(e2) { return fail(res,500,e.message); }
    }
  }
  if (url.pathname === "/api/fuel") {
    const type = url.searchParams.get("type") || "benzina";
    const fallbackPrices = {benzina:1.85,diesel:1.75,gpl:0.75,metano:1.35};
    try {
      const mimit = await getMimitFuelPrice(type);
      return send(res,200,{ok:true,type,price:mimit.price,source:`MIMIT prezzo_alle_8.csv, mediana self-service su ${mimit.samples} rilevazioni`});
    } catch(e) {
      return send(res,200,{ok:true,type,price:fallbackPrices[type]||1.85,source:"Fallback locale: MIMIT non raggiungibile o CSV non leggibile", warning:e.message});
    }
  }
  if (url.pathname === "/api/plan" && req.method === "POST") {
    let raw = ""; req.on("data",c=>raw+=c);
    req.on("end", async()=>{
      try {
        const b = JSON.parse(raw || "{}");
        const origin = await geocode(b.origin);
        const destination = await geocode(b.destination);
        const waypointTexts = Array.isArray(b.waypoints) ? b.waypoints.filter(x => String(x || "").trim()) : [];
        const waypoints = [];
        for (const w of waypointTexts) waypoints.push(await geocode(w));
        const avoidTolls = Boolean(b.avoidTolls);
        const fuelType = b.fuelType || "benzina";
        // Cache per percorso: route + POI + carburante si raccolgono UNA volta per percorso.
        // I ricalcoli che non cambiano origine/arrivo/tappe/pedaggi/carburante riusano tutto
        // senza alcuna chiamata Google a pagamento.
        const cacheKey = planCacheKey(origin, destination, waypoints, avoidTolls, fuelType);
        let rt, pois, routePois, planFromCache = false;
        const cachedPlan = planCacheGet(cacheKey);
        if (cachedPlan) {
          rt = cachedPlan.route; pois = cachedPlan.pois; routePois = cachedPlan.routePois; planFromCache = true;
        } else {
          rt = await route(origin,destination,waypoints,{avoidTolls});
          const cum0 = cumulativeKm(rt.polyline);
          [pois, routePois] = await Promise.all([
            collectFuelPois(rt.polyline,cum0,rt.distanceKm,fuelType),
            collectRouteAttractions(rt.polyline,cum0,rt.distanceKm)   // POI da Wikipedia (gratis)
          ]);
          planCacheSet(cacheKey, {route:rt, pois, routePois});
        }
        // Andatura come VELOCITA' MEDIA obiettivo: Relax ~100, Normale ~110, Rapida ~120 km/h.
        // Su percorsi non autostradali (lenti) un freno evita stime irrealistiche: non ci si
        // discosta oltre il ±20% dalla durata reale stimata da Google.
        const targetSpeed = b.pace === "rapida" ? 120 : b.pace === "relax" ? 100 : 110;
        const targetHours = rt.distanceKm / targetSpeed;
        const durH = Math.min(rt.durationHours * 1.20, Math.max(rt.durationHours * 0.80, targetHours));
        const tolls = withTollEstimate(buildTollSummary(rt), rt.distanceKm, rt.source);
        if (avoidTolls) { tolls.amount = 0; tolls.estimatedAmount = 0; tolls.estimateNote = undefined; tolls.note = "Percorso impostato per evitare i pedaggi: stima azzerata."; }
        const tollNotice = buildTollNotice({avoidTolls, tolls, source:rt.source});
        const cum = cumulativeKm(rt.polyline);
        const consRaw = String(b.consumptionKmL ?? "").trim();
        const tankRaw = String(b.tankCapacityL ?? "").trim();
        const autRaw  = String(b.autonomyKm ?? "").trim();
        const hasCons = consRaw !== "" && Number(consRaw.replace(",",".")) > 0;
        const hasTank = tankRaw !== "" && Number(tankRaw.replace(",",".")) > 0;
        const consumption = hasCons ? Number(consRaw.replace(",",".")) : null;
        const tankCapacityL = hasTank ? Number(tankRaw.replace(",",".")) : null;
        // Autonomia: solo se l'utente la fornisce (serbatoio+consumo) o la imposta a mano.
        // Altrimenti NON limita le soste: l'intervallo (km od ore) e' l'unico criterio.
        const autonomyKm = (hasTank && hasCons) ? calculateAutonomyKm({tankCapacityL, consumptionKmL: consumption})
                          : (autRaw !== "" && Number(autRaw) > 0 ? Number(autRaw) : null);
        // Intervallo soste: a km oppure a ORE (convertite con la velocita' media effettiva).
        const effAvgSpeed = durH > 0 ? (rt.distanceKm / durH) : 100;
        let stopEveryKmEff = Number(String(b.stopEveryKm).replace(",",".")) || 150;
        if (b.stopEveryUnit === "h") {
          const hours = Number(String(b.stopEveryKm).replace(",",".")) || 2;
          stopEveryKmEff = Math.max(40, Math.round(hours * effAvgSpeed));
        }
        // Soste: cadenza (km od ore) come soste NORMALI; il rifornimento si aggancia alla
        // sosta di cadenza piu' vicina al limite di autonomia, solo se l'autonomia e' nota.
        const stopsRaw = planStops({routeKm:rt.distanceKm, pois, stopEveryKm:stopEveryKmEff, forwardWindowKm:b.forwardWindowKm||25, autonomyKm});
        let prevStopKm = 0;
        const stops = stopsRaw.map(s => {
          const routeKm = Number(s.routeKm || 0);
          const enriched = {...s, displayName: normalizeServiceAreaName(s.name, s.address), brand: String(s.name || "").trim(), fromPreviousKm: Number((routeKm - prevStopKm).toFixed(1))};
          prevStopKm = routeKm;
          return enriched;
        });
        // Rettifica nome: per le soste in autostrada senza nome-area (resta il comune),
        // chiede a Google il vero nome dell'area (es. "Marzi" -> "Rogliano Ovest").
        if (GOOGLE_KEY) {
          for (const s of stops) {
            if (s.status === "CRITICA" || !s.onMotorway) continue;
            if (serviceAreaName(s.name, s.address)) continue; // ha gia' un nome-area
            const better = await lookupServiceAreaName(s.lat, s.lng);
            if (better) s.displayName = better;
          }
        }
        let validStops = stops.filter(s=>s.status!=="CRITICA").length;
        const stopMinutes = 20;
        const dateStr = b.date || new Date().toISOString().slice(0,10);
        const timeStr = b.time || "09:00";
        // Soste lunghe: array (supporta piu' di una). Retrocompatibile col vecchio singolo.
        let longStopsCfg = Array.isArray(b.longStops) ? b.longStops
          : (b.longStop && b.longStop.enabled ? [b.longStop] : []);
        longStopsCfg = longStopsCfg
          .map(c => ({minutes:Math.max(0, Number(c.minutes||0)), type:String(c.type||"relax").trim()||"relax", time:String(c.time||"13:00").slice(0,5), address:String(c.address||"").trim()}))
          .filter(c => c.minutes > 0)
          .sort((a,b)=> a.time.localeCompare(b.time));

        // La sosta lunga SOSTITUISCE la sosta normale (es. 60 al posto di 20), non si somma.
        const effStop = s => (Number(s.longStopMinutes||0) > 0 ? Number(s.longStopMinutes) : stopMinutes);
        const nAssignedLong = Math.min(longStopsCfg.length, validStops);
        const sumAssignedLong = longStopsCfg.slice(0, nAssignedLong).reduce((sum,c)=>sum+c.minutes, 0);
        const totalMin = durH*60 + validStops*stopMinutes + sumAssignedLong - stopMinutes*nAssignedLong;
        let departure, arrival;
        if (b.mode === "arrive") { arrival = parseRomeDateTime(dateStr, timeStr); departure = addMinutes(arrival, -totalMin); }
        else { departure = parseRomeDateTime(dateStr, timeStr); arrival = addMinutes(departure, totalMin); }

        // Orario REALE di arrivo a una sosta: include le soste (normali e lunghe) precedenti.
        function etaForStop(stop) {
          let extra = 0;
          for (const other of stops) {
            if (other === stop) break;
            if (other.status !== "CRITICA") extra += effStop(other);
          }
          const driveMinutesToStop = (Number(stop.routeKm || 0) / rt.distanceKm) * durH * 60;
          return addMinutes(departure, driveMinutesToStop + extra);
        }
        function absMinutesDiff(a,b){ return Math.abs((a.getTime() - b.getTime()) / 60000); }

        if (longStopsCfg.length) {
          const assigned = new Set();
          // PASS 1 — ogni sosta lunga si aggancia alla sosta carburante DISTINTA il cui orario REALE di arrivo e' piu' vicino al richiesto.
          for (const cfg of longStopsCfg) {
            const valid = stops.filter(s => s.status !== "CRITICA" && !assigned.has(s));
            if (!valid.length) break;
            const target = parseRomeDateTime(dateStr, cfg.time || "13:00");
            const tdiff = (eta) => Math.min(absMinutesDiff(eta, target), absMinutesDiff(addMinutes(eta,1440), target), absMinutesDiff(addMinutes(eta,-1440), target));
            let chosen = valid[0], best = Infinity;
            for (const s of valid) { const diff = tdiff(etaForStop(s)); if (diff < best) { best = diff; chosen = s; } }
            assigned.add(chosen);
            chosen.longStopMinutes = cfg.minutes;
            chosen.longStopType = cfg.type;
            chosen.longStopTargetTime = cfg.time;
            chosen._lsAddress = cfg.address;
          }
          // PASS 2 — indirizzo specifico opzionale per ciascuna: lo risolve e, se vicino alla rotta, vi sposta la sosta.
          let moved = false;
          for (const stop of stops) {
            if (!stop._lsAddress) continue;
            const addr = stop._lsAddress; delete stop._lsAddress;
            try {
              const longPlace = await geocode(addr);
              const loc = locateOnRouteKm({lat:longPlace.lat,lng:longPlace.lng}, rt.polyline, cum);
              stop.longStopAddress = longPlace.address;
              stop.longStopAddressInput = addr;
              stop.longStopOffsetMeters = Math.round(loc.distKm * 1000);
              stop.longStopRouteKm = Number(loc.km.toFixed(1));
              if (loc.distKm <= 5) {
                stop.name = `${stop.longStopType.charAt(0).toUpperCase()+stop.longStopType.slice(1)} programmato`;
                stop.displayName = stop.name;
                stop.address = longPlace.address;
                stop.lat = longPlace.lat;
                stop.lng = longPlace.lng;
                stop.routeKm = loc.km;
                stop.offsetMeters = Math.round(loc.distKm * 1000);
                delete stop.longStopWarning;
                moved = true;
              } else {
                stop.longStopWarning = "Indirizzo salvato, ma lontano dalla rotta: verifica manuale.";
              }
            } catch(e) {
              stop.longStopAddress = addr;
              stop.longStopWarning = "Indirizzo sosta lunga non geocodificato: verifica manuale.";
            }
          }
          if (moved) {
            stops.sort((a,b)=>Number(a.routeKm||0)-Number(b.routeKm||0));
            prevStopKm = 0;
            for (const stop of stops) {
              const routeKm = Number(stop.routeKm || 0);
              stop.fromPreviousKm = Number((routeKm - prevStopKm).toFixed(1));
              prevStopKm = routeKm;
            }
          }
        }
        const totalLongStopMinutes = stops.reduce((sum, s) => sum + Number(s.longStopMinutes || 0), 0);
        let accumulatedStopMinutes = 0;
        let prevDriveMin = 0;
        for (const s of stops) {
          if (s.status === "CRITICA") continue;
          const driveMinutesToStop = (Number(s.routeKm || 0) / rt.distanceKm) * durH * 60;
          // Tratta dalla tappa precedente: tempo di guida e velocita' media reale.
          const legDrive = Math.max(0, driveMinutesToStop - prevDriveMin);
          const legKm = Number(s.fromPreviousKm || 0);
          s.legDriveMinutes = Math.round(legDrive);
          s.legAvgSpeed = legDrive > 0 ? Math.round(legKm / (legDrive / 60)) : null;
          prevDriveMin = driveMinutesToStop;
          const etaDate = addMinutes(departure, driveMinutesToStop + accumulatedStopMinutes);
          const eff = effStop(s);
          s.eta = fmtRome(etaDate);
          s.stopMinutes = stopMinutes;
          // La sosta lunga SOSTITUISCE la normale: ripartenza = arrivo + durata effettiva.
          s.departureEta = fmtRome(addMinutes(etaDate, eff));
          // Avviso orario sull'arrivo REALE (include le soste lunghe precedenti); non per le soste con indirizzo esplicito.
          if (Number(s.longStopMinutes||0) > 0 && s.longStopTargetTime && !s.longStopAddress) {
            const target = parseRomeDateTime(dateStr, s.longStopTargetTime);
            const diff = Math.min(absMinutesDiff(etaDate,target), absMinutesDiff(addMinutes(etaDate,1440),target), absMinutesDiff(addMinutes(etaDate,-1440),target));
            if (diff > 90) s.longStopWarning = `Nessuna sosta vicino alle ${s.longStopTargetTime}: la piu' vicina cade alle ${fmtRome(etaDate).split(", ")[1] || fmtRome(etaDate)}. Sosta lunga agganciata comunque a questa sosta.`;
          }
          accumulatedStopMinutes += eff;
        }
        const fuelPrice = parseFuelPrice(b.fuelPrice,1.85);
        const liters = hasCons ? rt.distanceKm / consumption : null;
        const fuelCost = liters != null ? liters * fuelPrice : null;
        const poisForMap = pois.map(p => ({id:p.id, name:p.name, address:p.address, lat:p.lat, lng:p.lng, routeKm:p.routeKm, offsetMeters:p.offsetMeters, source:p.source}));
        return send(res,200,{ok:true, mode:GOOGLE_KEY?"Google":"Fallback gratuito", geocoded:{origin,destination,waypoints}, route:rt, tolls, tollNotice, poisFound:pois.length, pois:poisForMap, routePois,
          times:{departure:fmtRome(departure),arrival:fmtRome(arrival),stopMinutes:Math.max(0,(validStops-nAssignedLong))*stopMinutes,longStopMinutes:totalLongStopMinutes,totalMinutes:Math.round(totalMin),driveMinutes:Math.round(durH*60),pauseMinutes:Math.max(0,Math.round(totalMin-durH*60))},
          fuel:{type:b.fuelType||"benzina",price:fuelPrice,liters,cost:fuelCost,tankCapacityL,consumptionKmL:consumption,autonomyKm}, stops, cached:planFromCache});
      } catch(e) { return fail(res,500,e.message); }
    });
    return;
  }
  return fail(res,404,"API non trovata");
}

const server = http.createServer(async (req,res)=>{
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) return api(req,res,url);
  let file = url.pathname === "/" ? "index.html" : url.pathname.slice(1).replace(/\.\./g,"");
  const full = path.join(publicDir,file);
  try {
    const data = await fs.readFile(full);
    const ext = path.extname(full).toLowerCase();
    const mime = {".css":"text/css", ".js":"application/javascript", ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".svg":"image/svg+xml", ".ico":"image/x-icon", ".html":"text/html"};
    const type = mime[ext] || "application/octet-stream";
    send(res,200,data,type);
  } catch { send(res,404,"Not found","text/plain"); }
});
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  server.listen(PORT,()=>console.log(`Road Captain by Rhegium ${APP_VERSION} on ${PORT}`));
}
