import { desc, eq } from "drizzle-orm";
import { database } from "@/db";
import { trips } from "@/db/schema";
import { apiError, requireOwner } from "@/lib/server";

export async function GET() {
  try {
    const owner = await requireOwner();
    const rows = await database().select({ data: trips.data, revision: trips.revision, plan: trips.plan, shared: trips.shared, updatedAt: trips.updatedAt }).from(trips).where(eq(trips.owner, owner)).orderBy(desc(trips.updatedAt)).limit(100);
    return Response.json({ trips: rows }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return apiError(error); }
}