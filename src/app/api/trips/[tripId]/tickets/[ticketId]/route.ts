import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { database } from "@/db";
import { tickets } from "@/db/schema";
import { apiError, HttpError, requireOwner } from "@/lib/server";

type Context = { params: Promise<{ tripId: string; ticketId: string }> };

async function ids(context: Context) {
  const { tripId, ticketId } = await context.params;
  return { tripId: z.uuid().parse(tripId), ticketId: z.uuid().parse(ticketId) };
}

// The file itself, shown in the browser. A ticket never changes, so its checksum is its version.
export async function GET(request: Request, context: Context) {
  try {
    const owner = await requireOwner();
    const { tripId, ticketId } = await ids(context);
    const [ticket] = await database().select({ name: tickets.name, mime: tickets.mime, sha256: tickets.sha256, data: tickets.data }).from(tickets)
      .where(and(eq(tickets.id, ticketId), eq(tickets.tripId, tripId), eq(tickets.owner, owner))).limit(1);
    if (!ticket) throw new HttpError(404, "That ticket isn't saved.");
    const headers = {
      "Cache-Control": "private, max-age=86400", ETag: `"${ticket.sha256}"`, "X-Content-Type-Options": "nosniff",
      "Content-Type": ticket.mime, "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(ticket.name)}`,
    };
    if (request.headers.get("if-none-match") === headers.ETag) return new Response(null, { status: 304, headers });
    return new Response(new Uint8Array(ticket.data), { headers });
  } catch (error) { return apiError(error); }
}

export async function DELETE(request: Request, context: Context) {
  try {
    const owner = await requireOwner(request);
    const { tripId, ticketId } = await ids(context);
    const rows = await database().delete(tickets).where(and(eq(tickets.id, ticketId), eq(tickets.tripId, tripId), eq(tickets.owner, owner))).returning({ id: tickets.id });
    if (!rows.length) throw new HttpError(404, "That ticket isn't saved.");
    return new Response(null, { status: 204 });
  } catch (error) { return apiError(error); }
}
