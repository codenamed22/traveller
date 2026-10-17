import { desc, eq } from "drizzle-orm";
import { database } from "@/db";
import { tickets, trips } from "@/db/schema";
import { apiError, requireOwner } from "@/lib/server";
import { ticketColumns } from "@/lib/ticket-store";

export async function GET() {
  try {
    const owner = await requireOwner();
    const db = database();
    // Tickets without their files, for the iPhone app to fetch and keep.
    const [rows, ticketRows] = await Promise.all([
      db.select({ data: trips.data, revision: trips.revision, plan: trips.plan, shared: trips.shared, updatedAt: trips.updatedAt }).from(trips).where(eq(trips.owner, owner)).orderBy(desc(trips.updatedAt)).limit(100),
      db.select(ticketColumns).from(tickets).where(eq(tickets.owner, owner)),
    ]);
    return Response.json({ trips: rows, tickets: ticketRows }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return apiError(error); }
}