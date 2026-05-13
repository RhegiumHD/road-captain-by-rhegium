import { planFuelStops } from "../engine.js";
const stops = planFuelStops({routeKm:500, stopEveryKm:150, forwardWindowKm:25, maxAutonomyKm:200, pois:[
 {name:"A",routeKm:160},{name:"B",routeKm:320}
]});
if (stops.length !== 2) throw new Error("Expected two stops");
console.log("engine tests ok");
