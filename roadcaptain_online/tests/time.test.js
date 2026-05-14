import { parseRomeDateTime, fmtRome, addMinutes } from "../time-utils.js";

const summer = parseRomeDateTime("2026-05-15", "20:00");
if (!fmtRome(summer).includes("20:00")) throw new Error("summer Rome time parsing failed");

const winter = parseRomeDateTime("2026-01-15", "20:00");
if (!fmtRome(winter).includes("20:00")) throw new Error("winter Rome time parsing failed");

const arrival = parseRomeDateTime("2026-05-15", "20:00");
const departure = addMinutes(arrival, -120);
if (!fmtRome(departure).includes("18:00")) throw new Error("arrival mode back calculation failed");

console.log("time ok");
