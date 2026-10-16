import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decode, encode } from "next-auth/jwt";
import { challengeFor, HANDOFF_SALT, safeNext, sessionCookieName, usesSecureCookies, validChallenge } from "@/lib/native-auth";
import { GET as startSignIn } from "./sign-in/route";
import { GET as handoff } from "./handoff/route";
import { POST as exchange } from "./session/route";

const mocks = vi.hoisted(() => ({ signIn: vi.fn(), authConfigured: vi.fn() }));
vi.mock("@/auth", () => ({ signIn: mocks.signIn, authConfigured: mocks.authConfigured }));

const secret = "test-only-secret-with-enough-length-0123456789";
const verifier = "v".repeat(20) + "erifier-made-of-base64url-chars_0123";
const user = { sub: "google-123", email: "owner@example.com", name: "Owner", picture: "https://example.com/me.png" };
const origin = "http://localhost:3000";

async function sessionCookie() {
  return `authjs.session-token=${await encode({ token: user, secret, salt: "authjs.session-token" })}`;
}
function codeFrom(response: Response) {
  const location = new URL(response.headers.get("location")!);
  expect(`${location.protocol}//${location.host}`).toBe("traveller://signed-in");
  return location.searchParams;
}
const form = (fields: Record<string, string>) => new Request(`${origin}/api/native/session`, { method: "POST", body: new URLSearchParams(fields) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authConfigured.mockReturnValue(true);
  vi.stubEnv("AUTH_SECRET", secret);
  vi.stubEnv("AUTH_URL", origin);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("native sign-in helpers", () => {
  it("keeps the landing page on this site", () => {
    expect(safeNext("/shared/abc?x=1#trip")).toBe("/shared/abc?x=1#trip");
    for (const unsafe of ["//evil.example", "/\\evil.example", "https://evil.example", "evil", "", null]) expect(safeNext(unsafe)).toBe("/");
  });
  it("names the session cookie as Auth.js does", () => {
    expect(sessionCookieName(true)).toBe("__Secure-authjs.session-token");
    expect(sessionCookieName(false)).toBe("authjs.session-token");
    vi.stubEnv("AUTH_URL", "https://traveller.example");
    expect(usesSecureCookies("http://internal:3000/api")).toBe(true);
  });
  it("hashes the verifier into a challenge", async () => {
    const challenge = await challengeFor(verifier);
    expect(validChallenge(challenge)).toBe(true);
    expect(challenge).toBe(await challengeFor(verifier));
    expect(challenge).not.toBe(await challengeFor(`${verifier}x`));
  });
});

describe("native sign-in routes", () => {
  it("starts Google sign-in with the handoff as the landing page", async () => {
    const challenge = await challengeFor(verifier);
    await startSignIn(new Request(`${origin}/api/native/sign-in?challenge=${challenge}&next=/shared/abc`));
    expect(mocks.signIn).toHaveBeenCalledWith("google", { redirectTo: `/api/native/handoff?challenge=${challenge}&next=%2Fshared%2Fabc` }, { prompt: "select_account" });
    expect((await startSignIn(new Request(`${origin}/api/native/sign-in?challenge=short`)))?.status).toBe(400);
    mocks.authConfigured.mockReturnValue(false);
    expect((await startSignIn(new Request(`${origin}/api/native/sign-in?challenge=${challenge}`)))?.status).toBe(503);
    expect(mocks.signIn).toHaveBeenCalledTimes(1);
  });

  it("hands a signed-in session to the app and trades it for a session cookie", async () => {
    const challenge = await challengeFor(verifier);
    const handed = await handoff(new Request(`${origin}/api/native/handoff?challenge=${challenge}&next=/shared/abc`, { headers: { cookie: await sessionCookie() } }));
    expect(handed.status).toBe(302);
    const code = codeFrom(handed).get("code")!;
    expect(code).toBeTruthy();

    const response = await exchange(form({ code, verifier }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${origin}/shared/abc`);
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^authjs\.session-token=/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie.toLowerCase()).toContain("samesite=lax");
    const token = await decode({ token: cookie.split(";")[0].split("=")[1], secret, salt: "authjs.session-token" });
    expect(token).toMatchObject(user);
    expect(token).not.toHaveProperty("challenge");
  });

  it("returns an error to the app without a session", async () => {
    const challenge = await challengeFor(verifier);
    expect(codeFrom(await handoff(new Request(`${origin}/api/native/handoff?challenge=${challenge}`))).get("error")).toBe("Sign-in didn't finish. Try again.");
    expect(codeFrom(await handoff(new Request(`${origin}/api/native/handoff?challenge=bad`, { headers: { cookie: await sessionCookie() } }))).get("error")).toBeTruthy();
  });

  it("refuses a code without its verifier, an expired code and a session token", async () => {
    const challenge = await challengeFor(verifier);
    const code = await encode({ token: { ...user, challenge, next: "/" }, secret, salt: HANDOFF_SALT, maxAge: 120 });
    expect((await exchange(form({ code, verifier: `${verifier}x` }))).status).toBe(400);
    const expired = await encode({ token: { ...user, challenge, next: "/" }, secret, salt: HANDOFF_SALT, maxAge: -60 });
    expect((await exchange(form({ code: expired, verifier }))).status).toBe(400);
    const session = await encode({ token: { ...user, challenge }, secret, salt: "authjs.session-token" });
    const refused = await exchange(form({ code: session, verifier }));
    expect(refused.status).toBe(400);
    expect(refused.headers.get("set-cookie")).toBeNull();
    expect(await refused.text()).toContain("This sign-in has expired");
    expect((await exchange(form({ code }))).status).toBe(400);
  });

  it("sets the secure cookie on HTTPS", async () => {
    vi.stubEnv("AUTH_URL", "https://traveller.example");
    const challenge = await challengeFor(verifier);
    const code = await encode({ token: { ...user, challenge, next: "/" }, secret, salt: HANDOFF_SALT, maxAge: 120 });
    const cookie = (await exchange(new Request("https://traveller.example/api/native/session", { method: "POST", body: new URLSearchParams({ code, verifier }) }))).headers.get("set-cookie")!;
    expect(cookie).toMatch(/^__Secure-authjs\.session-token=/);
    expect(cookie).toContain("Secure");
  });
});
