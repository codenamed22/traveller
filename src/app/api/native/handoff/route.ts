import { encode, getToken } from "next-auth/jwt";
import { authConfigured } from "@/auth";
import { APP_CALLBACK, HANDOFF_SALT, HANDOFF_SECONDS, safeNext, usesSecureCookies, validChallenge } from "@/lib/native-auth";

const toApp = (params: Record<string, string>) => new Response(null, { status: 302, headers: { Location: `${APP_CALLBACK}?${new URLSearchParams(params)}`, "Cache-Control": "no-store" } });

// After Google sign-in in the system sheet: hands the app a code that only works with the app's own verifier.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const challenge = url.searchParams.get("challenge") ?? "";
  const secret = process.env.AUTH_SECRET;
  if (!validChallenge(challenge) || !secret || !authConfigured()) return toApp({ error: "Sign-in isn't available right now." });
  const token = await getToken({ req: request, secret, secureCookie: usesSecureCookies(request.url) });
  if (!token?.email) return toApp({ error: "Sign-in didn't finish. Try again." });
  const code = await encode({
    token: { sub: token.sub, email: token.email, name: token.name, picture: token.picture, challenge, next: safeNext(url.searchParams.get("next")) },
    secret, salt: HANDOFF_SALT, maxAge: HANDOFF_SECONDS,
  });
  return toApp({ code });
}
