import { integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { SavedPlan } from "@/lib/trip";
import type { StoredTrip } from "@/lib/journey";

export const trips = pgTable("trips", {
  id: uuid("id").primaryKey(),
  owner: text("owner").notNull(),
  data: jsonb("data").$type<StoredTrip>().notNull(),
  plan: jsonb("plan").$type<SavedPlan>(),
  revision: integer("revision").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const usage = pgTable("usage", {
  owner: text("owner").notNull(),
  day: text("day").notNull(),
  units: integer("units").notNull().default(0),
}, (table) => [primaryKey({ columns: [table.owner, table.day] })]);

export const operations = pgTable("operations", {
  id: uuid("id").notNull(),
  owner: text("owner").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.owner, table.id] })]);