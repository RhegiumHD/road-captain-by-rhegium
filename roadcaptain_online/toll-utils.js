export function googleMoneyToNumber(money) {
  if (!money || typeof money !== "object") return null;
  const units = Number(money.units || 0);
  const nanos = Number(money.nanos || 0);
  const value = units + nanos / 1_000_000_000;
  return Number.isFinite(value) ? value : null;
}

export function extractGoogleTollInfo(tollInfo) {
  if (!tollInfo || typeof tollInfo !== "object") {
    return {available:false, amount:null, currency:null, source:"Google Routes", note:"Nessun pedaggio indicato da Google Routes"};
  }
  const prices = Array.isArray(tollInfo.estimatedPrice) ? tollInfo.estimatedPrice : [];
  const eur = prices.find(p => (p.currencyCode || "").toUpperCase() === "EUR") || prices[0];
  const amount = googleMoneyToNumber(eur);
  if (amount !== null) {
    return {
      available:true,
      amount:Number(amount.toFixed(2)),
      currency:(eur.currencyCode || "EUR").toUpperCase(),
      source:"Google Routes tollInfo.estimatedPrice",
      note:"Stima pedaggio calcolata da Google Routes"
    };
  }
  return {
    available:true,
    amount:null,
    currency:null,
    source:"Google Routes tollInfo",
    note:"Pedaggio rilevato, importo non restituito dalla fonte"
  };
}

export function roundToTenCents(value) {
  return Math.round(Number(value) * 10) / 10;
}

export function estimateAspitollClassA(distanceKm, ratePerKm = 0.08592) {
  const km = Number(distanceKm);
  if (!Number.isFinite(km) || km <= 0) return null;
  return Number(roundToTenCents(km * ratePerKm).toFixed(2));
}
