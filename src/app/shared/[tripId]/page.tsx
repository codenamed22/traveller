import { notFound } from "next/navigation";
import { z } from "zod";
import { auth, authConfigured } from "@/auth";
import { SignInPrompt } from "@/components/SignInPrompt";
import { TripViewer } from "@/components/TripViewer";
import { sharedTrip } from "@/lib/shared-trips";

export const dynamic = "force-dynamic";

export default async function SharedTrip({ params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = await params;
  if (!z.uuid().safeParse(tripId).success) notFound();
  const configured = authConfigured();
  const email = configured ? (await auth())?.user?.email?.toLowerCase() : null;
  if (!email) return <SignInPrompt configured={configured} redirectTo={`/shared/${tripId}`} />;
  if (!process.env.DATABASE_URL) notFound();
  const view = await sharedTrip(tripId, email);
  if (!view) notFound();
  return <TripViewer view={JSON.parse(JSON.stringify(view))} email={email} />;
}
