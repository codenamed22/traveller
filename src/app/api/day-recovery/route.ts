import { recoveryInputErrors, recoveryLocationErrors, recoveryRequestSchema } from "@/lib/day-recovery";
import { recoverDayWithGoogle } from "@/lib/google-maps";
import { apiError, HttpError, readJson, requireOwner, reserveUsage } from "@/lib/server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const owner = await requireOwner(request);
    const input = recoveryRequestSchema.parse(await readJson(request, 3_500_000));
    const errors = [...recoveryInputErrors(input), ...recoveryLocationErrors(input)];
    if (errors.length) throw new HttpError(422, errors.join(" "));
    await reserveUsage(owner, input.mode === "route" ? 3 : 30, input.operationId);
    return Response.json(await recoverDayWithGoogle(input, request.signal), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = apiError(error);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}