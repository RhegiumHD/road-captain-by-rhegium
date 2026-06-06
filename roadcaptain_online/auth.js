import crypto from "node:crypto";

// Legge la lista codici dall'ambiente. Formato: "etichetta:CODICE" separati da virgola
// (o solo "CODICE"). Esempi: "marco:AB12,lucia:CD34" oppure "AB12,CD34".
export function parseAccessCodes(str) {
  return String(str || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(part => {
      const i = part.indexOf(":");
      if (i > 0) return { label: part.slice(0, i).trim(), code: part.slice(i + 1).trim() };
      return { label: part, code: part };
    })
    .filter(x => x.code);
}

// Restituisce la voce {label, code} che corrisponde all'input, o null. Confronto
// a tempo costante per non rivelare i codici tramite i tempi di risposta.
export function findCode(codes, input) {
  const given = String(input || "");
  for (const entry of codes) {
    const a = Buffer.from(entry.code);
    const b = Buffer.from(given);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return entry;
  }
  return null;
}

const b64u = s => Buffer.from(String(s), "utf8").toString("base64url");
const unb64u = s => Buffer.from(String(s), "base64url").toString("utf8");

// Token di sessione firmato (stateless): "<label>.<scadenzaMs>.<hmac>".
export function signSession(label, expMs, secret) {
  const payload = `${b64u(label)}.${expMs}`;
  const sig = crypto.createHmac("sha256", String(secret)).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

// Verifica il token: firma valida e non scaduto. Ritorna {valid, label}.
export function verifySession(token, secret, now = Date.now()) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return { valid: false, label: null };
  const [labelB64, expStr, sig] = parts;
  const payload = `${labelB64}.${expStr}`;
  const expected = crypto.createHmac("sha256", String(secret)).update(payload).digest("base64url");
  const sa = Buffer.from(sig), sb = Buffer.from(expected);
  if (sa.length !== sb.length || !crypto.timingSafeEqual(sa, sb)) return { valid: false, label: null };
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < now) return { valid: false, label: null };
  let label = ""; try { label = unb64u(labelB64); } catch { return { valid: false, label: null }; }
  return { valid: true, label };
}

export function parseCookies(header) {
  const out = {};
  String(header || "").split(";").forEach(p => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

// IP del client dietro al proxy di Render (X-Forwarded-For) o diretto.
export function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "?";
}
