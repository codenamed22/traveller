import { z } from "zod";
import { planWithGoogle } from "@/lib/google-maps";
import { tripSchema } from "@/lib/trip";
import { apiError, requireOwner, reserveUsage, readJson } from "@/lib/server";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    const owner = await requireOwner(request);
    const { trip, operationId } = z.object({ trip: tripSchema, operationId: z.uuid() }).strict().parse(await readJson(request, 100_000));
    await reserveUsage(owner, 30, operationId);
    return Response.json(await planWithGoogle(trip), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}