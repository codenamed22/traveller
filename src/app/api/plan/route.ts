import { z } from "zod";
import { checkBookingTravel, planWithGoogle, refreshSavedPlanWithGoogle, savedPlanRefreshErrors, type PlanningStage } from "@/lib/google-maps";
import { bookingConflicts, planningFailureCodeSchema, planningFixSchema, planningTrip, provisionalPlanSchema, savedPlanSchema, tripSchema } from "@/lib/trip";
import { apiError, HttpError, requireOwner, reserveUsage, readJson } from "@/lib/server";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  const diagnostics: PlanningStage[] = [];
  try {
    const owner = await requireOwner(request);
    const { trip: input, operationId, mode, plan } = z.object({ trip: tripSchema, operationId: z.uuid(), mode: z.enum(["check", "plan", "refresh"]).default("plan"), plan: savedPlanSchema.optional() }).strict()
      .refine((input) => (input.mode === "refresh") === Boolean(input.plan), "Only itinerary refresh requires a saved plan.").parse(await readJson(request, 3_500_000));
    // Places kept for spare time are never planned.
    const trip = planningTrip(input);
    if (mode === "check") {
      const booked = trip.stops.filter((stop) => stop.fixedTime);
      if (booked.length && (!trip.hotelPlaceId || booked.some((stop) => !stop.placeId))) throw new HttpError(400, "Confirm the hotel and fixed bookings on the map before checking travel gaps.");
      if (booked.length) await reserveUsage(owner, 3, operationId);
      return Response.json(await checkBookingTravel(trip), { headers: { "Cache-Control": "no-store" } });
    }
    const conflicts = bookingConflicts(trip);
    if (conflicts.length) throw Object.assign(new HttpError(422, conflicts.join(" ")), { code: "hard-input-conflict" });
    if (mode === "refresh") {
      const errors = savedPlanRefreshErrors(trip, plan!);
      if (errors.length) throw Object.assign(new HttpError(422, errors.join(" ")), { code: "hard-input-conflict" });
      const legs = plan!.days.reduce((total, day) => total + day.stopIds.length + Number(trip.returnToHotel && day.stopIds.length > 0), 0);
      await reserveUsage(owner, Math.max(3, Math.ceil(legs / 10) * 3), operationId);
      return Response.json(await refreshSavedPlanWithGoogle(trip, plan!, request.signal), { headers: { "Cache-Control": "no-store" } });
    }
    await reserveUsage(owner, 30, operationId);
    const result = await planWithGoogle(trip, { onStage: (stage) => diagnostics.push(stage), signal: request.signal });
    return Response.json({ ...result, diagnostics }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof HttpError && "provisional" in error) {
      const provisional = provisionalPlanSchema.safeParse(error.provisional);
      if (provisional.success) return Response.json({ ...provisional.data, diagnostics }, { headers: { "Cache-Control": "no-store" } });
    }
    const response = apiError(error);
    const code = error instanceof z.ZodError ? planningFailureCodeSchema.safeParse("hard-input-conflict") : error instanceof HttpError && "code" in error ? planningFailureCodeSchema.safeParse(error.code) : undefined;
    const fixes = error instanceof HttpError && "fixes" in error ? planningFixSchema.array().safeParse(error.fixes) : undefined;
    const suggested = fixes?.success && fixes.data.length ? fixes.data : undefined;
    return diagnostics.length || code?.success || suggested ? Response.json({ ...await response.json(), ...(code?.success ? { code: code.data } : {}), ...(suggested ? { fixes: suggested } : {}), ...(diagnostics.length ? { diagnostics } : {}) }, { status: response.status, headers: { "Cache-Control": "no-store" } }) : response;
  }
}