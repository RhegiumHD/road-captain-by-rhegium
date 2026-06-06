import { extractGoogleTollInfo, roundToTenCents, estimateAspitollClassA } from "../toll-utils.js";

const parsed = extractGoogleTollInfo({estimatedPrice:[{currencyCode:"EUR", units:"12", nanos:300000000}]});
if (!parsed.available || parsed.amount !== 12.3 || parsed.currency !== "EUR") throw new Error("google toll price parse failed");

const presentUnknown = extractGoogleTollInfo({});
if (!presentUnknown.available || presentUnknown.amount !== null) throw new Error("unknown toll state failed");

if (roundToTenCents(1.16) !== 1.2) throw new Error("round toll failed");
if (estimateAspitollClassA(100, 0.07869) !== 7.9) throw new Error("aspi class A estimate failed");
console.log("toll ok");
