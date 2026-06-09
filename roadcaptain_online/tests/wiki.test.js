import { classifyWikiTitle, attractionScore, isLandmarkVisible, attractionIcon, distributeAttractions } from "../server.js";

const mk = (title) => { const c = classifyWikiTitle(title); return {name:title, ...c}; };

// Classificazione + visibilita' di passaggio
const castello = mk("Castello Ruffo di Scilla");
if (castello.primaryType !== "castle") throw new Error("castello non classificato: " + castello.primaryType);
if (!isLandmarkVisible(castello)) throw new Error("castello dovrebbe essere visibile");
if (attractionIcon(castello) !== "castle") throw new Error("icona castello errata");

const duomo = mk("Duomo di Orvieto");
if (duomo.primaryType !== "church" || !isLandmarkVisible(duomo)) throw new Error("duomo ko");

const parco = mk("Parco della Lavanda");
if (parco.primaryType !== "park" || !isLandmarkVisible(parco)) throw new Error("parco ko");

// Generico (paese/fiume): deve essere SCARTATO
const paese = mk("Morano Calabro");
if (paese.primaryType !== "locality") throw new Error("paese non e' locality: " + paese.primaryType);
if (isLandmarkVisible(paese)) throw new Error("un paese generico NON deve passare come landmark");

// Museo: classificato ma ESCLUSO (non visibile di passaggio)
const museo = mk("Museo Egizio");
if (isLandmarkVisible(museo)) throw new Error("un museo non deve passare (richiede di entrare)");

// Punteggio: castello > parco > (generico)
if (!(attractionScore(castello) > attractionScore(parco))) throw new Error("score: castello deve battere parco");
if (!(attractionScore(parco) > attractionScore(paese))) throw new Error("score: parco deve battere generico");

// distributeAttractions: filtra i generici e sceglie 1 per segmento (il piu' rilevante vicino)
const items = [
  {...mk("Castello di A"), routeKm:50,  offsetMeters:500,  score:attractionScore(mk("Castello di A"))},
  {...mk("Bar di A"),      routeKm:55,  offsetMeters:200,  score:attractionScore(mk("Bar di A"))},     // locality -> fuori
  {...mk("Duomo di B"),    routeKm:250, offsetMeters:800,  score:attractionScore(mk("Duomo di B"))},
  {...mk("Comune di C"),   routeKm:251, offsetMeters:100,  score:attractionScore(mk("Comune di C"))},  // locality -> fuori
];
const chosen = distributeAttractions(items, 300, 3);
if (chosen.some(c => c.primaryType === "locality")) throw new Error("distribuzione: un generico e' passato");
if (!chosen.find(c => c.name === "Castello di A")) throw new Error("distribuzione: manca il castello");
if (!chosen.find(c => c.name === "Duomo di B")) throw new Error("distribuzione: manca il duomo");

console.log("wiki ok");
