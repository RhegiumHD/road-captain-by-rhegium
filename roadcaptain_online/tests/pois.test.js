import { attractionScore, attractionIcon, distributeAttractions } from "../server.js";

// 1) Distribuzione: 30 POI tutti concentrati nei primi 20 km + qualcuno sparso.
// Il vecchio comportamento (slice 0..10 ordinato per km) avrebbe restituito SOLO
// roba del primo tratto. La nuova distribuzione deve coprire tutto l'itinerario.
const routeKm = 400;
const items = [];
for (let i = 0; i < 30; i++) items.push({ name: "vicino" + i, routeKm: Math.random() * 20, score: Math.random() });
for (const km of [60, 120, 190, 250, 310, 370]) items.push({ name: "lontano@" + km, routeKm: km, score: 5 });

const out = distributeAttractions(items, routeKm, 24);
const maxKm = Math.max(...out.map(p => p.routeKm));
if (maxKm < 300) throw new Error("distribuzione: i POI non coprono tutto l'itinerario (max km " + maxKm.toFixed(0) + ")");
const distantKept = out.filter(p => p.routeKm > 50).length;
if (distantKept < 6) throw new Error("distribuzione: persi i POI dei tratti lontani (tenuti " + distantKept + "/6)");
// L'ordine finale deve essere per km crescente.
for (let i = 1; i < out.length; i++) if (out[i].routeKm < out[i - 1].routeKm) throw new Error("distribuzione: output non ordinato per km");

// 2) Rilevanza: piu' recensioni + voto alto => punteggio piu' alto.
const top = attractionScore({ rating: 4.8, userRatingCount: 5000 });
const low = attractionScore({ rating: 4.0, userRatingCount: 8 });
if (!(top > low)) throw new Error("score: il POI piu' recensito dovrebbe avere punteggio maggiore");
// Fallback senza rating: il tag wiki deve pesare.
const wiki = attractionScore({ rating: 0, userRatingCount: 0, tags: { wikidata: "Q42" }, category: "castle" });
const plain = attractionScore({ rating: 0, userRatingCount: 0, tags: {}, category: "POI", name: "Luogo di interesse" });
if (!(wiki > plain)) throw new Error("score fallback: il POI con wikidata dovrebbe valere di piu'");

// 3) Categoria dedicata per tipo (chiave usata poi per l'icona SVG).
if (attractionIcon({ types: ["museum"] }) !== "museum") throw new Error("categoria museo errata");
if (attractionIcon({ types: ["park"] }) !== "park") throw new Error("categoria parco errata");
if (attractionIcon({ primaryType: "church" }) !== "church") throw new Error("categoria chiesa errata");
if (attractionIcon({ category: "Castello" }) !== "castle") throw new Error("categoria castello errata");
if (attractionIcon({ types: ["tourist_attraction"] }) !== "poi") throw new Error("categoria default errata");

console.log("pois ok");
