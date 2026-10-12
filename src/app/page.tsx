import { auth, authConfigured } from "@/auth";
import { TripPlanner } from "@/components/TripPlanner";
import { newTrip } from "@/lib/trip";

export const dynamic = "force-dynamic";

export default async function Home() {
  const configured = authConfigured();
  const session = configured ? await auth() : null;
  return <TripPlanner initialTrip={newTrip()} config={{
    auth: configured, email: session?.user?.email ?? null,
    database: Boolean(process.env.DATABASE_URL),
    maps: Boolean(process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY),
    routes: Boolean(process.env.GOOGLE_MAPS_API_KEY),
    ai: Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY && process.env.GEMINI_MODEL),
  }} />;
}