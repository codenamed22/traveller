import { authConfigured, signIn } from "@/auth";
import { safeNext, validChallenge } from "@/lib/native-auth";

// The iPhone app opens this in the system sign-in sheet. Google sign-in runs there, then the handoff returns to the app.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const challenge = url.searchParams.get("challenge") ?? "";
  if (!validChallenge(challenge)) return Response.json({ error: "Open sign-in from the app." }, { status: 400 });
  if (!authConfigured()) return Response.json({ error: "Google sign-in is not configured yet." }, { status: 503 });
  const next = safeNext(url.searchParams.get("next"));
  // Asking for the account each time lets the app switch accounts after signing out.
  await signIn("google", { redirectTo: `/api/native/handoff?${new URLSearchParams({ challenge, next })}` }, { prompt: "select_account" });
}
