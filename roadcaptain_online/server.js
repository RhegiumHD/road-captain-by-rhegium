
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cumulativeKm, pointAtKm, locateOnRouteKm, planFuelStops } from "./engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const PORT = process.env.PORT || 10000;
const GOOGLE_KEY = (process.env.GOOGLE_MAPS_API_KEY || "").trim();

function send(res, status, data, type="application/json") {
  res.writeHead(status, {"Content-Type": type, "Access-Control-Allow-Origin":"*"});
  res.end(type === "application/json" ? JSON.stringify(data) : data);
}
function fail(res, status, message, detail=null) { send(res, status, {ok:false, error:message, detail}); }
function needGoogleKey(res) {
  if (!GOOGLE_KEY) {
    fail(res, 500, "Chiave Google non configurata su Render. Aggiungi GOOGLE_MAPS_API_KEY in Environment e fai redeploy.");
    return false;
  }
  return true;
}
async function getJson(url, options={}) {
  const r = await fetch(url, { ...options, headers: { "User-Agent":"RoadCaptainByRhegium/3.1.1", ...(options.headers||{}) }});
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = {raw:text}; }
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${text.slice(0,250)}`);
  return data;
}
function decodePolyline(str) {
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
  if (GOOGLE_KEY) return geocodeGoogle(address);
  return geocodeFallback(address);
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
async function routeGoogle(origin, destination) {
  const body = {
    origin: {location:{latLng:{latitude:origin.lat, longitude:origin.lng}}},
    destination: {location:{latLng:{latitude:destination.lat, longitude:destination.lng}}},
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_AWARE",
    computeAlternativeRoutes: false,
    languageCode: "it-IT",
    units: "METRIC",
    polylineQuality: "HIGH_QUALITY",
    polylineEncoding: "ENCODED_POLYLINE"
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
  return {distanceKm: meters/1000, durationHours: seconds/3600, polyline: decodePolyline(r.polyline.encodedPolyline), tollInfo: r.travelAdvisory?.tollInfo || null, source:"Google Routes"};
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
      if (loc.distKm <= (GOOGLE_KEY ? 0.7 : 0.45)) {
        const key = poi.id || `${poi.name}-${poi.lat.toFixed(4)}-${poi.lng.toFixed(4)}`;
        if (!seen.has(key)) seen.set(key, {...poi, routeKm:loc.km, offsetMeters:Math.round(loc.distKm*1000)});
      }
    }
  }
  return [...seen.values()].sort((a,b)=>a.routeKm-b.routeKm);
}
function parseFuelPrice(v, fallback=1.85) {
  const n = Number(String(v ?? "").replace(",", ".").replace(/[^\d.]/g,""));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function addMinutes(date, min) { return new Date(date.getTime() + min*60000); }
function fmt(d) { return d.toLocaleString("it-IT", {timeZone:"Europe/Rome", day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit"}); }

async function api(req,res,url) {
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
    const prices = {benzina:1.85,diesel:1.75,gpl:0.75,metano:1.35};
    return send(res,200,{ok:true,type,price:prices[type]||1.85,source:"Prezzo suggerito modificabile. MIMIT diretto non integrato in questa build: nessun dato ufficiale simulato."});
  }
  if (url.pathname === "/api/plan" && req.method === "POST") {
    if (!needGoogleKey(res)) return;
    let raw = ""; req.on("data",c=>raw+=c);
    req.on("end", async()=>{
      try {
        const b = JSON.parse(raw || "{}");
        const origin = await geocodeGoogle(b.origin);
        const destination = await geocodeGoogle(b.destination);
        const rt = await routeGoogle(origin,destination);
        const cum = cumulativeKm(rt.polyline);
        const pois = await collectFuelPois(rt.polyline,cum,rt.distanceKm,b.fuelType||"benzina");
        const stops = planFuelStops({routeKm:rt.distanceKm, pois, stopEveryKm:b.stopEveryKm||150, forwardWindowKm:b.forwardWindowKm||25, maxAutonomyKm:b.maxAutonomyKm||200});
        const validStops = stops.filter(s=>s.status!=="CRITICA").length;
        const totalMin = rt.durationHours*60 + validStops*Number(b.stopMinutes||15);
        const dateStr = b.date || new Date().toISOString().slice(0,10);
        const timeStr = b.time || "09:00";
        let departure, arrival;
        if (b.mode === "arrive") { arrival = new Date(`${dateStr}T${timeStr}:00`); departure = addMinutes(arrival, -totalMin); }
        else { departure = new Date(`${dateStr}T${timeStr}:00`); arrival = addMinutes(departure, totalMin); }
        const consumption = Number(b.consumptionKmL || 13);
        const fuelPrice = parseFuelPrice(b.fuelPrice,1.85);
        const liters = rt.distanceKm / consumption;
        return send(res,200,{ok:true, geocoded:{origin,destination}, route:rt, poisFound:pois.length,
          times:{departure:fmt(departure),arrival:fmt(arrival),stopMinutes:validStops*Number(b.stopMinutes||15)},
          fuel:{type:b.fuelType||"benzina",price:fuelPrice,liters,cost:liters*fuelPrice}, stops});
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
    const type = ext===".css"?"text/css":ext===".js"?"application/javascript":"text/html";
    send(res,200,data,type);
  } catch { send(res,404,"Not found","text/plain"); }
});
server.listen(PORT,()=>console.log(`Road Captain by Rhegium 3.1.1 on ${PORT}`));
