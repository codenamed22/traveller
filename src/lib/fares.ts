import { z } from "zod";

// What the site asks Google about: the rides of a card paid in money (faresToCheck), each with the lines the plan takes.
const point = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).strict();
export const fareRequestSchema = z.object({
  preference: z.enum(["LESS_WALKING", "FEWER_TRANSFERS"]).optional(),
  legs: z.array(z.object({ key: z.string().max(120), lines: z.string().max(300), origin: point, destination: point, departure: z.iso.datetime() }).strict()).min(1).max(40),
}).strict();
export type FareRequest = z.infer<typeof fareRequestSchema>;
export type FoundFare = { amount?: number; currency?: string };

export const fareRoutesResponse = z.object({ routes: z.array(z.object({
  travelAdvisory: z.object({ transitFare: z.object({ currencyCode: z.string().optional(), units: z.string().optional(), nanos: z.number().optional() }).optional() }).optional(),
  legs: z.array(z.object({ steps: z.array(z.object({
    transitDetails: z.object({ transitLine: z.object({ nameShort: z.string().optional(), name: z.string().optional() }).optional() }).optional(),
  })).default([]) })).default([]),
})).default([]) });
type FareRoute = z.infer<typeof fareRoutesResponse>["routes"][number];

function fareOf(route: FareRoute): FoundFare | null {
  const fare = route.travelAdvisory?.transitFare;
  if (!fare?.currencyCode || (fare.units === undefined && fare.nanos === undefined)) return null;
  return { amount: Math.round((Number(fare.units ?? 0) + (fare.nanos ?? 0) / 1e9) * 100) / 100, currency: fare.currencyCode };
}

// Google's fare for the way the plan goes: the route on the same lines, or else the one fare every route by public
// transport agrees on. Nothing when Google has no fare for it, or the routes disagree.
export function pickFare(routes: FareRoute[], lines: string): FoundFare {
  const priced = routes.map((route) => ({
    lines: route.legs.flatMap((leg) => leg.steps.flatMap((step) => { const line = step.transitDetails?.transitLine; const name = line?.nameShort ?? line?.name; return name ? [name] : []; })).join("+"),
    fare: fareOf(route),
  }));
  const same = lines ? priced.find((route) => route.lines === lines) : undefined;
  if (same) return same.fare ?? {};
  const transit = priced.filter((route) => route.lines);
  const first = transit[0]?.fare;
  return first && transit.every((route) => route.fare?.amount === first.amount && route.fare?.currency === first.currency) ? first : {};
}
