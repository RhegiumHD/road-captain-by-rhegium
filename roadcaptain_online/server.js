
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cumulativeKm, pointAtKm, locateOnRouteKm, planFuelStops } from "./engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const PORT = process.env.PORT || 10000;
const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || "";

function send(res, status, data, type="application/json") {
  res.writeHead(status, {"Content-Type": type, "Access-Control-Allow-Origin":"*"});
  res.end(type === "application/json" ? JSON.stringify(data) : data);
}
function fail(res, status, message, detail=null) { send(res, status, {ok:false, error:message, detail}); }
function needKey(res) {
  if (!GOOGLE_KEY) {
    fail(res, 500, "GOOGLE_MAPS_API_KEY non configurata su Render. Vai su Render > Environment e aggiungi la variabile.");
    return false;
  }
  return true;
}
async function getJson(url, options={}) {
  const r = await fetch(url, options);
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = {raw:text}; }
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${text.slice(0,200)}`);
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
async function geocode(address) {
  const url = "https://maps.googleapis.com/maps/api/geocode/json?address=" + encodeURIComponent(address) + "&region=it&key=" + GOOGLE_KEY;
  const data = await getJson(url);
  if (data.status !== "OK" || !data.results?.length) throw new Error(`Geocoding fallito: ${data.status}`);
  const r = data.results[0];
  return {address:r.formatted_address, lat:r.geometry.location.lat, lng:r.geometry.location.lng, place_id:r.place_id};
}
async function route(origin, destination) {
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
  return {distanceKm: meters/1000, durationHours: seconds/3600, polyline: decodePolyline(r.polyline.encodedPolyline), tollInfo: r.travelAdvisory?.tollInfo || null};
}
async function nearbyGas(lat, lng, fuelType) {
  const body = {
    includedTypes: ["gas_station"],
    maxResultCount: 12,
    locationRestriction: {circle:{center:{latitude:lat, longitude:lng}, radius: 3500}},
    languageCode: "it"
  };
  const data = await getJson("https://places.googleapis.com/v1/places:searchNearby", {
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "X-Goog-Api-Key": GOOGLE_KEY,
      "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location,places.id,places.types,places.rating"
    },
    body: JSON.stringify(body)
  });
  return (data.places || []).map(p => ({
    id:p.id,
    name:p.displayName?.text || "Stazione carburante",
    address:p.formattedAddress || "",
    lat:p.location?.latitude,
    lng:p.location?.longitude,
    source:"Google Places",
    fuelType
  })).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}
async function collectFuelPois(polyline, cum, routeKm, fuelType) {
  const seen = new Map();
  const samples = [];
  for (let km = 20; km < routeKm; km += 25) samples.push(km);
  for (const km of samples) {
    const p = pointAtKm(polyline, cum, km);
    if (!p) continue;
    try {
      const pois = await nearbyGas(p.lat, p.lng, fuelType);
      for (const poi of pois) {
        const loc = locateOnRouteKm({lat:poi.lat,lng:poi.lng}, polyline, cum);
        // Valida come "sulla rotta" solo se molto vicina alla geometria percorso.
        if (loc.distKm <= 0.45) {
          const key = poi.id || `${poi.name}-${poi.lat.toFixed(4)}-${poi.lng.toFixed(4)}`;
          if (!seen.has(key)) seen.set(key, {...poi, routeKm:loc.km, offsetMeters:Math.round(loc.distKm*1000)});
        }
      }
    } catch {}
  }
  return [...seen.values()].sort((a,b)=>a.routeKm-b.routeKm);
}
async function suggest(q) {
  const url = "https://maps.googleapis.com/maps/api/place/autocomplete/json?input=" + encodeURIComponent(q) + "&language=it&components=country:it&types=geocode|establishment&key=" + GOOGLE_KEY;
  const data = await getJson(url);
  if (data.status !== "OK" && data.status !== "ZERO_RESULTS") throw new Error(`Places autocomplete: ${data.status}`);
  return (data.predictions || []).slice(0,6).map(p => ({description:p.description, place_id:p.place_id}));
}
function parseFuelPrice(v, fallback=1.85) {
  if (typeof v === "number") return v;
  const n = Number(String(v || "").replace(",", ".").replace(/[^\d.]/g,""));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function addMinutes(date, min) { return new Date(date.getTime() + min*60000); }
function fmtIsoLocal(d) {
  return d.toLocaleString("it-IT", {timeZone:"Europe/Rome", day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit"});
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/suggest") {
    if (!needKey(res)) return;
    const q = url.searchParams.get("q") || "";
    if (q.trim().length < 3) return send(res, 200, {ok:true, items:[]});
    try { send(res, 200, {ok:true, items: await suggest(q)}); } catch(e) { fail(res, 500, e.message); }
    return;
  }
  if (url.pathname === "/api/fuel") {
    const fuel = url.searchParams.get("type") || "benzina";
    // Fonte MIMIT non usata automaticamente finché non integriamo dataset ufficiale stabilizzato.
    const defaults = {benzina:1.85, diesel:1.75, gpl:0.75, metano:1.35};
    return send(res, 200, {ok:true, type:fuel, price:defaults[fuel] || 1.85, source:"Valore modificabile manualmente. Integrazione MIMIT server-side prevista; nessun dato ufficiale simulato."});
  }
  if (url.pathname === "/api/plan" && req.method === "POST") {
    if (!needKey(res)) return;
    let raw = ""; req.on("data", c => raw += c);
    req.on("end", async () => {
      try {
        const body = JSON.parse(raw || "{}");
        const fuelType = body.fuelType || "benzina";
        const origin = await geocode(body.origin);
        const destination = await geocode(body.destination);
        const rt = await route(origin, destination);
        const cum = cumulativeKm(rt.polyline);
        const pois = await collectFuelPois(rt.polyline, cum, rt.distanceKm, fuelType);
        const stops = planFuelStops({
          routeKm: rt.distanceKm,
          pois,
          stopEveryKm: Number(body.stopEveryKm || 150),
          forwardWindowKm: Number(body.forwardWindowKm || 25),
          maxAutonomyKm: Number(body.maxAutonomyKm || 200)
        });
        const stopMinutes = stops.filter(s=>s.status!=="CRITICA").length * Number(body.stopMinutes || 15);
        const totalMinutes = rt.durationHours * 60 + stopMinutes;
        const dateStr = body.date || new Date().toISOString().slice(0,10);
        const timeStr = body.time || "09:00";
        let arrival, departure;
        if (body.mode === "arrive") {
          arrival = new Date(`${dateStr}T${timeStr}:00`);
          departure = addMinutes(arrival, -totalMinutes);
        } else {
          departure = new Date(`${dateStr}T${timeStr}:00`);
          arrival = addMinutes(departure, totalMinutes);
        }
        const consumption = Number(body.consumptionKmL || 13);
        const liters = consumption > 0 ? rt.distanceKm / consumption : 0;
        const fuelPrice = parseFuelPrice(body.fuelPrice, 1.85);
        const fuelCost = liters * fuelPrice;
        send(res, 200, {ok:true,
          geocoded:{origin,destination},
          route:{distanceKm:rt.distanceKm, durationHours:rt.durationHours, tollInfo:rt.tollInfo},
          fuel:{type:fuelType, price:fuelPrice, liters, cost:fuelCost},
          times:{departure:fmtIsoLocal(departure), arrival:fmtIsoLocal(arrival), stopMinutes},
          poisFound:pois.length,
          stops
        });
      } catch(e) { fail(res, 500, e.message); }
    });
    return;
  }
  fail(res,404,"API non trovata");
}

const server = http.createServer(async (req,res)=>{
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) return handleApi(req,res,url);
  let file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  file = file.replace(/\.\./g,"");
  const full = path.join(publicDir, file);
  try {
    const data = await fs.readFile(full);
    const ext = path.extname(full).toLowerCase();
    const type = ext === ".css" ? "text/css" : ext === ".js" ? "application/javascript" : "text/html";
    send(res,200,data,type);
  } catch { send(res,404,"Not found","text/plain"); }
});
server.listen(PORT, ()=>console.log(`Road Captain by Rhegium online on :${PORT}`));
