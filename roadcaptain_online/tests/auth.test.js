import { parseAccessCodes, findCode, signSession, verifySession, parseCookies } from "../auth.js";

// parsing codici: con etichetta e senza
const codes = parseAccessCodes("marco:AB12, lucia:CD34 , EF56");
if (codes.length !== 3) throw new Error("attesi 3 codici, trovati " + codes.length);
if (codes[0].label !== "marco" || codes[0].code !== "AB12") throw new Error("parsing etichetta errato");
if (codes[2].label !== "EF56" || codes[2].code !== "EF56") throw new Error("codice senza etichetta errato");

// match codice
if (!findCode(codes, "CD34") || findCode(codes, "CD34").label !== "lucia") throw new Error("match codice errato");
if (findCode(codes, "sbagliato")) throw new Error("un codice errato non deve combaciare");
if (findCode(codes, "")) throw new Error("codice vuoto non deve combaciare");

// firma/verifica sessione
const secret = "segreto-di-prova";
const exp = Date.now() + 60000;
const tok = signSession("marco", exp, secret);
const v = verifySession(tok, secret, Date.now());
if (!v.valid || v.label !== "marco") throw new Error("verifica sessione valida fallita");

// firma manomessa -> non valida
if (verifySession(tok + "x", secret, Date.now()).valid) throw new Error("token manomesso non deve essere valido");
// segreto diverso -> non valida
if (verifySession(tok, "altro-segreto", Date.now()).valid) throw new Error("segreto errato non deve validare");
// scaduto -> non valido
const old = signSession("x", Date.now() - 1000, secret);
if (verifySession(old, secret, Date.now()).valid) throw new Error("token scaduto non deve essere valido");

// cookie parsing
const c = parseCookies("a=1; rc_sess=abc.def.ghi; b=2");
if (c.rc_sess !== "abc.def.ghi") throw new Error("parsing cookie errato");

console.log("auth ok");
