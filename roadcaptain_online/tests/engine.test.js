import { selectFuelStops } from '../engine.js';
const progress = Array.from({length:301}, (_,i)=>({lat:0,lng:i/1000,km:i}));
const pois = [
 {id:'a', name:'A', routeKm:160, offsetMeters:10},
 {id:'b', name:'B', routeKm:315, offsetMeters:10},
 {id:'c', name:'C', routeKm:470, offsetMeters:10}
];
const stops = selectFuelStops({progress, pois, stopEveryKm:150, forwardWindowKm:25, maxAutonomyKm:200});
if (stops.length !== 1 || stops[0].id !== 'a') throw new Error('Engine test failed');
console.log('engine ok');
