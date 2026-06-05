
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cumulativeKm, pointAtKm, locateOnRouteKm, planFuelStops, calculateAutonomyKm } from "./engine.js";
import { addMinutes, fmtRome, parseRomeDateTime } from "./time-utils.js";
import { extractGoogleTollInfo, estimateAspitollClassA } from "./toll-utils.js";
import { parseAccessCodes, findCode, signSession, verifySession, parseCookies, clientIp } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const PORT = process.env.PORT || 10000;
const GOOGLE_KEY = (process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_KEY || process.env.MAPS_API_KEY || "").trim();
const MIMIT_PRICE_URL = "https://www.mimit.gov.it/images/exportCSV/prezzo_alle_8.csv";
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
    locationRestriction: {circle:{center:{latitude:lat, longitude:lng}, radius: 4500}},
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
async function collectFuelPois(polyline, cum, routeKm, fuelType) {
  const seen = new Map();
  const sampleStep = GOOGLE_KEY ? 20 : 30;
  for (let km = 15; km < routeKm; km += sampleStep) {
    const p = pointAtKm(polyline, cum, km);
    if (!p) continue;
    let pois = [];
    try { pois = GOOGLE_KEY ? await nearbyGasGoogle(p.lat, p.lng, fuelType) : await nearbyGasFallback(p.lat,p.lng,fuelType); } catch {}
    for (const poi of pois) {
      const loc = locateOnRouteKm({lat:poi.lat,lng:poi.lng}, polyline, cum);
      // Solo distributori DAVVERO sul tracciato (quelli a cui passi davanti),
      // non benzinai in paese che richiederebbero di uscire dal percorso.
      if (loc.distKm <= (GOOGLE_KEY ? 0.35 : 0.3)) {
        const key = poi.id || `${poi.name}-${poi.lat.toFixed(4)}-${poi.lng.toFixed(4)}`;
        if (!seen.has(key)) seen.set(key, {...poi, routeKm:loc.km, offsetMeters:Math.round(loc.distKm*1000)});
      }
    }
  }
  return [...seen.values()].sort((a,b)=>a.routeKm-b.routeKm);
}

async function nearbyAttractionsGoogle(lat, lng) {
  const body = {
    includedTypes: ["tourist_attraction", "museum", "park", "art_gallery", "historical_landmark"],
    maxResultCount: 20,
    locationRestriction: {circle:{center:{latitude:lat, longitude:lng}, radius: 12000}},
    languageCode: "it"
  };
  const data = await getJson("https://places.googleapis.com/v1/places:searchNearby", {
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "X-Goog-Api-Key": GOOGLE_KEY,
      "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location,places.id,places.primaryTypeDisplayName,places.primaryType,places.types,places.rating,places.userRatingCount"
    },
    body: JSON.stringify(body)
  });
  return (data.places || []).map(p => ({
    id:p.id, name:p.displayName?.text || "POI", address:p.formattedAddress || "",
    category:p.primaryTypeDisplayName?.text || "Luogo di interesse",
    primaryType:p.primaryType || "", types:Array.isArray(p.types) ? p.types : [],
    rating:Number(p.rating) || 0, userRatingCount:Number(p.userRatingCount) || 0,
    lat:p.location?.latitude, lng:p.location?.longitude, source:"Google Places"
  })).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}
async function nearbyAttractionsFallback(lat,lng) {
  const q = `[out:json][timeout:20];(node(around:9000,${lat},${lng})[tourism~"attraction|museum|viewpoint|gallery|artwork"];node(around:9000,${lat},${lng})[historic];);out center tags 30;`;
  const data = await getJson("https://overpass-api.de/api/interpreter", {method:"POST", body:q, headers:{"Content-Type":"text/plain"}});
  return (data.elements||[]).map(e => ({
    id:String(e.id), name:e.tags?.name || "Luogo di interesse", address:"",
    category:e.tags?.tourism || e.tags?.historic || "POI",
    primaryType:e.tags?.tourism || e.tags?.historic || "", types:[e.tags?.tourism, e.tags?.historic].filter(Boolean),
    tags:e.tags || {}, rating:0, userRatingCount:0,
    lat:e.lat, lng:e.lon, source:"Overpass fallback"
  })).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}
