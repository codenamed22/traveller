import "server-only";
import { and, desc, eq, or } from "drizzle-orm";
import { database } from "@/db";
import { trips } from "@/db/schema";
import { asJourney, type Journey } from "@/lib/journey";
import { tripDate } from "@/lib/trip";

// What a viewer receives: the cities and accepted plans only. Day progress and the owner's email stay on the server.
export type SharedView = Pick<Journey, "id" | "title" | "cities" | "plans"> & { updatedAt: string; isOwner: boolean };
export type SharedSummary = { id: string; title: string; cities: { city: string; startDate: string; endDate: string }[]; updatedAt: string };

// A trip shared for viewing, or the viewer's own trip so an owner can preview what others see.
export async function sharedTrip(tripId: string, email: string): Promise<SharedView | null> {
  const [row] = await database().select({ data: trips.data, plan: trips.plan, owner: trips.owner, updatedAt: trips.updatedAt }).from(trips)
    .where(and(eq(trips.id, tripId), or(eq(trips.shared, true), eq(trips.owner, email)))).limit(1);
  if (!row) return null;
  const { id, title, cities, plans } = asJourney(row.data, row.plan);
  return { id, title, cities, plans, updatedAt: new Date(row.updatedAt).toISOString(), isOwner: row.owner === email };
}

export async function sharedTrips(): Promise<SharedSummary[]> {
  const rows = await database().select({ data: trips.data, plan: trips.plan, updatedAt: trips.updatedAt }).from(trips)
    .where(eq(trips.shared, true)).orderBy(desc(trips.updatedAt)).limit(100);
  return rows.map((row) => {
    const journey = asJourney(row.data, row.plan);
    return { id: journey.id, title: journey.title, updatedAt: new Date(row.updatedAt).toISOString(), cities: journey.cities.map((city) => ({ city: city.city, startDate: city.startDate, endDate: city.startDate ? tripDate(city, city.days - 1) : "" })) };
  });
}
