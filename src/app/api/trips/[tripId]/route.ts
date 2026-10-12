import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { database } from "@/db";
import { trips } from "@/db/schema";
import { apiError, HttpError, readJson, requireOwner } from "@/lib/server";
import { tripSchema } from "@/lib/trip";
import { journeySchema, savedPlanSchema } from "@/lib/journey";

type Context = { params: Promise<{ tripId: string }> };
const saveSchema = z.union([z.object({
  trip: tripSchema,
  revision: z.number().int().min(0),
  plan: savedPlanSchema.nullable(),
}).strict(), z.object({ journey: journeySchema, revision: z.number().int().min(0) }).strict()]);

export async function PUT(request: Request, context: Context) {
  try {
    const owner = await requireOwner(request);
    const { tripId } = await context.params;
    const input = saveSchema.parse(await readJson(request, 3_500_000));
    const trip = "journey" in input ? input.journey : input.trip;
    const plan = "journey" in input ? null : input.plan;
    const revision = input.revision;
    if (trip.id !== tripId) throw new HttpError(400, "Trip identifiers do not match.");
    const db = database();
    const rows = revision === 0
      ? await db.insert(trips).values({ id: tripId, owner, data: trip, plan }).onConflictDoNothing().returning({ revision: trips.revision })
      : await db.update(trips).set({ data: trip, plan, revision: revision + 1, updatedAt: new Date() }).where(and(eq(trips.id, tripId), eq(trips.owner, owner), eq(trips.revision, revision))).returning({ revision: trips.revision });
    if (!rows.length) throw new HttpError(409, "This trip changed on another device. Reload it before saving.");
    return Response.json(rows[0]);
  } catch (error) { return apiError(error); }
}

export async function DELETE(request: Request, context: Context) {
  try {
    const owner = await requireOwner(request);
    const tripId = z.uuid().parse((await context.params).tripId);
    await database().delete(trips).where(and(eq(trips.id, tripId), eq(trips.owner, owner)));
    return new Response(null, { status: 204 });
  } catch (error) { return apiError(error); }
}