// Rilevanza: con Google usiamo voto medio pesato per numero di recensioni
// (qualita' + popolarita'); in fallback usiamo indizi dai tag OSM (wiki, tipo, nome).
export function attractionScore(item) {
  const rating = Number(item.rating) || 0;
  const votes = Number(item.userRatingCount) || 0;
  if (rating > 0 || votes > 0) return (rating || 3.5) * Math.log10(votes + 10);
  const tags = item.tags || {};
  let s = 1;
  if (tags.wikidata || tags.wikipedia) s += 3;
  if (/attraction|museum|viewpoint|castle|monument|memorial/i.test(item.category || "")) s += 1;
  if (item.name && item.name !== "Luogo di interesse") s += 0.5;
  return s;
}
// Categoria stabile del luogo (chiave): il frontend la traduce in un'icona SVG.
export function attractionIcon(item) {
  const t = `${(item.types || []).join(" ")} ${item.primaryType || ""} ${item.category || ""}`.toLowerCase();
  const has = re => re.test(t);
  if (has(/museum|gallery|museo|galler/)) return "museum";
  if (has(/park|garden|national_park|parco|giardin/)) return "park";
  if (has(/church|temple|mosque|synagogue|worship|chiesa|tempio|santuario|duomo|cattedral/)) return "church";
  if (has(/castle|fort|tower|castello|forte|torre/)) return "castle";
  if (has(/viewpoint|scenic|panoram|belvedere/)) return "viewpoint";
  if (has(/beach|spiagg|cala|lido/)) return "beach";
  if (has(/restaurant|food|ristorante|trattoria/)) return "food";
  if (has(/historic|landmark|monument|memorial|storic/)) return "historic";
  return "poi";
}
// Distribuisce i POI lungo TUTTO l'itinerario: divide la rotta in segmenti
// e prende a giro i migliori di ogni segmento, così non si concentrano all'inizio.
export function distributeAttractions(items, routeKm, maxTotal = 24) {
  if (!items.length) return [];
  const bucketKm = 35;
  const nBuckets = Math.max(1, Math.ceil((routeKm || bucketKm) / bucketKm));
  const buckets = Array.from({length:nBuckets}, () => []);
  for (const it of items) {
    let bi = Math.floor((Number(it.routeKm) || 0) / bucketKm);
    if (bi >= nBuckets) bi = nBuckets - 1;
    if (bi < 0) bi = 0;
    buckets[bi].push(it);
  }
  buckets.forEach(b => b.sort((a, b2) => (b2.score || 0) - (a.score || 0)));
  const picked = [];
  let round = 0, added = true;
  while (added && picked.length < maxTotal) {
    added = false;
    for (const b of buckets) {
      if (b[round]) { picked.push(b[round]); added = true; if (picked.length >= maxTotal) break; }
    }
    round++;
  }
  return picked.sort((a, b) => (a.routeKm || 0) - (b.routeKm || 0));
}
async function collectRouteAttractions(polyline, cum, routeKm) {
  const seen = new Map();
  const sampleStep = GOOGLE_KEY ? 30 : 45;
  for (let km = 15; km < routeKm; km += sampleStep) {
    const p = pointAtKm(polyline, cum, km);
    if (!p) continue;
    let items = [];
    try { items = GOOGLE_KEY ? await nearbyAttractionsGoogle(p.lat, p.lng) : await nearbyAttractionsFallback(p.lat,p.lng); } catch {}
    for (const item of items) {
      const loc = locateOnRouteKm({lat:item.lat,lng:item.lng}, polyline, cum);
      // POI davvero lungo l'itinerario (breve deviazione), non a chilometri di distanza.
      if (loc.distKm <= (GOOGLE_KEY ? 3 : 3)) {
        const key = item.id || `${item.name}-${item.lat.toFixed(4)}-${item.lng.toFixed(4)}`;
        if (!seen.has(key)) seen.set(key, {...item, routeKm:Number(loc.km.toFixed(1)), offsetMeters:Math.round(loc.distKm*1000), score:attractionScore(item), icon:attractionIcon(item)});
      }
    }
  }
  return distributeAttractions([...seen.values()], routeKm, 24);
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
function serviceAreaName(name="", address="") {
  const text = `${name} , ${address}`.replace(/\s+/g, " ");
  const re = /area\s+(?:di\s+)?servizio\s+(.+?)(?=,|\s+(?:a\d{1,2}\b|ss\.?\d|sp\.?\d|via\b|strada\b|km\b|\d{5})|$)/ig;
  const candidates = [];
  let m;
  while ((m = re.exec(text))) { const c = m[1].trim(); if (c) candidates.push(c); }
  if (!candidates.length) return "";
  const best = candidates.find(c => !looksLikeCompany(c)) || candidates[0];
  return titleCaseIt(best);
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
    return send(res,200,{ok:true, googleConfigured:Boolean(GOOGLE_KEY), mode:GOOGLE_KEY?"Google":"Fallback gratuito", gateEnabled:GATE_ON});
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
        const rt = await route(origin,destination,waypoints,{avoidTolls});
        const tolls = withTollEstimate(buildTollSummary(rt), rt.distanceKm, rt.source);
        const tollNotice = buildTollNotice({avoidTolls, tolls, source:rt.source});
        const cum = cumulativeKm(rt.polyline);
        const consumption = Number(String(b.consumptionKmL || 13).replace(",","."));
        const tankCapacityL = Number(String(b.tankCapacityL || 15.5).replace(",","."));
        const autonomyKm = calculateAutonomyKm({tankCapacityL, consumptionKmL: consumption});
        const pois = await collectFuelPois(rt.polyline,cum,rt.distanceKm,b.fuelType||"benzina");
        const routePois = await collectRouteAttractions(rt.polyline,cum,rt.distanceKm);
        const stopsRaw = planFuelStops({routeKm:rt.distanceKm, pois, stopEveryKm:b.stopEveryKm||150, forwardWindowKm:b.forwardWindowKm||25, maxAutonomyKm:autonomyKm});
        let prevStopKm = 0;
        const stops = stopsRaw.map(s => {
          const routeKm = Number(s.routeKm || 0);
          const enriched = {...s, displayName: normalizeServiceAreaName(s.name, s.address), brand: String(s.name || "").trim(), fromPreviousKm: Number((routeKm - prevStopKm).toFixed(1))};
          prevStopKm = routeKm;
          return enriched;
        });
        let validStops = stops.filter(s=>s.status!=="CRITICA").length;
        const stopMinutes = 20;
        const dateStr = b.date || new Date().toISOString().slice(0,10);
        const timeStr = b.time || "09:00";
        const longCfg = b.longStop || {};
        const longStopEnabled = Boolean(longCfg.enabled);
        const longStopMinutes = longStopEnabled ? Math.max(0, Number(longCfg.minutes || 0)) : 0;
        const longStopType = String(longCfg.type || "relax").trim() || "relax";
        const longStopTargetTime = String(longCfg.time || "13:00").slice(0,5);
        const longStopAddressText = String(longCfg.address || "").trim();

        const baseTotalMin = rt.durationHours*60 + validStops*stopMinutes;
        let baseDeparture, baseArrival;
        if (b.mode === "arrive") { baseArrival = parseRomeDateTime(dateStr, timeStr); baseDeparture = addMinutes(baseArrival, -baseTotalMin); }
        else { baseDeparture = parseRomeDateTime(dateStr, timeStr); baseArrival = addMinutes(baseDeparture, baseTotalMin); }

        function etaForStop(stop, dep, includeLong=false) {
          let extra = 0;
          for (const other of stops) {
            if (other === stop) break;
            if (other.status !== "CRITICA") extra += stopMinutes + (includeLong ? Number(other.longStopMinutes || 0) : 0);
          }
          const driveMinutesToStop = (Number(stop.routeKm || 0) / rt.distanceKm) * rt.durationHours * 60;
          return addMinutes(dep, driveMinutesToStop + extra);
        }
        function absMinutesDiff(a,b){ return Math.abs((a.getTime() - b.getTime()) / 60000); }

        if (longStopEnabled && longStopMinutes > 0) {
          const valid = stops.filter(s => s.status !== "CRITICA");
          if (valid.length) {
            const target = parseRomeDateTime(dateStr, longStopTargetTime || "13:00");
            // Fix "Arrivo entro": in modalità arrive l'orario di partenza finale slitta
            // indietro dell'intera durata della sosta lunga, quindi l'arrivo reale alla
            // sosta scelta è anticipato. Scegliamo la sosta confrontando l'orario REALE
            // (gia' compensato), non quello calcolato senza la sosta lunga.
            const selDeparture = b.mode === "arrive" ? addMinutes(baseDeparture, -longStopMinutes) : baseDeparture;
            const tdiff = (eta) => Math.min(absMinutesDiff(eta, target), absMinutesDiff(addMinutes(eta, 1440), target), absMinutesDiff(addMinutes(eta, -1440), target));
            let chosen = valid[0];
            let best = Infinity;
            for (const s of valid) {
              const diff = tdiff(etaForStop(s, selDeparture, false));
              if (diff < best) { best = diff; chosen = s; }
            }
            chosen.longStopMinutes = longStopMinutes;
            chosen.longStopType = longStopType;
            chosen.longStopTargetTime = longStopTargetTime;
            // Avvisa se all'orario richiesto non esiste alcuna sosta carburante vicina
            // (es. orario fuori dalla finestra di viaggio): la sosta piu' vicina resta
            // valida ma l'utente deve sapere che il vincolo non e' rispettabile.
            const chosenEta = etaForStop(chosen, selDeparture, false);
            if (tdiff(chosenEta) > 90) {
              chosen.longStopWarning = `Nessuna sosta carburante vicino alle ${longStopTargetTime}: la piu' vicina cade alle ${fmtRome(chosenEta).split(", ")[1] || fmtRome(chosenEta)}. Sosta lunga agganciata comunque a quella sosta.`;
            }
            if (longStopAddressText) {
              try {
                const longPlace = await geocode(longStopAddressText);
                const loc = locateOnRouteKm({lat:longPlace.lat,lng:longPlace.lng}, rt.polyline, cum);
                chosen.longStopAddress = longPlace.address;
                chosen.longStopAddressInput = longStopAddressText;
                chosen.longStopOffsetMeters = Math.round(loc.distKm * 1000);
                chosen.longStopRouteKm = Number(loc.km.toFixed(1));
                if (loc.distKm <= 5) {
                  chosen.name = `${longStopType.charAt(0).toUpperCase()+longStopType.slice(1)} programmato`;
                  chosen.displayName = chosen.name;
                  chosen.address = longPlace.address;
                  chosen.lat = longPlace.lat;
                  chosen.lng = longPlace.lng;
                  chosen.routeKm = loc.km;
                  chosen.offsetMeters = Math.round(loc.distKm * 1000);
                  delete chosen.longStopWarning; // indirizzo esplicito sulla rotta: l'avviso orario non serve
                  stops.sort((a,b)=>Number(a.routeKm||0)-Number(b.routeKm||0));
                  prevStopKm = 0;
                  for (const stop of stops) {
                    const routeKm = Number(stop.routeKm || 0);
                    stop.fromPreviousKm = Number((routeKm - prevStopKm).toFixed(1));
                    prevStopKm = routeKm;
                  }
                } else {
                  chosen.longStopWarning = "Indirizzo salvato, ma lontano dalla rotta: verifica manuale.";
                }
              } catch(e) {
                chosen.longStopAddress = longStopAddressText;
                chosen.longStopWarning = "Indirizzo sosta lunga non geocodificato: verifica manuale.";
              }
            }
          }
        }
        validStops = stops.filter(s=>s.status!=="CRITICA").length;
        const totalLongStopMinutes = stops.reduce((sum, s) => sum + Number(s.longStopMinutes || 0), 0);
        const totalMin = rt.durationHours*60 + validStops*stopMinutes + totalLongStopMinutes;
        let departure, arrival;
        if (b.mode === "arrive") { arrival = parseRomeDateTime(dateStr, timeStr); departure = addMinutes(arrival, -totalMin); }
        else { departure = parseRomeDateTime(dateStr, timeStr); arrival = addMinutes(departure, totalMin); }
        let accumulatedStopMinutes = 0;
        for (const s of stops) {
          if (s.status === "CRITICA") continue;
          const driveMinutesToStop = (Number(s.routeKm || 0) / rt.distanceKm) * rt.durationHours * 60;
          const etaDate = addMinutes(departure, driveMinutesToStop + accumulatedStopMinutes);
          s.eta = fmtRome(etaDate);
          s.stopMinutes = stopMinutes;
          s.departureEta = fmtRome(addMinutes(etaDate, stopMinutes + Number(s.longStopMinutes || 0)));
          accumulatedStopMinutes += stopMinutes + Number(s.longStopMinutes || 0);
        }
        const fuelPrice = parseFuelPrice(b.fuelPrice,1.85);
        const liters = rt.distanceKm / consumption;
        const poisForMap = pois.map(p => ({id:p.id, name:p.name, address:p.address, lat:p.lat, lng:p.lng, routeKm:p.routeKm, offsetMeters:p.offsetMeters, source:p.source}));
        return send(res,200,{ok:true, mode:GOOGLE_KEY?"Google":"Fallback gratuito", geocoded:{origin,destination,waypoints}, route:rt, tolls, tollNotice, poisFound:pois.length, pois:poisForMap, routePois,
          times:{departure:fmtRome(departure),arrival:fmtRome(arrival),stopMinutes:validStops*stopMinutes,longStopMinutes:totalLongStopMinutes},
          fuel:{type:b.fuelType||"benzina",price:fuelPrice,liters,cost:liters*fuelPrice,tankCapacityL,consumptionKmL:consumption,autonomyKm}, stops});
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
  server.listen(PORT,()=>console.log(`Road Captain by Rhegium 5.2.0 on ${PORT}`));
}
