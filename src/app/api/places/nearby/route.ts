import { nearbyMeals } from "@/lib/google-maps";
import { nearbyRequestSchema } from "@/lib/nearby";
import { apiError, readJson, requireOwner, reserveUsage } from "@/lib/server";

export const runtime = "nodejs";
export const maxDuration = 30;

// Places to eat where a day's plan leaves out a meal; shown to choose from and not kept.
export async function POST(request: Request) {
  try {
    const owner = await requireOwner(request);
    const input = nearbyRequestSchema.parse(await readJson(request, 2000));
    await reserveUsage(owner, 1);
    return Response.json({ places: await nearbyMeals(input, request.signal) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = apiError(error);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
