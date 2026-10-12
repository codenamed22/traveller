import { auth, authConfigured } from "@/auth";
import { TripPlanner } from "@/components/TripPlanner";
import { newTrip } from "@/lib/trip";
import { and, desc, eq } from "drizzle-orm";
import { allowedEmail } from "@/auth";
import { database } from "@/db";
import { trips } from "@/db/schema";

export const dynamic = "force-dynamic";

export default async function Home() {
  const configured = authConfigured();
  const session = configured ? await auth() : null;
  const email = session?.user?.email;
  let latest = null;
  if (email && allowedEmail(email) && process.env.DATABASE_URL) {
    try {
      [latest] = await database().select({ data: trips.data, revision: trips.revision, plan: trips.plan, updatedAt: trips.updatedAt }).from(trips).where(and(eq(trips.owner, email.toLowerCase()))).orderBy(desc(trips.updatedAt)).limit(1);
    } catch { latest = null; }
  }
  return <TripPlanner initialTrip={newTrip()} initialSaved={latest ? JSON.parse(JSON.stringify(latest)) : null} config={{
    auth: configured, email: session?.user?.email ?? null,
    database: Boolean(process.env.DATABASE_URL),
    maps: Boolean(process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY),
    routes: Boolean(process.env.GOOGLE_MAPS_API_KEY),
    ai: Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY && process.env.GEMINI_MODEL),
  }} />;
}