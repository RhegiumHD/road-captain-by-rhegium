import { addMinutes, fmtRome, parseRomeDateTime } from "../time-utils.js";

// Riproduce la logica di scelta della sosta lunga del server (blocco /api/plan)
// con una rotta sintetica, per bloccare il comportamento di "Arrivo entro".
// Invariante verificato: la sosta lunga deve essere agganciata alla sosta carburante
// il cui orario REALE di arrivo (sulla timeline finale) e' il piu' vicino al target.
function run({ mode, dateStr, timeStr, durationHours, distanceKm, stops, longStopMinutes, targetTime }) {
  const stopMinutes = 20;
  const valid = stops.filter(s => s.status !== "CRITICA");
  // La sosta lunga SOSTITUISCE la sosta normale: una sosta vale la durata lunga se presente, altrimenti 20.
  const nAssignedLong = Math.min(1, valid.length); // un solo long stop in questo test
  const totalMin = durationHours * 60 + valid.length * stopMinutes + longStopMinutes - stopMinutes * nAssignedLong;
  const departure = mode === "arrive"
    ? addMinutes(parseRomeDateTime(dateStr, timeStr), -totalMin)
    : parseRomeDateTime(dateStr, timeStr);

  const driveTo = (s) => (Number(s.routeKm || 0) / distanceKm) * durationHours * 60;
  const effOf = (s, chosen) => (s === chosen ? longStopMinutes : stopMinutes);
  // ETA reale di una sosta data una scelta del long stop (include soste precedenti, effettive).
  function etaReal(stop, chosen) {
    let extra = 0;
    for (const o of stops) { if (o === stop) break; if (o.status !== "CRITICA") extra += effOf(o, chosen); }
    return addMinutes(departure, driveTo(stop) + extra);
  }
  const absDiff = (a, b) => Math.abs((a.getTime() - b.getTime()) / 60000);
  const target = parseRomeDateTime(dateStr, targetTime);
  const tdiff = (eta) => Math.min(absDiff(eta, target), absDiff(addMinutes(eta, 1440), target), absDiff(addMinutes(eta, -1440), target));

  // --- selezione del server: in fase di scelta nessun long stop e' ancora assegnato (chosen=null) ---
  let chosen = valid[0], best = Infinity;
  for (const s of valid) { const d = tdiff(etaReal(s, null)); if (d < best) { best = d; chosen = s; } }

  // --- verifica: la scelta deve essere il minimo globale sullo scostamento reale dal target ---
  let trueBest = null, trueBestDiff = Infinity;
  for (const s of valid) { const d = tdiff(etaReal(s, chosen)); if (d < trueBestDiff) { trueBestDiff = d; trueBest = s; } }
  return { chosen, trueBest, chosenRealDiff: tdiff(etaReal(chosen, chosen)), realEtaHHMM: fmtRome(etaReal(chosen, chosen)).split(", ")[1] };
}

// Caso chiave: arrivo entro le 18:00, pranzo 120 min verso le 13:00.
// Prima del fix sceglieva la sosta A (arrivo reale 10:50, ~130 min fuori target).
const a = run({ mode: "arrive", dateStr: "2026-05-15", timeStr: "18:00", durationHours: 6, distanceKm: 540,
  stops: [{ name: "A", routeKm: 135, status: "VALIDA" }, { name: "B", routeKm: 360, status: "VALIDA" }],
  longStopMinutes: 120, targetTime: "13:00" });
if (a.chosen !== a.trueBest) throw new Error("arrive: sosta scelta non e' la piu' vicina al target (scelta " + a.chosen.name + ", reale " + a.realEtaHHMM + ")");
if (a.chosen.name !== "B") throw new Error("arrive: attesa sosta B, scelta " + a.chosen.name);

// Controprova depart: la scelta deve restare il minimo globale (nessuna regressione).
const d = run({ mode: "depart", dateStr: "2026-05-15", timeStr: "08:00", durationHours: 5, distanceKm: 450,
  stops: [{ name: "A", routeKm: 150, status: "VALIDA" }, { name: "B", routeKm: 300, status: "VALIDA" }],
  longStopMinutes: 60, targetTime: "13:00" });
if (d.chosen !== d.trueBest) throw new Error("depart: sosta scelta non e' la piu' vicina al target");

console.log("arrive ok");
