import { fareRequestSchema } from "@/lib/fares";
import { transitFares } from "@/lib/google-maps";
import { apiError, readJson, requireOwner, reserveUsage } from "@/lib/server";

export const runtime = "nodejs";
export const maxDuration = 60;

// Google's fares for the rides a transport card counts, which the page keeps on the trip.
export async function POST(request: Request) {
  try {
    const owner = await requireOwner(request);
    const input = fareRequestSchema.parse(await readJson(request, 100_000));
    await reserveUsage(owner, Math.ceil(input.legs.length / 5));
    return Response.json({ fares: await transitFares(input, request.signal) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = apiError(error);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
