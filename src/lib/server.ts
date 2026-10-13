import "server-only";
import { z, ZodError } from "zod";
import { sql } from "drizzle-orm";
import { auth, allowedEmail, authConfigured } from "@/auth";
import { database } from "@/db";
import { operations, usage } from "@/db/schema";

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function requireOwner(request?: Request) {
  if (!authConfigured()) throw new HttpError(503, "Google sign-in is not configured yet.");
  const session = await auth();
  const email = session?.user?.email;
  if (!email || !allowedEmail(email)) throw new HttpError(401, "Sign in with an allowed account first.");
  if (request && request.method !== "GET") {
    const origin = request.headers.get("origin");
    if (!origin || origin !== new URL(request.url).origin) throw new HttpError(403, "Request origin is not allowed.");
  }
  return email.toLowerCase();
}

export async function readJson(request: Request, maxBytes = 3_500_000): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new HttpError(415, "Send JSON content.");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "A request body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new HttpError(413, "The request is too large."); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(400, "Invalid JSON."); }
}

export async function reserveUsage(owner: string, units: number, operationId?: string) {
  if (!process.env.DATABASE_URL) throw new HttpError(503, "Paid services are unavailable. Check your connections.");
  const db = database();
  if (operationId) {
    z.uuid().parse(operationId);
    const inserted = await db.insert(operations).values({ owner, id: operationId }).onConflictDoNothing().returning({ id: operations.id });
    if (!inserted.length) throw new HttpError(409, "This operation was already submitted. Start a new request to retry.");
  }
  const limit = z.coerce.number().int().min(1).max(10_000).parse(process.env.DAILY_USAGE_LIMIT ?? "200");
  const day = new Date().toISOString().slice(0, 10);
  if (units > limit) throw new HttpError(429, "The daily service limit has been reached.");
  const reserved = await db.insert(usage).values({ owner, day, units }).onConflictDoUpdate({
    target: [usage.owner, usage.day],
    set: { units: sql`${usage.units} + ${units}` },
    setWhere: sql`${usage.units} + ${units} <= ${limit}`,
  }).returning({ units: usage.units });
  if (!reserved.length) throw new HttpError(429, "The daily service limit has been reached. Try again tomorrow.");
}

export function apiError(error: unknown) {
  if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof ZodError) return Response.json({ error: error.issues[0]?.message ?? "Invalid input." }, { status: 400 });
  console.error("Traveller request failed", error instanceof Error ? error.name : "UnknownError");
  return Response.json({ error: "Could not complete the request. Try again." }, { status: 502 });
}