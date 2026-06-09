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

// 4) REGRESSIONE SEQUENZIALITA' (bug "salta da 377 a 976"):
//    aree disponibili lungo tutto il percorso -> le soste devono cadere a ogni intervallo,
//    senza buchi enormi tra una sosta e l'altra.
const seqPois = [];
for (let km = 40; km < 1322; km += 50) seqPois.push({name:"A"+km, routeKm:km, offsetMeters:60, onMotorway:true, side:"right"});
const seq = planStops({routeKm:1322, pois:seqPois, stopEveryKm:330, forwardWindowKm:30, autonomyKm:1100});
if (seq.length < 3) throw new Error("sequenzialita': attese piu' soste, trovate " + seq.length);
const seqKm = [0, ...seq.map(s=>s.routeKm)];
for (let i=1;i<seqKm.length;i++){
  const gap = seqKm[i]-seqKm[i-1];
  if (gap > 330*1.5) throw new Error("buco troppo grande tra soste: "+gap.toFixed(0)+" km (atteso ~330)");
}
// le soste cadono vicino ai multipli dell'intervallo (330, 660, 990, 1320)
[330,660,990].forEach(t=>{
  if (!seq.some(s=>Math.abs(s.routeKm-t)<=330*0.6)) throw new Error("manca la sosta vicino a km "+t);
});

console.log("cadence-seq ok");

// 5) CADENZA DOMINANTE + REGOLA RIFORNIMENTO. Cadenza 150 km, autonomia 270 (< 3x150=450):
//    le soste devono cadere ~ogni 150 km (la cadenza comanda, l'autonomia non le dirada) e
//    ognuna deve essere un RIFORNIMENTO.
const densePois = [];
for (let km = 20; km < 1300; km += 20) densePois.push({name:"A"+km, routeKm:km, offsetMeters:40, onMotorway:true, side:"right"});
const dom = planStops({routeKm:1300, pois:densePois, stopEveryKm:150, forwardWindowKm:25, autonomyKm:270});
if (dom.some(s => s.kind !== "fuel")) throw new Error("autonomia < 3x tratta: ogni sosta deve essere un rifornimento");
const domKm = [0, ...dom.map(s=>s.routeKm)];
for (let i=1;i<domKm.length;i++){ const gap = domKm[i]-domKm[i-1]; if (gap > 150*1.5) throw new Error("cadenza non rispettata: tratta di "+gap.toFixed(0)+" km (atteso ~150)"); }
console.log("cadence-dominant ok");

// 6) SERBATOIO GRANDE: autonomia 600 (>= 3x150=450) -> compaiono soste tecniche, ma senza
//    mai restare a secco (tra due rifornimenti la distanza non supera l'autonomia).
const big = planStops({routeKm:1300, pois:densePois, stopEveryKm:150, forwardWindowKm:25, autonomyKm:600});
if (!big.some(s => s.kind === "normal")) throw new Error("con autonomia ampia dovrebbero esserci soste tecniche");
if (!big.some(s => s.kind === "fuel")) throw new Error("anche con autonomia ampia serve almeno un rifornimento sul lungo raggio");
let lastF = 0;
for (const s of big){ if (s.kind === "fuel"){ if (s.routeKm - lastF > 600 + 1) throw new Error("tratto a secco: "+(s.routeKm-lastF).toFixed(0)+" km > autonomia"); lastF = s.routeKm; } }
if (1300 - lastF > 600 + 1) throw new Error("ultimo tratto verso l'arrivo oltre l'autonomia");
console.log("cadence-bigtank ok");
