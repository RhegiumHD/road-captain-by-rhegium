
export function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function cumulativeKm(polyline) {
  const out = [0];
  for (let i = 1; i < polyline.length; i += 1) {
    out.push(out[i - 1] + haversineKm(polyline[i - 1], polyline[i]));
  }
  return out;
}

export function pointAtKm(polyline, cumulative, km) {
  if (!polyline.length) return null;
  if (km <= 0) return polyline[0];
  if (km >= cumulative[cumulative.length - 1]) return polyline[polyline.length - 1];

  let i = 1;
  while (i < cumulative.length && cumulative[i] < km) i += 1;

  const prev = polyline[i - 1];
  const next = polyline[i];
  const segKm = cumulative[i] - cumulative[i - 1] || 1;
  const t = (km - cumulative[i - 1]) / segKm;
  return {
    lat: prev.lat + (next.lat - prev.lat) * t,
    lng: prev.lng + (next.lng - prev.lng) * t
  };
}

function pointSegmentDistanceKm(p, a, b) {
  const x = p.lng, y = p.lat, x1 = a.lng, y1 = a.lat, x2 = b.lng, y2 = b.lat;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy || 1e-12;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2));
  const proj = { lat: y1 + t * dy, lng: x1 + t * dx };
  return { distKm: haversineKm(p, proj), projected: proj };
}

export function locateOnRouteKm(point, polyline, cumulative) {
  let best = { distKm: Infinity, routeKm: 0 };
  for (let i = 1; i < polyline.length; i += 1) {
    const r = pointSegmentDistanceKm(point, polyline[i - 1], polyline[i]);
    if (r.distKm < best.distKm) {
      const segLen = haversineKm(polyline[i - 1], polyline[i]) || 1;
      const along = Math.min(segLen, haversineKm(polyline[i - 1], r.projected));
      best = { distKm: r.distKm, routeKm: cumulative[i - 1] + along };
    }
  }
  return best;
}

export function planFuelStops({
  routeKm,
  serviceAreas,
  targetStopKm = 150,
  forwardWindowKm = 25,
  maxAutonomyKm = 200
}) {
  const sorted = [...serviceAreas]
    .filter(p => Number.isFinite(p.routeKm))
    .sort((a, b) => a.routeKm - b.routeKm);

  const stops = [];
  let lastKm = 0;
  const minGapKm = 30;

  while (routeKm - lastKm > maxAutonomyKm) {
    const target = lastKm + Number(targetStopKm);
    const forwardLimit = target + Number(forwardWindowKm);

    let candidates = sorted.filter(p => p.routeKm > target && p.routeKm <= forwardLimit);
    let status = "VALIDA";

    if (candidates.length) {
      candidates.sort((a, b) => a.routeKm - b.routeKm);
    } else {
      candidates = sorted
        .filter(p => p.routeKm > lastKm + minGapKm && p.routeKm <= target)
        .sort((a, b) => b.routeKm - a.routeKm);
      status = "ANTICIPATA";
    }

    if (!candidates.length) {
      stops.push({
        status: "CRITICA",
        type: "criticita",
        routeKm: Math.round(target),
        name: "Nessuna area di servizio valida",
        durationMinutes: 0,
        message: `Nessuna area di servizio valida sulla rotta tra km ${Math.round(lastKm)} e km ${Math.round(Math.min(lastKm + maxAutonomyKm, routeKm))}.`
      });
      break;
    }

    const chosen = {
      ...candidates[0],
      status,
      type: "carburante",
      durationMinutes: 20
    };
    stops.push(chosen);
    lastKm = chosen.routeKm;

    if (stops.length > 30) break;
  }

  return stops;
}

function minutesOfDayFromIso(isoLocalTime) {
  const [h, m] = String(isoLocalTime || "00:00").split(":").map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

export function applyLongStop(stops, longStop) {
  if (!longStop || !longStop.enabled || !longStop.type || !stops.length) return stops;

  const desired = minutesOfDayFromIso(longStop.time);
  const candidates = stops.filter(s => s.status !== "CRITICA" && Number.isFinite(s.etaMinuteOfDay));
  if (!candidates.length) return stops;

  let best = candidates[0];
  let bestDiff = Math.abs(candidates[0].etaMinuteOfDay - desired);
  for (const stop of candidates) {
    const diff = Math.abs(stop.etaMinuteOfDay - desired);
    if (diff < bestDiff) {
      best = stop;
      bestDiff = diff;
    }
  }

  return stops.map(s => {
    if (s !== best) return s;
    return {
      ...s,
      type: longStop.type,
      longStop: true,
      durationMinutes: Number(longStop.durationMinutes || 60),
      desiredLongStopTime: longStop.time
    };
  });
}

export function addStopEtas(stops, routeDurationMinutes, routeKm, baseDate, mode = "depart", requestedTime = "09:00") {
  const validStops = stops.filter(s => s.status !== "CRITICA");
  const totalStopMinutes = validStops.reduce((sum, s) => sum + Number(s.durationMinutes || 20), 0);
  const totalMinutes = Number(routeDurationMinutes || 0) + totalStopMinutes;

  const requested = new Date(`${baseDate}T${requestedTime}:00`);
  const isArrivalMode = String(mode || "").toLowerCase() === "arrive";

  const departure = isArrivalMode
    ? new Date(requested.getTime() - totalMinutes * 60000)
    : requested;

  const arrival = isArrivalMode
    ? requested
    : new Date(departure.getTime() + totalMinutes * 60000);

  let stopMinutesBefore = 0;
  const withEta = stops.map(s => {
    if (s.status === "CRITICA") return s;
    const driveShare = routeKm > 0 ? (s.routeKm / routeKm) : 0;
    const eta = new Date(departure.getTime() + (Number(routeDurationMinutes || 0) * driveShare + stopMinutesBefore) * 60000);
    const out = {
      ...s,
      etaIso: eta.toISOString(),
      etaMinuteOfDay: eta.getHours() * 60 + eta.getMinutes()
    };
    stopMinutesBefore += Number(s.durationMinutes || 20);
    return out;
  });

  return { stops: withEta, departure, arrival, totalMinutes };
}

export function formatCurrency(value, currency = "EUR") {
  if (!Number.isFinite(value)) return "Non disponibile";
  return new Intl.NumberFormat("it-IT", { style: "currency", currency }).format(value);
}
