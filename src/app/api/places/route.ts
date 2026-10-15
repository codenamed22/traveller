import { z } from "zod";
import { placeDetails, searchPlaces } from "@/lib/google-maps";
import { apiError, requireOwner, reserveUsage, readJson } from "@/lib/server";

export async function POST(request: Request) {
  try {
    const owner = await requireOwner(request);
    const input = z.union([z.object({ query: z.string().trim().min(2).max(350), near: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).strict().optional() }).strict(), z.object({ placeId: z.string().min(1).max(300) }).strict()]).parse(await readJson(request, 2000));
    await reserveUsage(owner, 1);
    const result = "query" in input ? { places: await searchPlaces(input.query, input.near) } : { place: await placeDetails(input.placeId) };
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}