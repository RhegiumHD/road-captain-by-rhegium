
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

// Sceglie l'area reale piu' adatta vicino a un km obiettivo, applicando le regole dure:
// solo aree autostradali se ce ne sono, solo carreggiata destra se disponibile, poi
// finestra ideale [target, target+margine] -> prolunga avanti -> ripiega indietro.
function pickAreaNear(sorted, {fromKm, target, forwardWindowKm, minGapKm, capKm=Infinity}) {
  const byOffset = (a,b)=>(Number(a.offsetMeters||0)-Number(b.offsetMeters||0)) || (a.routeKm-b.routeKm);
  let pool = sorted.filter(p => p.routeKm > fromKm + minGapKm && p.routeKm <= capKm);
  const onMw = pool.filter(p => p.onMotorway);
  if (onMw.length) pool = onMw;                 // REGOLA DURA: mai fuori autostrada se c'e' un'area
  const right = pool.filter(p => p.side === "right");
  if (right.length) pool = right;               // carreggiata corretta (lato destro)
  if (!pool.length) return null;
  const within = pool.filter(p => p.routeKm >= target && p.routeKm <= target + Number(forwardWindowKm)).sort(byOffset);
  const after  = pool.filter(p => p.routeKm > target + Number(forwardWindowKm)).sort((a,b)=>a.routeKm-b.routeKm);
  const before = pool.filter(p => p.routeKm < target).sort((a,b)=>b.routeKm-a.routeKm);
  if (within.length) return {area:within[0], status:"VALIDA"};
  if (after.length)  return {area:after[0],  status:"VALIDA"};   // prolungata per restare in area reale
  if (before.length) return {area:before[0], status:"ANTICIPATA"};
  return null;
}

// Sceglie l'area di servizio per UNA tappa di cadenza ancorata a `target`.
// A differenza di pickAreaNear (pensata per il rifornimento, che puo' prolungare lontano),
// qui resta VICINO al target: prima la finestra con un po' di margine [target, target+fwd],
// poi l'area piu' vicina al target entro una banda; se non c'e' nulla di vicino, salta la
// tappa (la cadenza riprende al target successivo) invece di deviare di centinaia di km.
function pickGridArea(sorted, {target, minFromKm, bandKm, forwardWindowKm}) {
  const byOffset = (a,b)=>(Number(a.offsetMeters||0)-Number(b.offsetMeters||0)) || (a.routeKm-b.routeKm);
  let pool = sorted.filter(p => p.routeKm > minFromKm);
  const onMw = pool.filter(p => p.onMotorway);
  if (onMw.length) pool = onMw;
  const right = pool.filter(p => p.side === "right");
  if (right.length) pool = right;
  if (!pool.length) return null;
  const within = pool.filter(p => p.routeKm >= target && p.routeKm <= target + Number(forwardWindowKm)).sort(byOffset);
  if (within.length) return {area:within[0], status:"VALIDA"};   // margine preferito (subito dopo il target)
  const inBand = pool.filter(p => Math.abs(p.routeKm - target) <= bandKm)
                     .sort((a,b)=> Math.abs(a.routeKm-target) - Math.abs(b.routeKm-target));
  if (inBand.length) return {area:inBand[0], status: inBand[0].routeKm < target ? "ANTICIPATA" : "VALIDA"};
  return null;
}

// Pianifica le soste in due fasi nette:
//  1) CADENZA: una sosta NORMALE (no rifornimento) ogni `stopEveryKm` (km od ore->km),
//     ancorata a un'area di servizio reale. E' l'unico criterio se l'autonomia non e' nota.
//  2) RIFORNIMENTO: SOLO se l'utente fornisce l'autonomia. Si rifornisce alla sosta di
//     cadenza piu' vicina al limite di autonomia (senza superarlo); se il salto tra due
//     soste eccede l'autonomia, si inserisce un rifornimento aggiuntivo su area reale.
// Ogni sosta porta `kind`: "normal" (sosta tecnica, no carburante) o "fuel" (rifornimento).
export function planStops({routeKm, pois, stopEveryKm=150, forwardWindowKm=25, autonomyKm=null}) {
  const sorted = [...pois].sort((a,b)=>a.routeKm-b.routeKm);
  const minGapKm = 35;
  const every = Math.max(1, Number(stopEveryKm) || 150);
  const fwd = Number(forwardWindowKm) || 25;
  const aut = (autonomyKm && Number(autonomyKm) > 0) ? Number(autonomyKm) : null;

  // --- Fase 1: soste a cadenza (normali), ANCORATE alla griglia degli intervalli ---
  // I target sono fissi: every, 2*every, 3*every... cosi' la cadenza non "deriva" e non
  // salta gli intervalli successivi se una singola area cade lontana.
  const stops = [];
  let lastChosenKm = 0;
  const nMax = Math.ceil(routeKm / every) + 1;
  for (let k = 1; k <= nMax; k++) {
    const target = k * every;
    if (target > routeKm - minGapKm) break;        // troppo vicino all'arrivo: niente sosta
    const pick = pickGridArea(sorted, {target, minFromKm:lastChosenKm + minGapKm, bandKm:every*0.6, forwardWindowKm:fwd});
    if (!pick) continue;                           // nessuna area vicina a questo target: si riprende al prossimo
    if (pick.area.routeKm <= lastChosenKm + minGapKm) continue;   // evita doppioni / aree gia' superate
    stops.push({...pick.area, status:pick.status, kind:"normal"});
    lastChosenKm = pick.area.routeKm;
    if (stops.length > 30) break;
  }

  // --- Fase 2: rifornimento agganciato alla cadenza (solo con autonomia nota) ---
  if (aut && routeKm > aut) {
    let rangeStart = 0;   // km con il serbatoio appena riempito
    let i = 0;            // indice della prima sosta non ancora valutata
    let guard = 0;
    while (rangeStart + aut < routeKm && guard++ < 60) {
      const reach = rangeStart + aut;
      // ultima sosta di cadenza raggiungibile entro l'autonomia (la piu' vicina al limite)
      let lastReachable = -1;
      for (let j = i; j < stops.length; j++) {
        if (stops[j].status === "CRITICA") continue;
        if (stops[j].routeKm <= reach) lastReachable = j; else break;
      }
      if (lastReachable >= 0) {
        stops[lastReachable].kind = "fuel";
        rangeStart = stops[lastReachable].routeKm;
        i = lastReachable + 1;
      } else {
        // la prossima sosta di cadenza e' oltre l'autonomia: serve un rifornimento PRIMA
        const pick = pickAreaNear(sorted, {fromKm:rangeStart, target:reach, forwardWindowKm:0, minGapKm, capKm:reach});
        if (pick) {
          stops.splice(i, 0, {...pick.area, status:"VALIDA", kind:"fuel"});
          rangeStart = pick.area.routeKm;
        } else {
          stops.splice(i, 0, {status:"CRITICA", kind:"fuel", routeKm:Math.round(reach),
            message:"Nessuna area carburante valida entro l'autonomia: verifica manuale."});
          rangeStart = reach;
        }
        i = i + 1;
      }
    }
  }
  return stops;
}
