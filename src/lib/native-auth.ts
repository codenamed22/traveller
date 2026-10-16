// Sign-in for the iPhone app. Google blocks sign-in inside the app's web view, so the app signs in through the system
// sign-in sheet, which comes back with a short-lived code. The app trades the code, with a secret only it knows, for
// the usual session cookie in its web view.
export const APP_CALLBACK = "traveller://signed-in";
export const HANDOFF_SALT = "traveller-native-handoff";
export const HANDOFF_SECONDS = 120;

const base64url = /^[A-Za-z0-9_-]+$/;
// A SHA-256 digest in base64url, and the app's random verifier (43–128 characters, as in OAuth PKCE).
export const validChallenge = (value: string) => value.length === 43 && base64url.test(value);
export const validVerifier = (value: string) => value.length >= 43 && value.length <= 128 && base64url.test(value);

export async function challengeFor(verifier: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return Buffer.from(digest).toString("base64url");
}

// Where to land after signing in: a path on this site, never another site.
export function safeNext(next: string | null | undefined) {
  if (!next || next.length > 500 || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  const url = new URL(next, "http://traveller.invalid");
  return url.origin === "http://traveller.invalid" ? `${url.pathname}${url.search}${url.hash}` : "/";
}

// Auth.js names its session cookie by whether the site runs on HTTPS, judged from AUTH_URL when it is set.
export function usesSecureCookies(requestUrl: string) {
  try { return new URL(process.env.AUTH_URL || requestUrl).protocol === "https:"; } catch { return new URL(requestUrl).protocol === "https:"; }
}
export const sessionCookieName = (secure: boolean) => `${secure ? "__Secure-" : ""}authjs.session-token`;
