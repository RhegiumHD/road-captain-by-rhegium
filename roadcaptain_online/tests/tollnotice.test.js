import { buildTollNotice } from "../server.js";

// Opzione non attiva: nessun messaggio.
if (buildTollNotice({avoidTolls:false, tolls:{amount:5}, source:"Google Routes"}) !== null) throw new Error("senza opzione non deve esserci messaggio");

// Evita pedaggi + percorso davvero gratuito.
const free = buildTollNotice({avoidTolls:true, tolls:{available:false, amount:0}, source:"Google Routes"});
if (!free || free.level !== "ok") throw new Error("percorso gratuito: atteso livello ok");

// Evita pedaggi ma pedaggio inevitabile: deve dire che e' il piu' economico, con importo.
const cheapest = buildTollNotice({avoidTolls:true, tolls:{available:true, amount:7.5}, source:"Google Routes"});
if (!cheapest || cheapest.level !== "warn") throw new Error("pedaggio inevitabile: atteso livello warn");
if (!/economico/i.test(cheapest.text) || !/7\.50/.test(cheapest.text)) throw new Error("pedaggio inevitabile: testo o importo errati");

// Evita pedaggi in modalita' fallback (no Google): avviso informativo.
const fb = buildTollNotice({avoidTolls:true, tolls:{available:false, amount:null}, source:"OSRM fallback"});
if (!fb || fb.level !== "info") throw new Error("fallback: atteso livello info");

console.log("tollnotice ok");
