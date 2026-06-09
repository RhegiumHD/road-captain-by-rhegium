import { parseMimitFuelPriceCsv } from "../server.js";

const csv = `idImpianto|descCarburante|prezzo|isSelf|dtComu
1|Benzina|1.900|1|14/05/2026 08:00:00
2|Benzina|1.800|1|14/05/2026 08:00:00
3|Benzina|2.400|0|14/05/2026 08:00:00
4|Gasolio|1.700|1|14/05/2026 08:00:00
5|Diesel|1.600|1|14/05/2026 08:00:00
6|Blue Diesel|2.100|1|14/05/2026 08:00:00
7|GPL|0.720|1|14/05/2026 08:00:00`;

const benzina = parseMimitFuelPriceCsv(csv, "benzina");
if (benzina.price !== 1.85 || benzina.samples !== 2) throw new Error("MIMIT benzina parsing failed");
const diesel = parseMimitFuelPriceCsv(csv, "diesel");
if (diesel.price !== 1.65 || diesel.samples !== 2) throw new Error("MIMIT diesel parsing failed");
const gpl = parseMimitFuelPriceCsv(csv, "gpl");
if (gpl.price !== 0.72 || gpl.samples !== 1) throw new Error("MIMIT gpl parsing failed");
