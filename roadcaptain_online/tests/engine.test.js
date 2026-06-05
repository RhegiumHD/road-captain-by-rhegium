import { planFuelStops, calculateAutonomyKm } from "../engine.js";
const stops = planFuelStops({routeKm:500, pois:[{name:"A",routeKm:160},{name:"B",routeKm:320}], stopEveryKm:150, forwardWindowKm:25, maxAutonomyKm:200});
if (stops.length !== 2 || stops[0].name !== "A") throw new Error("fuel planner failed");
const autonomy = calculateAutonomyKm({tankCapacityL:15.5, consumptionKmL:13});
if (Math.round(autonomy) !== 202) throw new Error("autonomy calculation failed");
console.log("engine ok");
