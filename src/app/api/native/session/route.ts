import { NextResponse } from "next/server";
import { decode, encode } from "next-auth/jwt";
import { authConfigured } from "@/auth";
import { challengeFor, HANDOFF_SALT, safeNext, sessionCookieName, usesSecureCookies, validVerifier } from "@/lib/native-auth";

const sessionSeconds = 30 * 24 * 60 * 60;

// The app's web view opens this page, so failures read as a page with a way back rather than JSON.
const failure = (status: number, message: string) => new Response(
  `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in</title><body style="font: 16px system-ui; padding: 24px"><p>${message}</p><p><a href="/">Back to Traveller</a></p>`,
  { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
);

// Trades the app's sign-in code and verifier for the usual Auth.js session cookie in the app's web view.
export async function POST(request: Request) {
  const secret = process.env.AUTH_SECRET;
  if (!secret || !authConfigured()) return failure(503, "Google sign-in is not configured yet.");
  const form = await request.formData().catch(() => null);
  const code = form?.get("code");
  const verifier = form?.get("verifier");
  if (typeof code !== "string" || typeof verifier !== "string" || code.length > 8000 || !validVerifier(verifier)) return failure(400, "Open sign-in from the app.");
  const handoff = await decode({ token: code, secret, salt: HANDOFF_SALT }).catch(() => null);
  if (!handoff?.email || handoff.challenge !== await challengeFor(verifier)) return failure(400, "This sign-in has expired. Sign in again.");
  const secure = usesSecureCookies(request.url);
  const name = sessionCookieName(secure);
  const value = await encode({ token: { sub: handoff.sub, email: handoff.email, name: handoff.name, picture: handoff.picture }, secret, salt: name, maxAge: sessionSeconds });
  const response = NextResponse.redirect(new URL(safeNext(typeof handoff.next === "string" ? handoff.next : "/"), request.url), 303);
  response.cookies.set(name, value, { httpOnly: true, sameSite: "lax", path: "/", secure, maxAge: sessionSeconds });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
