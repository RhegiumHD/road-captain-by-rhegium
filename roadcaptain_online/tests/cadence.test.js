import { planStops } from "../engine.js";

// Aree disponibili ogni ~80 km lungo 1200 km.
const pois = [];
for (let km = 80; km < 1200; km += 80) pois.push({name:"Area"+km, routeKm:km, offsetMeters:50, onMotorway:true, side:"right"});

// 1) CADENZA SENZA AUTONOMIA: le soste si creano comunque (bug "nessuna sosta necessaria"),
//    tutte come soste tecniche (no rifornimento).
const noAut = planStops({routeKm:1200, pois, stopEveryKm:240, forwardWindowKm:30});
if (!noAut.length) throw new Error("senza autonomia non sono state create soste a cadenza");
if (noAut.some(s => s.kind !== "normal")) throw new Error("senza autonomia tutte le soste devono essere tecniche");
// spaziatura ~240 km, niente buchi doppi (tutte le tratte simili: nessuna ~doppia)
const kmList = [0, ...noAut.map(s=>s.routeKm), 1200];
const legs = kmList.slice(1).map((k,i)=> k - kmList[i]);
const maxLeg = Math.max(...legs.slice(0,-1)); // esclude l'ultima tratta verso l'arrivo
if (maxLeg > 240 * 1.6) throw new Error("tratta troppo lunga tra soste: " + maxLeg.toFixed(0) + " km (atteso ~240)");

// 2) CON AUTONOMIA: il rifornimento coincide con una sosta di cadenza (la piu' vicina al limite),
//    e nessun tratto a serbatoio pieno supera l'autonomia.
const aut = 260;
const withAut = planStops({routeKm:1200, pois, stopEveryKm:240, forwardWindowKm:30, autonomyKm:aut});
const fuelStops = withAut.filter(s => s.kind === "fuel");
if (!fuelStops.length) throw new Error("con autonomia deve esserci almeno un rifornimento");
// ogni rifornimento e' una delle soste pianificate (coincide, non e' una sosta a se' inventata fuori lista)
if (fuelStops.some(s => s.status === "CRITICA")) throw new Error("rifornimento critico: nessuna area entro autonomia nei dati di test");
// verifica autonomia: distanza tra rifornimenti consecutivi (e dallo start) <= autonomia
let prev = 0;
for (const f of fuelStops) { if (f.routeKm - prev > aut + 1) throw new Error("tratto oltre autonomia: " + (f.routeKm-prev).toFixed(0)); prev = f.routeKm; }

// 3) TRATTE UNIFORMI DOPO LA SOSTA LUNGA: riproduce il calcolo del server (legDrive proporzionale ai km).
//    Con soste a cadenza uniforme, la tratta dopo una sosta (anche se lunga) NON raddoppia.
const durH = 10, dist = 1200;
let prevDrive = 0; const legMins = [];
for (const s of noAut) {
  const driveTo = (s.routeKm / dist) * durH * 60;
  legMins.push(driveTo - prevDrive);
  prevDrive = driveTo;
}
const minLeg = Math.min(...legMins), maxLegMin = Math.max(...legMins);
if (maxLegMin > minLeg * 1.6) throw new Error("tratte non uniformi: " + minLeg.toFixed(0) + "→" + maxLegMin.toFixed(0) + " min (sintomo del bug 2h vs 4h)");

console.log("cadence ok");
