import { withTollEstimate } from "../server.js";

// Google segnala pedaggio ma senza importo: deve aggiungere una stima > 0.
const est = withTollEstimate({available:true, amount:null}, 600, "Google Routes");
if (est.estimatedAmount == null || !(est.estimatedAmount > 0)) throw new Error("doveva allegare una stima per pedaggio non quotato");
if (!/approssimativa/i.test(est.estimateNote || "")) throw new Error("manca la nota di approssimazione");

// Importo gia' fornito da Google: non si tocca.
const exact = withTollEstimate({available:true, amount:12.3}, 600, "Google Routes");
if (exact.estimatedAmount != null) throw new Error("non deve stimare se l'importo c'e' gia'");

// Nessun pedaggio: non si stima.
const none = withTollEstimate({available:false, amount:0}, 600, "Google Routes");
if (none.estimatedAmount != null) throw new Error("non deve stimare se non c'e' pedaggio");

// Fallback senza Google: niente stima (non sappiamo nemmeno se c'e' un pedaggio).
const fb = withTollEstimate({available:false, amount:null}, 600, "OSRM fallback");
if (fb.estimatedAmount != null) throw new Error("in fallback non si inventano importi");

console.log("tollestimate ok");
