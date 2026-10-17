import { createHash, randomUUID } from "node:crypto";
import { and, asc, count, eq, sum } from "drizzle-orm";
import { z } from "zod";
import { database } from "@/db";
import { tickets, trips } from "@/db/schema";
import { asJourney } from "@/lib/journey";
import { apiError, HttpError, requireOwner } from "@/lib/server";
import { ticketColumns } from "@/lib/ticket-store";
import { maxTicketBytes, maxTicketBytesPerOwner, maxTicketsPerTrip, sniffTicket, ticketName, ticketPlaceSchema } from "@/lib/tickets";

type Context = { params: Promise<{ tripId: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const owner = await requireOwner();
    const tripId = z.uuid().parse((await context.params).tripId);
    const rows = await database().select(ticketColumns).from(tickets).where(and(eq(tickets.owner, owner), eq(tickets.tripId, tripId))).orderBy(asc(tickets.createdAt));
    return Response.json({ tickets: rows }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return apiError(error); }
}

// One file as multipart form data, with the city and the visit or arrival or departure it belongs to.
export async function POST(request: Request, context: Context) {
  try {
    const owner = await requireOwner(request);
    const tripId = z.uuid().parse((await context.params).tripId);
    // Refused before reading, as the platform caps request bodies at 4.5 MB.
    if (Number(request.headers.get("content-length")) > maxTicketBytes + 200_000) throw new HttpError(413, "Tickets can be up to 4 MB.");
    const form = await request.formData().catch(() => { throw new HttpError(400, "Send the ticket as a file."); });
    const file = form.get("file");
    if (!(file instanceof File)) throw new HttpError(400, "Send the ticket as a file.");
    const place = ticketPlaceSchema.parse({ cityId: form.get("cityId"), target: form.get("target"), stopId: form.get("stopId") || null });
    if (file.size > maxTicketBytes) throw new HttpError(413, "Tickets can be up to 4 MB.");
    const data = Buffer.from(await file.arrayBuffer());
    const mime = sniffTicket(data);
    if (!mime) throw new HttpError(415, "Add a PDF, JPEG or PNG.");
    const db = database();
    const [trip] = await db.select({ data: trips.data, plan: trips.plan }).from(trips).where(and(eq(trips.id, tripId), eq(trips.owner, owner))).limit(1);
    if (!trip) throw new HttpError(404, "Save the trip before adding tickets.");
    const city = asJourney(trip.data, trip.plan).cities.find((candidate) => candidate.id === place.cityId);
    if (!city || (place.stopId && !city.stops.some((stop) => stop.id === place.stopId))) throw new HttpError(400, "Save the trip before adding tickets.");
    const [[forTrip], [forOwner]] = await Promise.all([
      db.select({ count: count() }).from(tickets).where(and(eq(tickets.owner, owner), eq(tickets.tripId, tripId))),
      db.select({ bytes: sum(tickets.size) }).from(tickets).where(eq(tickets.owner, owner)),
    ]);
    if (forTrip.count >= maxTicketsPerTrip) throw new HttpError(409, `A trip can have up to ${maxTicketsPerTrip} tickets.`);
    if (Number(forOwner.bytes ?? 0) + data.byteLength > maxTicketBytesPerOwner) throw new HttpError(409, "Ticket storage is full. Delete tickets from past trips first.");
    const ticket = {
      id: randomUUID(), tripId, ...place, name: ticketName(file.name, mime), mime, size: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
    await db.insert(tickets).values({ ...ticket, owner, data });
    return Response.json({ ticket }, { status: 201 });
  } catch (error) { return apiError(error); }
}
