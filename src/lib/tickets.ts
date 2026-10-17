import { z } from "zod";

// Tickets and booking documents kept with a saved trip, for a visit or for arriving in or leaving a city. Only the
// trip's owner sees them; shared views never do.
export const maxTicketBytes = 4_000_000;
export const maxTicketsPerTrip = 30;
// All of one account's tickets, so the database keeps room for trips.
export const maxTicketBytesPerOwner = 150_000_000;
export const ticketTypes = ["application/pdf", "image/jpeg", "image/png"] as const;
export type TicketType = (typeof ticketTypes)[number];

export const ticketTargetSchema = z.enum(["stop", "arrival", "departure"]);
export const ticketPlaceSchema = z.object({
  cityId: z.uuid(),
  target: ticketTargetSchema,
  stopId: z.uuid().nullable(),
}).strict().refine((place) => (place.target === "stop") === (place.stopId !== null), "A visit's ticket needs its visit.");
export type TicketPlace = z.infer<typeof ticketPlaceSchema>;

export const ticketSchema = z.object({
  id: z.uuid(), tripId: z.uuid(), cityId: z.uuid(), target: ticketTargetSchema, stopId: z.uuid().nullable(),
  name: z.string(), mime: z.enum(ticketTypes), size: z.number().int(), sha256: z.string(),
});
export type Ticket = z.infer<typeof ticketSchema>;

// What the file is, from its first bytes rather than its name or the browser's word for it.
export function sniffTicket(bytes: Uint8Array): TicketType | null {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return "application/pdf";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  return null;
}

// A file name safe to show and to send back in a header.
export function ticketName(name: string, mime: TicketType) {
  const clean = name.normalize("NFC").replace(/[\u0000-\u001f\u007f"\\/]/g, "").trim().slice(0, 120);
  return clean || `Ticket.${mime === "application/pdf" ? "pdf" : mime === "image/png" ? "png" : "jpg"}`;
}

export function ticketsFor(tickets: Ticket[], place: TicketPlace) {
  return tickets.filter((ticket) => ticket.cityId === place.cityId && ticket.target === place.target && ticket.stopId === place.stopId);
}
