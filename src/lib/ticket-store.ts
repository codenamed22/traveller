import "server-only";
import { tickets } from "@/db/schema";

// A ticket without its file.
export const ticketColumns = {
  id: tickets.id, tripId: tickets.tripId, cityId: tickets.cityId, target: tickets.target, stopId: tickets.stopId,
  name: tickets.name, mime: tickets.mime, size: tickets.size, sha256: tickets.sha256,
};
