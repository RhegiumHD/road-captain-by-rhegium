import { planFuelStops, calculateAutonomyKm } from "../engine.js";
const stops = planFuelStops({routeKm:500, pois:[{name:"A",routeKm:160},{name:"B",routeKm:320}], stopEveryKm:150, forwardWindowKm:25, maxAutonomyKm:200});
if (stops.length !== 2 || stops[0].name !== "A") throw new Error("fuel planner failed");
const autonomy = calculateAutonomyKm({tankCapacityL:15.5, consumptionKmL:13});
if (Math.round(autonomy) !== 202) throw new Error("autonomy calculation failed");

// A parita' di finestra, deve vincere la stazione piu' sulla rotta (scostamento minore),
// non solo la piu' vicina come km.
const onRoute = planFuelStops({
  routeKm:500,
  pois:[{name:"FuoriStrada",routeKm:158,offsetMeters:600},{name:"SullaRotta",routeKm:170,offsetMeters:60}],
  stopEveryKm:150, forwardWindowKm:25, maxAutonomyKm:200
});
if (onRoute[0].name !== "SullaRotta") throw new Error("offset preference failed: scelto " + onRoute[0].name);

// Dove c'e' una vera area autostradale, deve vincere anche se un benzinaio locale e' piu' vicino in linea d'aria.
const mw = planFuelStops({
  routeKm:500,
  pois:[{name:"BenzinaioLocale",routeKm:165,offsetMeters:30,onMotorway:false},{name:"AreaAutostradale",routeKm:172,offsetMeters:80,onMotorway:true}],
  stopEveryKm:150, forwardWindowKm:25, maxAutonomyKm:200
});
if (mw[0].name !== "AreaAutostradale") throw new Error("motorway preference failed: scelto " + mw[0].name);

// REGOLA DURA: nessuna area autostradale nella finestra [150,175], ma ce n'e' una a 195 (entro autonomia)
// e un benzinaio FUORI autostrada a 155. Deve PROLUNGARE all'area autostradale, non uscire.
const extend = planFuelStops({
  routeKm:600,
  pois:[{name:"FuoriAutostrada",routeKm:155,offsetMeters:40,onMotorway:false},{name:"AreaLontana",routeKm:195,offsetMeters:60,onMotorway:true}],
  stopEveryKm:150, forwardWindowKm:25, maxAutonomyKm:200
});
if (extend[0].name !== "AreaLontana") throw new Error("hard motorway rule failed: scelto " + extend[0].name);

console.log("engine ok");
