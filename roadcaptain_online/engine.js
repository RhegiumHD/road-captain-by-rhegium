
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

// Sceglie l'area reale piu' adatta vicino a un km obiettivo. REGOLE DURE: mai fuori
// autostrada se esiste un'area autostradale; SOLO lato destro (carreggiata corretta) se
// esiste un'area a destra. Finestra [target, target+margine] -> a ritroso -> avanti.
function pickAreaNear(sorted, {fromKm, target, forwardWindowKm, minGapKm, capKm=Infinity}) {
  const byOffset = (a,b)=>(Number(a.offsetMeters||0)-Number(b.offsetMeters||0)) || (a.routeKm-b.routeKm);
  let pool = sorted.filter(p => p.routeKm > fromKm + minGapKm && p.routeKm <= capKm);
  const onMw = pool.filter(p => p.onMotorway);
  if (onMw.length) pool = onMw;                 // DURO: solo aree autostradali se ce ne sono
  const right = pool.filter(p => p.side === "right");
  if (right.length) pool = right;               // DURO: solo lato destro (carreggiata corretta)
  if (!pool.length) return null;
  const within = pool.filter(p => p.routeKm >= target && p.routeKm <= target + Number(forwardWindowKm)).sort(byOffset);
  const before = pool.filter(p => p.routeKm < target).sort((a,b)=> b.routeKm - a.routeKm);   // piu' vicino sotto il target
  const after  = pool.filter(p => p.routeKm > target + Number(forwardWindowKm)).sort((a,b)=> a.routeKm - b.routeKm);
  if (within.length) return {area:within[0], status:"VALIDA"};       // entro [target, target+margine]
  if (before.length) return {area:before[0], status:"ANTICIPATA"};   // a ritroso: anticipa la sosta
  if (after.length)  return {area:after[0],  status:"VALIDA"};        // avanti: prossima area a destra (mai la gemella sinistra)
  return null;
}

// Pianifica le soste:
//  1) CADENZA: una sosta ogni ~`stopEveryKm` (km od ore->km), SEQUENZIALE dalla sosta
//     precedente reale, ancorata a un'area di servizio reale. La cadenza comanda.
//  2) TIPO: ogni sosta e' un RIFORNIMENTO, salvo quando l'autonomia e' >= 3x la tratta
//     (allora sosta tecnica). Vincolo di sicurezza: mai superare l'autonomia tra due pieni.
// Ogni sosta porta `kind`: "normal" (sosta tecnica, no carburante) o "fuel" (rifornimento).
export function planStops({routeKm, pois, stopEveryKm=150, forwardWindowKm=25, autonomyKm=null}) {
  const sorted = [...pois].sort((a,b)=>a.routeKm-b.routeKm);
  const minGapKm = 35;
  const every = Math.max(1, Number(stopEveryKm) || 150);
  const fwd = Number(forwardWindowKm) > 0 ? Number(forwardWindowKm) : 30;   // margine cercato OLTRE il target (impostato dall'utente)
  const aut = (autonomyKm && Number(autonomyKm) > 0) ? Number(autonomyKm) : null;

  // --- Fase 1: soste a cadenza (normali), SEQUENZIALI ---
  // Ogni sosta punta a ~every km DALLA SOSTA PRECEDENTE REALE. Si cerca un'area entro
  // [target, target+margine] (VALIDA, il margine = forwardWindowKm impostato dall'utente);
  // se in quel margine non c'e' nulla, si va A RITROSO all'area piu' vicina prima del target
  // (sosta ANTICIPATA) cosi' non si sfora mai oltre l'intervallo.
  const stops = [];
  let lastChosenKm = 0;
  let guard0 = 0;
  while (guard0++ < 60) {
    const target = lastChosenKm + every;
    if (target > routeKm - minGapKm) break;          // troppo vicino all'arrivo: niente sosta
    const pick = pickAreaNear(sorted, {fromKm:lastChosenKm, target, forwardWindowKm:fwd, minGapKm});
    if (!pick || pick.area.routeKm <= lastChosenKm + minGapKm) { lastChosenKm = target; continue; }  // nessuna area utile (raro): salta lo slot
    stops.push({...pick.area, status:pick.status, kind:"normal"});
    lastChosenKm = pick.area.routeKm;
    if (stops.length > 40) break;
  }

  // --- Fase 2: tipo di ogni sosta. LA CADENZA COMANDA: le soste restano quelle della
  // Fase 1 (l'autonomia non le dirada ne' le sposta). Ogni sosta e' un RIFORNIMENTO, tranne
  // quando l'autonomia e' almeno il TRIPLO della tratta (allora basta una sosta tecnica:
  // c'e' margine abbondante). Vincolo di sicurezza: mai superare l'autonomia tra due
  // rifornimenti; se serve si inserisce un rifornimento extra su area reale.
  if (!aut) {
    for (const s of stops) s.kind = "normal";   // senza autonomia: solo soste tecniche di cadenza
    return stops;
  }

  const out = [];
  let lastRefuel = 0;     // km dell'ultimo pieno (allo start il serbatoio e' pieno)
  let prevKm = 0;         // km della sosta precedente (per misurare la tratta)
  let i = 0, guard = 0;
  while (i < stops.length && guard++ < 300) {
    const s = stops[i];
    if (s.status === "CRITICA") { out.push(s); prevKm = lastRefuel = s.routeKm; i++; continue; }
    // Sicurezza: se col pieno precedente non arrivo a questa sosta, rifornisco prima.
    if (s.routeKm - lastRefuel > aut) {
      const target = lastRefuel + aut;
      const pick = pickAreaNear(sorted, {fromKm:Math.max(prevKm, lastRefuel), target, forwardWindowKm:0, minGapKm, capKm:target});
      if (pick && pick.area.routeKm > lastRefuel + minGapKm && pick.area.routeKm < s.routeKm) {
        out.push({...pick.area, status:"VALIDA", kind:"fuel"});
        prevKm = lastRefuel = pick.area.routeKm;
        continue;   // rivaluta la stessa sosta col nuovo pieno
      }
      out.push({status:"CRITICA", kind:"fuel", routeKm:Math.round(target),
        message:"Nessuna area carburante valida entro l'autonomia: verifica manuale."});
      prevKm = lastRefuel = target;
      continue;
    }
    const leg = s.routeKm - prevKm;
    const nextKm = (i < stops.length - 1) ? stops[i+1].routeKm : routeKm;
    const preferTechnical = aut >= 3 * leg;          // autonomia >= 3x tratta -> sosta tecnica
    const reachNextIfSkip = nextKm - lastRefuel;      // se NON rifornisco, devo arrivare alla prossima
    if (preferTechnical && reachNextIfSkip <= aut) {
      s.kind = "normal";
    } else {
      s.kind = "fuel";
      lastRefuel = s.routeKm;
    }
    out.push(s);
    prevKm = s.routeKm;
    i++;
  }
  // Sicurezza finale: dall'ultimo pieno all'arrivo non superare l'autonomia.
  let guard2 = 0;
  while (routeKm - lastRefuel > aut && guard2++ < 30) {
    const target = lastRefuel + aut;
    const pick = pickAreaNear(sorted, {fromKm:lastRefuel, target, forwardWindowKm:0, minGapKm, capKm:target});
    if (pick && pick.area.routeKm > lastRefuel + minGapKm) { out.push({...pick.area, status:"VALIDA", kind:"fuel"}); lastRefuel = pick.area.routeKm; }
    else break;
  }
  out.sort((a,b)=>(a.routeKm||0)-(b.routeKm||0));
  return out;
}
