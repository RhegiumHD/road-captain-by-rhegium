import { attractionScore, attractionIcon, distributeAttractions, isLandmarkVisible } from "../server.js";

// 1) Distribuzione: landmark visibili sparsi su tutto il percorso + alcuni da escludere.
const routeKm = 1200;
const items = [];
// uno ogni ~100 km, visibile (Castello/Attrazione), per coprire fino alla fine
for (let km = 50; km <= 1150; km += 100) items.push({ name: "Castello@" + km, routeKm: km, offsetMeters: 800, category: "Castello", score: 5 });
// rumore vicino all'inizio che NON deve monopolizzare (musei/cantine/terme -> esclusi)
for (let i = 0; i < 20; i++) items.push({ name: "Museo" + i, routeKm: 10 + i, offsetMeters: 500, category: "Museo", score: 9 });
items.push({ name: "Cantina", routeKm: 300, offsetMeters: 400, category: "Azienda vinicola", score: 9 });
items.push({ name: "Terme", routeKm: 500, offsetMeters: 400, category: "Spa", score: 9 });

const out = distributeAttractions(items, routeKm, 10);
if (out.length > 10) throw new Error("max 10 POI, trovati " + out.length);
if (out.some(p => /Museo|Cantina|Terme/.test(p.name))) throw new Error("inclusi POI non visibili di passaggio");
const maxKm = Math.max(...out.map(p => p.routeKm));
if (maxKm < 1000) throw new Error("i POI non arrivano verso la fine (max " + maxKm + ")");
for (let i = 1; i < out.length; i++) if (out[i].routeKm < out[i - 1].routeKm) throw new Error("output non ordinato per km");

// filtro visibilita'
if (!isLandmarkVisible({ category: "Castello" })) throw new Error("castello deve essere visibile");
if (!isLandmarkVisible({ category: "Punto panoramico" })) throw new Error("punto panoramico deve essere visibile");
if (isLandmarkVisible({ category: "Museo" })) throw new Error("museo NON deve essere visibile di passaggio");
if (isLandmarkVisible({ category: "Azienda vinicola" })) throw new Error("cantina NON deve essere visibile di passaggio");
if (isLandmarkVisible({ category: "Parco acquatico" })) throw new Error("parco acquatico NON deve essere incluso");

// 2) Rilevanza
const top = attractionScore({ rating: 4.8, userRatingCount: 5000 });
const low = attractionScore({ rating: 4.0, userRatingCount: 8 });
if (!(top > low)) throw new Error("score: il POI piu' recensito dovrebbe avere punteggio maggiore");

// 3) Categoria/icona
if (attractionIcon({ types: ["museum"] }) !== "museum") throw new Error("categoria museo errata");
if (attractionIcon({ category: "Castello" }) !== "castle") throw new Error("categoria castello errata");
if (attractionIcon({ types: ["tourist_attraction"] }) !== "poi") throw new Error("categoria default errata");

console.log("pois ok");
