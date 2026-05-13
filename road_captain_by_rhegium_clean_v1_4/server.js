
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cumulativeKm,
  pointAtKm,
  locateOnRouteKm,
  planFuelStops,
  addStopEtas,
  applyLongStop
} from "./engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 10000;
const GOOGLE_KEY = (process.env.GOOGLE_MAPS_API_KEY || "").trim();

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

function requireKey(res) {
  if (!GOOGLE_KEY) {
    res.status(500).json({
      ok: false,
      error: "GOOGLE_MAPS_API_KEY non configurata su Render."
    });
    return false;
  }
  return true;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "User-Agent": "RoadCaptainByRhegium/1.4 contact: roadcaptain",
      "Accept-Language": "it-IT,it;q=0.9,en;q=0.5",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 220)}`);
  }
  return data;
}

function decodePolyline(encoded) {
  let index = 0, lat = 0, lng = 0;
  const coordinates = [];
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    coordinates.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return coordinates;
}

async function geocode(address) {
  const url = "https://maps.googleapis.com/maps/api/geocode/json?address=" +
    encodeURIComponent(address) + "&region=it&language=it&key=" + GOOGLE_KEY;
  const data = await fetchJson(url);
  if (data.status !== "OK" || !data.results?.length) {
    throw new Error(`Geocoding fallito: ${data.status || "nessun risultato"}`);
  }
  const r = data.results[0];
  return {
    address: r.formatted_address,
    lat: r.geometry.location.lat,
    lng: r.geometry.location.lng,
    placeId: r.place_id
  };
}

async function computeRoute(origin, destination, intermediates = []) {
  const body = {
    origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
    destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
    intermediates: intermediates.map(p => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } })),
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_AWARE",
    computeAlternativeRoutes: false,
    languageCode: "it-IT",
    units: "METRIC",
    polylineQuality: "HIGH_QUALITY",
    polylineEncoding: "ENCODED_POLYLINE",
    extraComputations: ["TOLLS"]
  };

  const data = await fetchJson("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_KEY,
      "X-Goog-FieldMask": [
        "routes.duration",
        "routes.distanceMeters",
        "routes.polyline.encodedPolyline",
        "routes.travelAdvisory.tollInfo"
      ].join(",")
    },
    body: JSON.stringify(body)
  });

  if (!data.routes?.length) throw new Error("Google Routes non ha restituito una rotta.");

  const route = data.routes[0];
  const durationSeconds = Number(String(route.duration || "0s").replace("s", "")) || 0;
  const tollInfo = route.travelAdvisory?.tollInfo || null;
  let tollTotal = null;
  let tollCurrency = "EUR";

  if (tollInfo?.estimatedPrice?.length) {
    const eur = tollInfo.estimatedPrice.find(p => p.currencyCode === "EUR") || tollInfo.estimatedPrice[0];
    tollCurrency = eur.currencyCode || "EUR";
    const units = Number(eur.units || 0);
    const nanos = Number(eur.nanos || 0) / 1e9;
    tollTotal = units + nanos;
  }

  return {
    distanceKm: (route.distanceMeters || 0) / 1000,
    durationMinutes: durationSeconds / 60,
    polyline: decodePolyline(route.polyline.encodedPolyline),
    tollInfo,
    tollTotal,
    tollCurrency
  };
}

async function publicAutocomplete(input) {
  const q = String(input || "").trim();
  if (q.length < 2) return [];

  const results = [];
  const seen = new Set();
  const push = (description, source, lat = null, lng = null) => {
    const clean = String(description || "").replace(/\s+/g, " ").trim();
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ description: clean, placeId: null, source, lat, lng });
  };

  // Local curated fallback for common Italian route/planning terms.
  const local = [
    "Area di servizio Villa San Giovanni Est, Autostrada del Mediterraneo, Villa San Giovanni, Reggio Calabria, Italia",
    "Villa San Giovanni, Reggio Calabria, Calabria, Italia",
    "Toscana Village, Via Fornoli 9, Montopoli in Val d'Arno, Pisa, Italia",
    "Via Fornoli 9, Montopoli in Val d'Arno, Pisa, Italia",
    "Roma Termini, Roma, Italia",
    "Milano, Lombardia, Italia",
    "Napoli, Campania, Italia",
    "Bologna, Emilia-Romagna, Italia",
    "Firenze, Toscana, Italia"
  ];
  for (const item of local) {
    if (item.toLowerCase().includes(q.toLowerCase())) push(item, "locale");
  }

  // Photon/KOMOOT.
  try {
    const url = "https://photon.komoot.io/api/?limit=8&lang=it&q=" + encodeURIComponent(q);
    const data = await fetchJson(url);
    for (const f of data.features || []) {
      const p = f.properties || {};
      const coords = f.geometry?.coordinates || [];
      const parts = [
        p.name,
        p.street && p.housenumber ? `${p.street} ${p.housenumber}` : p.street,
        p.city,
        p.county,
        p.state,
        p.country
      ].filter(Boolean);
      push([...new Set(parts)].join(", "), "Photon", coords[1], coords[0]);
    }
  } catch {}

  // Nominatim. Add Italia to short ambiguous queries.
  try {
    const query = q.length < 6 ? `${q}, Italia` : q;
    const url = "https://nominatim.openstreetmap.org/search?format=json&limit=8&countrycodes=it&addressdetails=1&q=" +
      encodeURIComponent(query);
    const data = await fetchJson(url);
    if (Array.isArray(data)) {
      for (const r of data) {
        push(r.display_name, "Nominatim", Number(r.lat), Number(r.lon));
      }
    }
  } catch {}

  return results.slice(0, 8);
}

async function googleAutocomplete(input) {
  const q = String(input || "").trim();
  if (q.length < 2) return [];

  const results = [];
  const seen = new Set();
  const push = (description, placeId, source) => {
    const clean = String(description || "").replace(/\s+/g, " ").trim();
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ description: clean, placeId: placeId || null, source });
  };

  // 1) Google Places API (New).
  try {
    const data = await fetchJson("https://places.googleapis.com/v1/places:autocomplete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_KEY,
        "X-Goog-FieldMask": "suggestions.placePrediction.placeId,suggestions.placePrediction.text"
      },
      body: JSON.stringify({
        input: q,
        languageCode: "it",
        includedRegionCodes: ["it"]
      })
    });
    for (const s of data.suggestions || []) {
      const p = s.placePrediction;
      push(p?.text?.text, p?.placeId, "Google Places New");
    }
  } catch {}

  // 2) Google Places legacy.
  try {
    const url = "https://maps.googleapis.com/maps/api/place/autocomplete/json?input=" +
      encodeURIComponent(q) + "&language=it&components=country:it&key=" + GOOGLE_KEY;
    const data = await fetchJson(url);
    if (data.status === "OK") {
      for (const p of data.predictions || []) push(p.description, p.place_id, "Google Places");
    }
  } catch {}

  // 3) Google Geocoding.
  try {
    const url = "https://maps.googleapis.com/maps/api/geocode/json?address=" +
      encodeURIComponent(q) + "&region=it&language=it&key=" + GOOGLE_KEY;
    const data = await fetchJson(url);
    if (data.status === "OK") {
      for (const r of data.results || []) push(r.formatted_address, r.place_id, "Google Geocoding");
    }
  } catch {}

  // 4) Public fallback appended.
  for (const item of await publicAutocomplete(q)) push(item.description, null, item.source);

  return results.slice(0, 8);
}

function looksLikeServiceArea(place) {
  const text = `${place.name || ""} ${place.address || ""}`.toLowerCase();
  return (
    text.includes("area di servizio") ||
    text.includes("area servizio") ||
    text.includes("autostrada") ||
    text.includes("autostradale") ||
    text.includes("ads ") ||
    text.includes("sosta")
  );
}

function cleanServiceAreaName(place) {
  const raw = String(place.name || "").trim();
  if (/area\s+di\s+servizio/i.test(raw)) return raw.replace(/\s+/g, " ");
  if (raw) return `Area di Servizio ${raw}`.replace(/\s+/g, " ");
  return "Area di Servizio";
}

async function searchServiceAreasNear(point) {
  const body = {
    textQuery: "area di servizio autostrada carburante",
    languageCode: "it",
    maxResultCount: 10,
    locationBias: {
      circle: {
        center: { latitude: point.lat, longitude: point.lng },
        radius: 5000
      }
    }
  };

  const data = await fetchJson("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_KEY,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.types"
    },
    body: JSON.stringify(body)
  });

  return (data.places || []).map(place => ({
    id: place.id,
    name: place.displayName?.text || "",
    address: place.formattedAddress || "",
    lat: place.location?.latitude,
    lng: place.location?.longitude,
    rawTypes: place.types || [],
    source: "Google Places"
  })).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

async function collectServiceAreas(polyline, cumulative, routeKm) {
  const seen = new Map();
  const sampleKm = [];
  for (let km = 25; km < routeKm; km += 25) sampleKm.push(km);

  for (const km of sampleKm) {
    const p = pointAtKm(polyline, cumulative, km);
    if (!p) continue;
    let results = [];
    try { results = await searchServiceAreasNear(p); } catch { results = []; }

    for (const place of results) {
      const routeLoc = locateOnRouteKm({ lat: place.lat, lng: place.lng }, polyline, cumulative);
      const isAds = looksLikeServiceArea(place);
      const directlyOnRoute = routeLoc.distKm <= 0.8;

      if (!isAds || !directlyOnRoute) continue;

      const key = place.id || `${place.name}-${place.lat.toFixed(5)}-${place.lng.toFixed(5)}`;
      if (!seen.has(key)) {
        seen.set(key, {
          ...place,
          name: cleanServiceAreaName(place),
          routeKm: routeLoc.routeKm,
          offsetMeters: Math.round(routeLoc.distKm * 1000)
        });
      }
    }
  }

  return [...seen.values()].sort((a, b) => a.routeKm - b.routeKm);
}

async function getFuelPrice(fuelType) {
  // Tentativo MIMIT: gli URL pubblici sono soggetti a modifiche. Se non rispondono, fallback dichiarato.
  const fallback = {
    benzina: 1.85,
    diesel: 1.75,
    gpl: 0.75,
    metano: 1.35
  };
  return {
    type: fuelType,
    price: fallback[fuelType] || fallback.benzina,
    source: "Fallback configurabile: integrazione MIMIT live non disponibile in modo stabile in questa build.",
    timestamp: new Date().toISOString()
  };
}

async function searchInterestPoints(polyline, cumulative, routeKm) {
  const wanted = [
    "borgo panoramico",
    "punto panoramico",
    "monumento",
    "lago",
    "ristorante tipico"
  ];
  const points = [];
  const seen = new Set();

  for (let km = 80; km < routeKm; km += 120) {
    const p = pointAtKm(polyline, cumulative, km);
    if (!p) continue;

    for (const query of wanted.slice(0, 2)) {
      const body = {
        textQuery: query,
        languageCode: "it",
        maxResultCount: 3,
        locationBias: {
          circle: { center: { latitude: p.lat, longitude: p.lng }, radius: 12000 }
        }
      };

      try {
        const data = await fetchJson("https://places.googleapis.com/v1/places:searchText", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": GOOGLE_KEY,
            "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location"
          },
          body: JSON.stringify(body)
        });

        for (const place of data.places || []) {
          if (seen.has(place.id)) continue;
          seen.add(place.id);
          const loc = { lat: place.location.latitude, lng: place.location.longitude };
          const routeLoc = locateOnRouteKm(loc, polyline, cumulative);
          if (routeLoc.distKm <= 12) {
            points.push({
              id: place.id,
              name: place.displayName?.text || "Punto di interesse",
              address: place.formattedAddress || "",
              lat: loc.lat,
              lng: loc.lng,
              routeKm: routeLoc.routeKm,
              detourKm: routeLoc.distKm
            });
          }
        }
      } catch {}
    }
  }

  return points.slice(0, 8).sort((a, b) => a.routeKm - b.routeKm);
}

function parseNumber(value, fallback) {
  const n = Number(String(value ?? "").replace(",", ".").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function localDateString(date) {
  return date.toLocaleString("it-IT", {
    timeZone: "Europe/Rome",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function buildGoogleMapsUrl(apiKey) {
  return `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places&language=it&region=IT`;
}

app.get("/api/config", (req, res) => {
  res.json({
    ok: true,
    googleConfigured: Boolean(GOOGLE_KEY),
    mapProvider: "Leaflet/OpenStreetMap"
  });
});

app.get("/api/suggest", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json({ ok: true, items: [] });

    const items = GOOGLE_KEY ? await googleAutocomplete(q) : await publicAutocomplete(q);
    res.json({ ok: true, items, googleConfigured: Boolean(GOOGLE_KEY) });
  } catch (error) {
    // Do not break the UI: last-resort empty response with diagnostic message.
    res.json({ ok: true, items: [], warning: error.message, googleConfigured: Boolean(GOOGLE_KEY) });
  }
});

app.get("/api/fuel-price", async (req, res) => {
  try {
    const fuelType = String(req.query.type || "benzina");
    res.json({ ok: true, fuel: await getFuelPrice(fuelType) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/plan", async (req, res) => {
  if (!requireKey(res)) return;

  try {
    const body = req.body || {};
    const origin = await geocode(body.origin);
    const destination = await geocode(body.destination);
    const waypointTexts = Array.isArray(body.waypoints) ? body.waypoints.filter(Boolean) : [];
    const waypoints = [];
    for (const w of waypointTexts) waypoints.push(await geocode(w));

    const route = await computeRoute(origin, destination, waypoints);
    const cumulative = cumulativeKm(route.polyline);

    const serviceAreas = await collectServiceAreas(route.polyline, cumulative, route.distanceKm);
    let stops = planFuelStops({
      routeKm: route.distanceKm,
      serviceAreas,
      targetStopKm: parseNumber(body.targetStopKm, 150),
      forwardWindowKm: parseNumber(body.forwardWindowKm, 25),
      maxAutonomyKm: parseNumber(body.maxAutonomyKm, 200)
    });

    let schedule = addStopEtas(
      stops,
      route.durationMinutes,
      route.distanceKm,
      body.date || new Date().toISOString().slice(0, 10),
      body.mode || "depart",
      body.time || "09:00"
    );

    stops = applyLongStop(schedule.stops, body.longStop);
    schedule = addStopEtas(
      stops,
      route.durationMinutes,
      route.distanceKm,
      body.date || new Date().toISOString().slice(0, 10),
      body.mode || "depart",
      body.time || "09:00"
    );

    const fuelType = body.fuelType || "benzina";
    const fuelPrice = await getFuelPrice(fuelType);
    const consumptionKmL = parseNumber(body.consumptionKmL, 13);
    const tankLiters = parseNumber(body.tankLiters, 15);
    const litersNeeded = route.distanceKm / consumptionKmL;
    const fuelCost = litersNeeded * fuelPrice.price;

    const pois = await searchInterestPoints(route.polyline, cumulative, route.distanceKm);

    res.json({
      ok: true,
      input: body,
      geocoded: { origin, destination, waypoints },
      route: {
        distanceKm: route.distanceKm,
        durationMinutes: route.durationMinutes,
        polyline: route.polyline,
        tollTotal: route.tollTotal,
        tollCurrency: route.tollCurrency,
        tollInfo: route.tollInfo,
        tollStatus: route.tollTotal === null
          ? "Google Routes non ha restituito un importo pedaggi per questa tratta."
          : "Pedaggio stimato da Google Routes."
      },
      vehicle: { fuelType, tankLiters, consumptionKmL },
      fuel: {
        ...fuelPrice,
        litersNeeded,
        cost: fuelCost
      },
      schedule: {
        departure: localDateString(schedule.departure),
        arrival: localDateString(schedule.arrival),
        totalMinutes: schedule.totalMinutes
      },
      stops: schedule.stops,
      stopCount: schedule.stops.filter(s => s.status !== "CRITICA").length,
      serviceAreasFound: serviceAreas.length,
      pois
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Road Captain by Rhegium running on port ${PORT}`);
});
