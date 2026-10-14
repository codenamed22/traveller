import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), configured: vi.fn(), config: null as null | { callbacks: { signIn: (input: { user: { email?: string | null }; profile?: { email_verified?: boolean } }) => boolean } } }));
vi.mock("server-only", () => ({}));
vi.mock("next-auth", () => ({ default: (config: typeof mocks.config) => { mocks.config = config; return { handlers: {}, auth: mocks.session, signIn: vi.fn(), signOut: vi.fn() }; } }));
vi.mock("next-auth/providers/google", () => ({ default: {} }));
vi.mock("@/db", () => ({ database: vi.fn() }));

const { requireOwner, requireViewer } = await import("./server");
const { canEdit } = await import("@/auth");

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", "secret"); vi.stubEnv("AUTH_GOOGLE_ID", "id"); vi.stubEnv("AUTH_GOOGLE_SECRET", "secret");
  vi.stubEnv("ALLOWED_EMAILS", "Owner@example.com, second@example.com");
  mocks.session.mockReset();
});

const status = (promise: Promise<unknown>) => promise.then(() => 200, (error: { status: number }) => error.status);

describe("accounts", () => {
  it("lets any verified Google account sign in, but not an unverified one", () => {
    const signIn = mocks.config!.callbacks.signIn;
    expect(signIn({ user: { email: "friend@example.com" }, profile: { email_verified: true } })).toBe(true);
    expect(signIn({ user: { email: "friend@example.com" }, profile: { email_verified: false } })).toBe(false);
    expect(signIn({ user: { email: null }, profile: { email_verified: true } })).toBe(false);
  });

  it("allows editing only for allow-listed emails", () => {
    expect(canEdit("owner@EXAMPLE.com")).toBe(true);
    expect(canEdit("friend@example.com")).toBe(false);
  });

  it("lets any signed-in account view and only editors save or use paid services", async () => {
    mocks.session.mockResolvedValue({ user: { email: "Friend@Example.com" } });
    expect(await requireViewer()).toBe("friend@example.com");
    expect(await status(requireOwner())).toBe(403);
    mocks.session.mockResolvedValue({ user: { email: "OWNER@example.com" } });
    expect(await requireOwner()).toBe("owner@example.com");
    expect(await status(requireOwner(new Request("http://localhost/api/trips/x", { method: "PATCH", headers: { origin: "https://evil.example" } })))).toBe(403);
    mocks.session.mockResolvedValue(null);
    expect(await status(requireViewer())).toBe(401);
    expect(await status(requireOwner())).toBe(401);
    vi.stubEnv("ALLOWED_EMAILS", "");
    expect(await status(requireViewer())).toBe(503);
  });
});
