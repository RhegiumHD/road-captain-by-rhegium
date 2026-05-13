import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePolyline, routeProgress, pointAtKm, locatePoiOnRoute, selectFuelStops } from './engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
const PUBLIC = path.join(__dirname, 'public');

const json = (res, status, data) => {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store'});
  res.end(JSON.stringify(data));
};

async function fetchJson(url, opts={}) {
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), opts.timeout || 20000);
  try {
    const r = await fetch(url, {...opts, signal: ctrl.signal});
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = {raw:text}; }
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${text.slice(0,250)}`);
    return data;
  } finally { clearTimeout(t); }
}

function assertKey() {
  if (!GOOGLE_KEY) throw new Error('GOOGLE_MAPS_API_KEY non configurata su Render');
}

async function geocode(address) {
  assertKey();
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', address);
  url.searchParams.set('region', 'it');
  url.searchParams.set('language', 'it');
  url.searchParams.set('key', GOOGLE_KEY);
  const data = await fetchJson(url);
  if (data.status !== 'OK' || !data.results?.length) throw new Error(`Geocoding non riuscito per: ${address} (${data.status || 'NO_RESULT'})`);
  const r = data.results[0];
  return { address: r.formatted_address, lat: r.geometry.location.lat, lng: r.geometry.location.lng, placeId: r.place_id };
}

async function route(origin, destination) {
  assertKey();
  const body = {
    origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
    destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_UNAWARE',
    computeAlternativeRoutes: false,
    languageCode: 'it-IT',
    units: 'METRIC',
    polylineEncoding: 'ENCODED_POLYLINE'
  };
  const data = await fetchJson('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      'X-Goog-Api-Key': GOOGLE_KEY,
      'X-Goog-FieldMask':'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.legs'
    },
    body: JSON.stringify(body)
  });
  const r = data.routes?.[0];
  if (!r) throw new Error('Routes API non ha restituito percorsi');
  return { distanceMeters: r.distanceMeters, duration: r.duration, encodedPolyline: r.polyline.encodedPolyline };
}

async function placesNearby(point, radiusMeters=3000) {
  assertKey();
  const url = new URL('https://maps.googleapis.com/maps/api/place/nearbysearch/json');
  url.searchParams.set('location', `${point.lat},${point.lng}`);
  url.searchParams.set('radius', String(radiusMeters));
  url.searchParams.set('type', 'gas_station');
  url.searchParams.set('language', 'it');
  url.searchParams.set('key', GOOGLE_KEY);
  const data = await fetchJson(url, {timeout:15000});
  if (!['OK','ZERO_RESULTS'].includes(data.status)) throw new Error(`Places Nearby error: ${data.status} ${data.error_message || ''}`);
  return (data.results || []).map(p => ({
    id: p.place_id,
    name: p.name || 'Stazione carburante',
    lat: p.geometry.location.lat,
    lng: p.geometry.location.lng,
    rating: p.rating || null,
    vicinity: p.vicinity || '',
    source: 'Google Places'
  }));
}

async function fuelPoisAlongRoute(progress, totalKm, maxOffsetMeters) {
  const sampleKms = [];
  for (let km=20; km<totalKm; km+=25) sampleKms.push(km);
  const byId = new Map();
  for (const km of sampleKms) {
    const point = pointAtKm(progress, km);
    try {
      const results = await placesNearby(point, 3000);
      for (const p of results) {
        const loc = locatePoiOnRoute(progress, p);
        if (loc.offsetMeters <= maxOffsetMeters) {
          byId.set(p.id, {...p, routeKm: loc.km, offsetMeters: Math.round(loc.offsetMeters)});
        }
      }
    } catch (e) {
      // Continue: a single Places failure must not kill whole planning.
    }
  }
  return [...byId.values()].sort((a,b)=>a.routeKm-b.routeKm);
}

function parseDurationSeconds(s) {
  if (!s) return 0;
  return Number(String(s).replace('s','')) || 0;
}

function parseItalianNumber(v, fallback=0) {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
}

async function getMimitAverageFuelPrice(fuel='Benzina') {
  // Fonte ufficiale MIMIT: media prezzi carburanti, dati alle ore 8.
  // Se il CSV cambia o non risponde, il chiamante usera' il valore manuale.
  const wanted = String(fuel).toLowerCase().includes('gasolio') ? 'Gasolio' : 'Benzina';
  const candidates = [
    'https://www.mimit.gov.it/it/prezzo-medio-carburanti/regioni',
    'https://www.mimit.gov.it/it/prezzo-medio-carburanti'
  ];
  let lastError = null;
  for (const url of candidates) {
    try {
      const r = await fetch(url, {headers:{'User-Agent':'RoadCaptainByRhegium/3.1'}});
      const html = await r.text();
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      const re = new RegExp(`${wanted}\\s+SELF\\s+([0-9]+[,.][0-9]+)`, 'i');
      const m = text.match(re);
      if (m) return {fuel:wanted, price: parseItalianNumber(m[1]), source:'MIMIT prezzo medio SELF alle 8'};
    } catch(e) { lastError = e; }
  }
  throw new Error('MIMIT non disponibile: '+(lastError?.message || 'nessun prezzo trovato'));
}

function parseArrivalDate(dateStr, timeStr) {
  const [y,m,d] = dateStr.includes('-') ? dateStr.split('-').map(Number) : dateStr.split('/').reverse().map(Number);
  const [hh,mm] = timeStr.split(':').map(Number);
  return new Date(y, m-1, d, hh||0, mm||0, 0);
}

async function handlePlan(req, res) {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const start = body.start?.trim();
    const end = body.end?.trim();
    if (!start || !end) return json(res, 400, {error:'Inserisci partenza e arrivo'});

    const stopEveryKm = Number(body.stopEveryKm || 150);
    const forwardWindowKm = Number(body.forwardWindowKm || 25);
    const maxAutonomyKm = Number(body.maxAutonomyKm || 200);
    const consumptionKmL = parseItalianNumber(body.consumptionKmL, 13);
    let fuelPrice = parseItalianNumber(body.fuelPrice, 0);
    let fuelSource = body.fuelSource || 'Manuale';
    const fuelType = body.fuelType || 'Benzina';
    if (!fuelPrice) {
      try {
        const fp = await getMimitAverageFuelPrice(fuelType);
        fuelPrice = fp.price;
        fuelSource = fp.source;
      } catch {
        fuelPrice = fuelType === 'Gasolio' ? 1.90 : 1.95;
        fuelSource = 'Fallback manuale per indisponibilita MIMIT';
      }
    }
    const stopMinutes = Number(body.stopMinutes || 15);
    const maxOffsetMeters = Number(body.maxOffsetMeters || 300);

    const origin = await geocode(start);
    const destination = await geocode(end);
    const r = await route(origin, destination);
    const points = decodePolyline(r.encodedPolyline);
    const progress = routeProgress(points);
    const totalKm = Math.round((r.distanceMeters/1000) * 10) / 10;
    const durationSeconds = parseDurationSeconds(r.duration);
    const pois = await fuelPoisAlongRoute(progress, totalKm, maxOffsetMeters);
    const stops = selectFuelStops({progress, pois, stopEveryKm, forwardWindowKm, maxAutonomyKm});
    const validStops = stops.filter(s => s.status !== 'CRITICA').length;
    const stopSeconds = validStops * stopMinutes * 60;

    const mode = body.scheduleMode || 'arrival';
    const arrival = parseArrivalDate(body.date || '2026-05-15', body.time || '20:00');
    let departure, finalArrival;
    if (mode === 'arrival') {
      departure = new Date(arrival.getTime() - (durationSeconds + stopSeconds) * 1000);
      finalArrival = arrival;
    } else {
      departure = arrival;
      finalArrival = new Date(departure.getTime() + (durationSeconds + stopSeconds) * 1000);
    }

    const liters = totalKm / consumptionKmL;
    json(res, 200, {
      engine:'google-v3',
      origin, destination,
      totalKm,
      driveHours: Math.round(durationSeconds/360)/10,
      departure: departure.toLocaleString('it-IT'),
      arrival: finalArrival.toLocaleString('it-IT'),
      liters: Math.round(liters*10)/10,
      fuelCost: Math.round(liters*fuelPrice*100)/100,
      fuel: {fuel: fuelType, price: Math.round(fuelPrice*1000)/1000, source: fuelSource},
      tolls: 'N/D - serve integrazione toll API dedicata',
      poiCount: pois.length,
      maxOffsetMeters,
      stops: stops.map(s => ({
        status:s.status, km: Math.round(s.routeKm*10)/10, name:s.name, offsetMeters:s.offsetMeters, note:s.note, vicinity:s.vicinity, source:s.source
      })),
      routePreview: points.filter((_,i)=>i%Math.ceil(points.length/250)===0).map(p=>[p.lat,p.lng])
    });
  } catch (e) {
    json(res, 500, {error: e.message});
  }
}


async function handleFuelPrice(req, res, url) {
  try {
    const fuel = url.searchParams.get('fuel') || 'Benzina';
    const data = await getMimitAverageFuelPrice(fuel);
    json(res, 200, data);
  } catch(e) {
    json(res, 503, {error:e.message});
  }
}

async function handleSuggest(req, res, url) {
  try {
    const q = url.searchParams.get('q') || '';
    if (q.trim().length < 3) return json(res, 200, []);
    const g = await geocode(q);
    json(res, 200, [g]);
  } catch (e) { json(res, 200, []); }
}

const server = http.createServer(async (req,res)=>{
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'POST' && url.pathname === '/api/plan') return handlePlan(req,res);
  if (req.method === 'GET' && url.pathname === '/api/fuel-price') return handleFuelPrice(req,res,url);
  if (req.method === 'GET' && url.pathname === '/api/suggest') return handleSuggest(req,res,url);
  let file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  file = path.normalize(file).replace(/^\.\.(\/|\\|$)/, '');
  const fp = path.join(PUBLIC, file);
  if (!fp.startsWith(PUBLIC) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404); return res.end('Not found');
  }
  const ext = path.extname(fp).toLowerCase();
  const type = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.css' ? 'text/css' : ext === '.js' ? 'application/javascript' : 'application/octet-stream';
  res.writeHead(200, {'Content-Type':type});
  fs.createReadStream(fp).pipe(res);
});
server.listen(PORT, ()=>console.log(`Road Captain Google V3.1 live on ${PORT}`));
