import { planStops, calculateAutonomyKm } from "../engine.js";

// Cadenza base: 2 soste su 500 km ogni 150 km (target 150 e ~310), prima = "A".
const stops = planStops({routeKm:500, pois:[{name:"A",routeKm:160},{name:"B",routeKm:320}], stopEveryKm:150, forwardWindowKm:25});
if (stops.length !== 2 || stops[0].name !== "A") throw new Error("cadence planner failed");
if (calculateAutonomyKm({tankCapacityL:15.5, consumptionKmL:13}) !== Math.round(202.0*1)/1 && Math.round(calculateAutonomyKm({tankCapacityL:15.5, consumptionKmL:13})) !== 202) throw new Error("autonomy calculation failed");

// Senza autonomia: nessuna sosta e' di rifornimento (tutte tecniche).
if (stops.some(s => s.kind !== "normal")) throw new Error("senza autonomia le soste devono essere tutte 'normal'");

// A parita' di finestra vince la stazione piu' sulla rotta (scostamento minore).
const onRoute = planStops({routeKm:500, pois:[{name:"FuoriStrada",routeKm:158,offsetMeters:600},{name:"SullaRotta",routeKm:170,offsetMeters:60}], stopEveryKm:150, forwardWindowKm:25});
if (onRoute[0].name !== "SullaRotta") throw new Error("offset preference failed: scelto " + onRoute[0].name);

// Dove c'e' una vera area autostradale, vince anche se un benzinaio locale e' piu' vicino.
const mw = planStops({routeKm:500, pois:[{name:"BenzinaioLocale",routeKm:165,offsetMeters:30,onMotorway:false},{name:"AreaAutostradale",routeKm:172,offsetMeters:80,onMotorway:true}], stopEveryKm:150, forwardWindowKm:25});
if (mw[0].name !== "AreaAutostradale") throw new Error("motorway preference failed: scelto " + mw[0].name);

// REGOLA DURA: nessuna area in finestra ma una a 195 -> PROLUNGA, non esce dall'autostrada.
const extend = planStops({routeKm:600, pois:[{name:"FuoriAutostrada",routeKm:155,offsetMeters:40,onMotorway:false},{name:"AreaLontana",routeKm:195,offsetMeters:60,onMotorway:true}], stopEveryKm:150, forwardWindowKm:25});
if (extend[0].name !== "AreaLontana") throw new Error("hard motorway rule failed: scelto " + extend[0].name);

// CARREGGIATA: tra due aree vicine, vince quella sul lato destro.
const side = planStops({routeKm:500, pois:[{name:"AreaOpposta",routeKm:168,offsetMeters:30,onMotorway:true,side:"left"},{name:"AreaTua",routeKm:170,offsetMeters:50,onMotorway:true,side:"right"}], stopEveryKm:150, forwardWindowKm:25});
if (side[0].name !== "AreaTua") throw new Error("carriageway rule failed: scelto " + side[0].name);

console.log("engine ok");
