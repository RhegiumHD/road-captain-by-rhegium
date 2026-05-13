export function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const s = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function decodePolyline(str) {
  let index = 0, lat = 0, lng = 0, coordinates = [];
  while (index < str.length) {
    let b, shift = 0, result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    const dlat = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lat += dlat;
    shift = 0; result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    const dlng = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lng += dlng;
    coordinates.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return coordinates;
}

export function routeProgress(points) {
  const out = [{...points[0], km: 0}];
  let sum = 0;
  for (let i=1; i<points.length; i++) {
    sum += haversineMeters(points[i-1], points[i]) / 1000;
    out.push({...points[i], km: sum});
  }
  return out;
}

export function pointAtKm(progress, km) {
  if (km <= 0) return progress[0];
  const last = progress[progress.length - 1];
  if (km >= last.km) return last;
  for (let i=1; i<progress.length; i++) {
    if (progress[i].km >= km) {
      const prev = progress[i-1];
      const next = progress[i];
      const span = next.km - prev.km || 0.000001;
      const t = (km - prev.km) / span;
      return { lat: prev.lat + (next.lat - prev.lat)*t, lng: prev.lng + (next.lng - prev.lng)*t, km };
    }
  }
  return last;
}

function projectPointToSegmentMeters(p, a, b) {
  const latRef = (a.lat + b.lat + p.lat) / 3 * Math.PI / 180;
  const kx = 111320 * Math.cos(latRef);
  const ky = 110540;
  const ax = a.lng * kx, ay = a.lat * ky;
  const bx = b.lng * kx, by = b.lat * ky;
  const px = p.lng * kx, py = p.lat * ky;
  const vx = bx-ax, vy = by-ay;
  const wx = px-ax, wy = py-ay;
  const c2 = vx*vx + vy*vy || 1;
  const t = Math.max(0, Math.min(1, (wx*vx + wy*vy) / c2));
  const qx = ax + t*vx, qy = ay + t*vy;
  const dx = px-qx, dy = py-qy;
  return { dist: Math.sqrt(dx*dx+dy*dy), t };
}

export function locatePoiOnRoute(progress, poi) {
  let best = { offsetMeters: Infinity, km: 0 };
  for (let i=1; i<progress.length; i++) {
    const proj = projectPointToSegmentMeters(poi, progress[i-1], progress[i]);
    if (proj.dist < best.offsetMeters) {
      const km = progress[i-1].km + (progress[i].km - progress[i-1].km) * proj.t;
      best = { offsetMeters: proj.dist, km };
    }
  }
  return best;
}

export function selectFuelStops({progress, pois, stopEveryKm=150, forwardWindowKm=25, maxAutonomyKm=200}) {
  const totalKm = progress[progress.length - 1].km;
  const ordered = [...pois].filter(p => Number.isFinite(p.routeKm)).sort((a,b)=>a.routeKm-b.routeKm);
  const stops = [];
  let lastKm = 0;
  const used = new Set();

  while (totalKm - lastKm > maxAutonomyKm) {
    const target = lastKm + stopEveryKm;
    const forwardMax = Math.min(lastKm + stopEveryKm + forwardWindowKm, lastKm + maxAutonomyKm, totalKm);
    const forward = ordered.filter(p => !used.has(p.id) && p.routeKm >= target && p.routeKm <= forwardMax);
    let chosen = null;
    let status = 'VALIDA';
    let note = '';
    if (forward.length) {
      chosen = forward[0];
      note = `Trovata nella finestra ${Math.round(target)}-${Math.round(forwardMax)} km`;
    } else {
      const back = ordered.filter(p => !used.has(p.id) && p.routeKm > lastKm + 5 && p.routeKm < target).sort((a,b)=>b.routeKm-a.routeKm);
      if (back.length) {
        chosen = back[0];
        status = 'ANTICIPATA';
        note = `Nessuna tra ${Math.round(target)} e ${Math.round(forwardMax)} km: presa la prima utile a ritroso`;
      } else {
        stops.push({ status:'CRITICA', routeKm: Math.round(target), name:'Nessuna sosta valida', note:`Nessuna stazione carburante sulla rotta tra km ${Math.round(lastKm)} e km ${Math.round(forwardMax)}. Serve verifica manuale.` });
        break;
      }
    }
    if (chosen.routeKm - lastKm > maxAutonomyKm) {
      stops.push({ status:'CRITICA', routeKm: Math.round(chosen.routeKm), name: chosen.name, note:'Sosta oltre autonomia massima. Non valida senza verifica manuale.' });
      break;
    }
    used.add(chosen.id);
    stops.push({ ...chosen, status, note });
    lastKm = chosen.routeKm;
  }
  return optimizeStops(stops, maxAutonomyKm);
}

function optimizeStops(stops, maxAutonomyKm) {
  const clean = [];
  for (const s of stops) {
    if (!clean.length) { clean.push(s); continue; }
    const prev = clean[clean.length-1];
    if (s.status !== 'CRITICA' && prev.status !== 'CRITICA' && s.routeKm - prev.routeKm < 45) {
      clean[clean.length-1] = s.routeKm > prev.routeKm ? s : prev;
    } else clean.push(s);
  }
  return clean;
}
