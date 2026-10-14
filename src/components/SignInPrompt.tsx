"use client";

import { signIn } from "next-auth/react";
import { Compass, UserRound } from "lucide-react";

// Shared trips are visible to any signed-in Google account; this asks a visitor to sign in and comes back to the same page.
export function SignInPrompt({ configured, redirectTo }: { configured: boolean; redirectTo: string }) {
  return <main className="shared-page"><div className="empty-stops">
    <span className="empty-icon"><Compass size={25} /></span>
    <h2>Sign in to view shared trips</h2>
    <p>{configured ? "Any Google account can view trips that have been shared for viewing." : "Google sign-in is not configured yet."}</p>
    {configured && <button className="button primary" onClick={() => void signIn("google", { redirectTo })}><UserRound size={16} />Sign in with Google</button>}
  </div></main>;
}
