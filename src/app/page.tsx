import { redirect } from "next/navigation";
import { auth, authConfigured, canEdit } from "@/auth";
import { TripPlanner } from "@/components/TripPlanner";
import { newTrip } from "@/lib/trip";
import { desc, eq } from "drizzle-orm";
import { database } from "@/db";
import { trips } from "@/db/schema";
import { assistantService, extractionServices } from "@/lib/import-providers";

export const dynamic = "force-dynamic";

export default async function Home() {
  const configured = authConfigured();
  const session = configured ? await auth() : null;
  const email = session?.user?.email;
  // Accounts that can only view go straight to the trips shared with everyone.
  if (email && !canEdit(email)) redirect("/shared");
  let saved: { data: unknown; revision: number; plan: unknown; shared: boolean; updatedAt: Date }[] = [];
  if (email && process.env.DATABASE_URL) {
    try {
      saved = await database().select({ data: trips.data, revision: trips.revision, plan: trips.plan, shared: trips.shared, updatedAt: trips.updatedAt }).from(trips).where(eq(trips.owner, email.toLowerCase())).orderBy(desc(trips.updatedAt)).limit(100);
    } catch { saved = []; }
  }
  const plain = JSON.parse(JSON.stringify(saved));
  const extraction = extractionServices();
  const assistant = assistantService();
  return <TripPlanner initialTrip={newTrip()} initialSaved={plain.length === 1 ? plain[0] : null} initialList={plain.length > 1 ? plain : null} config={{
    auth: configured, email: session?.user?.email ?? null,
    database: Boolean(process.env.DATABASE_URL),
    maps: Boolean(process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY),
    routes: Boolean(process.env.GOOGLE_MAPS_API_KEY),
    ai: Boolean(extraction.standard), extraction,
    timing: Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY),
    assistant: assistant ? { model: assistant.model } : null,
  }} />;
}