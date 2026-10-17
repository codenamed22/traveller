import { Temporal } from "@js-temporal/polyfill";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { database } from "@/db";
import { trips } from "@/db/schema";
import { asJourney, journeySchema, type StoredTrip } from "@/lib/journey";
import { applyNativeAction, nativeActionSchema, withProgress } from "@/lib/native-actions";
import { apiError, HttpError, readJson, requireOwner } from "@/lib/server";
import type { SavedPlan } from "@/lib/trip";

type Context = { params: Promise<{ tripId: string }> };
const bodySchema = z.object({ actions: z.array(nativeActionSchema).min(1).max(50) }).strict();

// Done, Skip and taking them back, saved on the iPhone without a connection and sent once it has one, for a trip the
// page isn't holding. Applied in order on the saved trip; each says whether it was kept, so the app can stop sending it.
export async function POST(request: Request, context: Context) {
  try {
    const owner = await requireOwner(request);
    const tripId = z.uuid().parse((await context.params).tripId);
    const { actions } = bodySchema.parse(await readJson(request, 50_000));
    const db = database();
    // Saved only if nothing else saved the trip meanwhile; then once more on the newer copy.
    for (let attempt = 0; attempt < 2; attempt++) {
      const [row] = await db.select({ data: trips.data, plan: trips.plan, revision: trips.revision }).from(trips).where(and(eq(trips.id, tripId), eq(trips.owner, owner))).limit(1);
      if (!row) throw new HttpError(404, "That trip isn't saved.");
      let journey = journeySchema.parse(asJourney(row.data as StoredTrip, row.plan as SavedPlan | null));
      const now = Temporal.Now.instant();
      let changed = false;
      const results = actions.map((action) => {
        try {
          const change = applyNativeAction(journey, action, now);
          if (change.changed) { journey = withProgress(journey, change.cityId, change.date, change.next); changed = true; }
          return { ok: true, message: change.message };
        } catch (error) { return { ok: false, message: error instanceof Error ? error.message : "That couldn't be saved." }; }
      });
      if (!changed) return Response.json({ revision: row.revision, results });
      const saved = await db.update(trips).set({ data: journeySchema.parse(journey), plan: null, revision: row.revision + 1, updatedAt: new Date() })
        .where(and(eq(trips.id, tripId), eq(trips.owner, owner), eq(trips.revision, row.revision))).returning({ revision: trips.revision });
      if (saved.length) return Response.json({ revision: saved[0].revision, results });
    }
    throw new HttpError(409, "This trip changed on another device. Try again.");
  } catch (error) { return apiError(error); }
}
