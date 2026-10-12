import "server-only";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

export function database() {
  if (!process.env.DATABASE_URL) throw new Error("Neon is not configured.");
  return drizzle(neon(process.env.DATABASE_URL), { schema });
}