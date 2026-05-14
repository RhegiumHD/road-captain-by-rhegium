const ROME_TZ = "Europe/Rome";

function romeOffsetMinutes(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: ROME_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).reduce((acc, p) => {
    if (p.type !== "literal") acc[p.type] = p.value;
    return acc;
  }, {});
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)
  );
  return (asUtc - date.getTime()) / 60000;
}

export function parseRomeDateTime(dateStr, timeStr) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  const [hh, mm] = String(timeStr).split(":").map(Number);
  if (![y, m, d, hh, mm].every(Number.isFinite)) throw new Error("Data o ora non valida.");

  const provisionalUtc = new Date(Date.UTC(y, m - 1, d, hh, mm, 0));
  const offset = romeOffsetMinutes(provisionalUtc);
  const corrected = new Date(provisionalUtc.getTime() - offset * 60000);

  // Second pass: handles the offset boundary around DST changes.
  const offset2 = romeOffsetMinutes(corrected);
  return new Date(provisionalUtc.getTime() - offset2 * 60000);
}

export function addMinutes(date, min) {
  return new Date(date.getTime() + Number(min) * 60000);
}

export function fmtRome(date) {
  return date.toLocaleString("it-IT", {
    timeZone: ROME_TZ,
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
}
