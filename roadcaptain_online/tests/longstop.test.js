import { addMinutes, fmtRome, parseRomeDateTime } from "../time-utils.js";

// Riproduce il loop finale del server (/api/plan) per bloccare due regole:
// 1) la sosta lunga SOSTITUISCE la normale (ripartenza = arrivo + durata lunga, non +20+lunga);
// 2) l'orario REALE di arrivo a una sosta include le soste lunghe PRECEDENTI
//    (cosi' l'avviso non scatta in modo errato, come nel caso "18:35" invece di 20:35).
const stopMinutes = 20;
const dist = 500, durH = 8; // 8 ore di guida
const stops = [{ routeKm: 100 }, { routeKm: 200 }, { routeKm: 300 }, { routeKm: 400 }].map(s => ({ ...s, status: "VALIDA" }));
stops[0].longStopMinutes = 60; stops[0].longStopTargetTime = "13:00";
stops[1].longStopMinutes = 60; stops[1].longStopTargetTime = "17:00";

const valid = stops.length, nLong = 2, sumLong = 120;
const totalMin = durH * 60 + valid * stopMinutes + sumLong - stopMinutes * nLong; // 480+80+120-40 = 640
const departure = parseRomeDateTime("2026-05-15", "08:00");
const effStop = s => (Number(s.longStopMinutes || 0) > 0 ? Number(s.longStopMinutes) : stopMinutes);

let acc = 0; const arr = [], dep = [];
for (const s of stops) {
  const drive = (s.routeKm / dist) * durH * 60;
  const eta = addMinutes(departure, drive + acc);
  const eff = effStop(s);
  arr.push(eta); dep.push(addMinutes(eta, eff));
  acc += eff;
}

// 1) Sostituzione: stop0 ha sosta lunga 60 -> riparte 60 dopo l'arrivo (non 80).
if (Math.round((dep[0].getTime() - arr[0].getTime()) / 60000) !== 60) throw new Error("replace fallito: ripartenza != arrivo+60");

// 2) ETA reale di stop2 include le due soste lunghe precedenti (60+60).
// drive stop2 = 300/500*480 = 288 min; acc precedente = 120 -> 08:00 + 408 = 14:48 (non 12:48).
const expected = addMinutes(departure, 288 + 120);
if (fmtRome(arr[2]) !== fmtRome(expected)) throw new Error("ETA reale stop2 errata: " + fmtRome(arr[2]) + " atteso " + fmtRome(expected));

console.log("longstop ok");
