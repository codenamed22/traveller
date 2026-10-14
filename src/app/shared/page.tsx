import Link from "next/link";
import { CalendarDays, Compass, Eye, MapPin } from "lucide-react";
import { auth, authConfigured, canEdit } from "@/auth";
import { SignInPrompt } from "@/components/SignInPrompt";
import { sharedTrips, type SharedSummary } from "@/lib/shared-trips";

export const dynamic = "force-dynamic";

export default async function SharedTrips() {
  const configured = authConfigured();
  const email = configured ? (await auth())?.user?.email : null;
  if (!email) return <SignInPrompt configured={configured} redirectTo="/shared" />;
  let list: SharedSummary[] = [];
  let failed = false;
  try { list = process.env.DATABASE_URL ? await sharedTrips() : []; } catch { failed = true; }
  return <main className="shared-page">
    <header className="shared-heading"><Link className="brand" href={canEdit(email) ? "/" : "/shared"}><span className="brand-mark"><Compass size={23} /></span>traveller<span className="brand-dot">.</span></Link>{canEdit(email) && <Link className="text-button" href="/">Back to planner</Link>}</header>
    <h1>Shared trips</h1>
    <p className="quiet"><Eye size={13} /> View only. Signed in as {email}.</p>
    {failed ? <p className="notice error" role="alert">Shared trips could not be loaded. Try again.</p>
      : !list.length ? <div className="empty-stops"><h2>Nothing shared yet</h2><p>When a trip is shared for viewing, it appears here.</p></div>
      : <ul className="shared-list">{list.map((trip) => <li key={trip.id}><Link href={`/shared/${trip.id}`}><strong>{trip.title}</strong><span><MapPin size={13} />{trip.cities.map((city) => city.city).join(", ")}</span><span><CalendarDays size={13} />{trip.cities[0]?.startDate ? `${trip.cities[0].startDate} to ${trip.cities.at(-1)!.endDate}` : "Dates not set"}</span></Link></li>)}</ul>}
  </main>;
}
