
import { planFuelStops, addStopEtas, applyLongStop } from "../engine.js";

const stops = planFuelStops({
  routeKm: 520,
  targetStopKm: 150,
  forwardWindowKm: 25,
  maxAutonomyKm: 200,
  serviceAreas: [
    { name: "Area di Servizio A", routeKm: 160 },
    { name: "Area di Servizio B", routeKm: 320 }
  ]
});

if (stops.length !== 2) throw new Error("Numero soste errato");
if (stops[0].durationMinutes !== 20) throw new Error("Durata sosta normale non corretta");

let schedule = addStopEtas(stops, 360, 520, "2026-05-15", "depart", "08:00");
const updated = applyLongStop(schedule.stops, { enabled: true, type: "pranzo", time: "12:00", durationMinutes: 90 });

if (!updated.some(s => s.longStop && s.type === "pranzo")) throw new Error("Sosta lunga non applicata");

console.log("engine tests ok");
