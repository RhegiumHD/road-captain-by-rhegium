
export function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const s = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
export function cumulativeKm(polyline) {
  const out = [0];
  for (let i = 1; i < polyline.length; i++) out.push(out[i-1] + haversineKm(polyline[i-1], polyline[i]));
  return out;
}
export function pointAtKm(polyline, cum, km) {
  if (!polyline.length) return null;
  if (km <= 0) return polyline[0];
  if (km >= cum[cum.length-1]) return polyline[polyline.length-1];
  let i = 1;
  while (i < cum.length && cum[i] < km) i++;
  const prev = polyline[i-1], next = polyline[i];
  const seg = cum[i] - cum[i-1] || 1;
  const t = (km - cum[i-1]) / seg;
  return { lat: prev.lat + (next.lat-prev.lat)*t, lng: prev.lng + (next.lng-prev.lng)*t };
}
function pointSegApproxKm(p, a, b) {
  const x = p.lng, y = p.lat, x1 = a.lng, y1 = a.lat, x2 = b.lng, y2 = b.lat;
  const dx = x2-x1, dy = y2-y1;
  const len2 = dx*dx + dy*dy || 1e-12;
  const t = Math.max(0, Math.min(1, ((x-x1)*dx + (y-y1)*dy) / len2));
  const proj = {lat: y1 + t*dy, lng: x1 + t*dx};
  return {distKm: haversineKm(p, proj), proj};
}
export function locateOnRouteKm(point, polyline, cum) {
  let best = {distKm: Infinity, km: 0};
  for (let i=1; i<polyline.length; i++) {
    const r = pointSegApproxKm(point, polyline[i-1], polyline[i]);
    if (r.distKm < best.distKm) {
      const segLen = haversineKm(polyline[i-1], polyline[i]) || 1;
      const along = haversineKm(polyline[i-1], r.proj);
      best = {distKm: r.distKm, km: cum[i-1] + Math.min(segLen, along)};
    }
  }
  return best;
}
export function calculateAutonomyKm({tankCapacityL=15.5, consumptionKmL=13} = {}) {
  const tank = Number(tankCapacityL);
  const consumption = Number(consumptionKmL);
  if (!Number.isFinite(tank) || tank <= 0) throw new Error("Capienza serbatoio non valida");
  if (!Number.isFinite(consumption) || consumption <= 0) throw new Error("Consumo km/l non valido");
  return tank * consumption;
}

export function planFuelStops({routeKm, pois, stopEveryKm=150, forwardWindowKm=25, maxAutonomyKm=200}) {
  const sorted = [...pois].sort((a,b)=>a.routeKm-b.routeKm);
  const stops = [];
  let lastKm = 0;
  const minGapKm = 35;
  const byOffset = (a,b)=>(Number(a.offsetMeters||0)-Number(b.offsetMeters||0)) || (a.routeKm-b.routeKm);
  while (routeKm - lastKm > maxAutonomyKm) {
    const target = lastKm + Number(stopEveryKm);
    const reach = lastKm + Number(maxAutonomyKm);            // limite fisico: oltre non ci arrivi
    // Tutte le stazioni raggiungibili (oltre il distacco minimo, entro l'autonomia).
    let pool = sorted.filter(p => p.routeKm > lastKm + minGapKm && p.routeKm <= reach);
    // REGOLA DURA: se esiste almeno una vera area sull'asse autostradale raggiungibile,
    // si sceglie SOLO tra quelle. Mai uscire dall'autostrada per il rifornimento.
    const onMw = pool.filter(p => p.onMotorway);
    if (onMw.length) pool = onMw;
    if (!pool.length) {
      stops.push({status:"CRITICA", routeKm: Math.round(target), message:`Nessuna stazione carburante valida sulla rotta entro autonomia. Serve verifica manuale.`});
      break;
    }
    // 1) area nella finestra ideale [target, target+margine] -> spaziatura corretta;
    // 2) altrimenti PROLUNGA alla prossima area dopo la finestra (es. 170 invece di 150);
    // 3) altrimenti la piu' vicina prima del target (anticipata).
    const within = pool.filter(p => p.routeKm >= target && p.routeKm <= target + Number(forwardWindowKm)).sort(byOffset);
    const after  = pool.filter(p => p.routeKm > target + Number(forwardWindowKm)).sort((a,b)=>a.routeKm-b.routeKm);
    const before = pool.filter(p => p.routeKm < target).sort((a,b)=>b.routeKm-a.routeKm);
    let chosen, status;
    if (within.length) { chosen = within[0]; status = "VALIDA"; }
    else if (after.length) { chosen = after[0]; status = "VALIDA"; }   // prolungata per restare in autostrada
    else { chosen = before[0]; status = "ANTICIPATA"; }
    stops.push({...chosen, status});
    lastKm = chosen.routeKm;
    if (stops.length > 20) break;
  }
  return stops;
}
