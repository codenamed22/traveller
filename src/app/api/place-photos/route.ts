import { getPlacePhoto } from "@/lib/google-maps";
import { placePhotoRequestSchema, placePhotoResponseSchema } from "@/lib/place-photos";
import { apiError, readJson, requireOwner, reserveUsage } from "@/lib/server";

export async function POST(request: Request) {
  try {
    const owner = await requireOwner(request);
    const input = placePhotoRequestSchema.parse(await readJson(request, 1500));
    await reserveUsage(owner, 2, input.operationId);
    const photo = placePhotoResponseSchema.parse(await getPlacePhoto(
      input.placeId,
      input.index,
      AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]),
    ));
    return Response.json(photo, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}