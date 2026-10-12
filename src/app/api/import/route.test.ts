import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { HttpError } from "@/lib/server";

const mocks = vi.hoisted(() => ({ requireOwner: vi.fn(), reserveUsage: vi.fn(), fetchPublicText: vi.fn(), fetch: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn(), allowedEmail: vi.fn(), authConfigured: vi.fn() }));
vi.mock("@/lib/server", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/server")>(), requireOwner: mocks.requireOwner, reserveUsage: mocks.reserveUsage }));
vi.mock("@/lib/safe-fetch", () => ({ fetchPublicText: mocks.fetchPublicText }));

const candidate = { name: "Louvre Museum", date: "2026-10-13", time: "10:30", duration: 90, source: "02:15 - Louvre Museum", warning: "" };

function request(patch: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/import", { method: "POST", headers: { "Content-Type": "application/json", origin: "http://localhost" }, body: JSON.stringify({
    text: "", images: [], url: "https://youtu.be/abcdefghijk?si=tracking", consent: true,
    city: "Paris", startDate: "2026-10-12", timeZone: "Europe/Paris", operationId: crypto.randomUUID(), ...patch,
  }) });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "test-only-key");
  vi.stubEnv("GEMINI_MODEL", "gemini-2.5-flash");
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.requireOwner.mockResolvedValue("owner@example.com");
  mocks.reserveUsage.mockResolvedValue(undefined);
  mocks.fetchPublicText.mockResolvedValue("Tuesday 10:30 Louvre Museum, booked for 90 minutes");
  mocks.fetch.mockImplementation(async () => Response.json({
    candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify({ places: [candidate] }) }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 40, totalTokenCount: 90 },
  }));
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("multi-source import API", () => {
  it("passes a canonical YouTube URL directly through the real SDK without downloading it", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.fetchPublicText).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = mocks.fetch.mock.calls[0];
    expect(String(url)).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\//);
    expect(JSON.parse(options.body).contents[0].parts).toContainEqual({ fileData: { fileUri: "https://www.youtube.com/watch?v=abcdefghijk", mimeType: "video/mp4" } });
    expect(await response.json()).toEqual({ places: [{ ...candidate, date: null, time: null, duration: null, sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk" }] });
    expect(mocks.reserveUsage).toHaveBeenCalledWith("owner@example.com", 3, expect.any(String));
  });
  it("keeps web itinerary bookings and adds their source link", async () => {
    const response = await POST(request({ url: "https://example.com/itinerary" }));
    expect(response.status).toBe(200);
    expect(mocks.fetchPublicText).toHaveBeenCalledWith("https://example.com/itinerary");
    expect(await response.json()).toEqual({ places: [{ ...candidate, sourceUrl: "https://example.com/itinerary" }] });
  });
  it.each([
    { consent: false }, { url: "https://youtube.com/playlist?list=abc" },
    { text: "A hidden old document" }, { images: [{ data: "AAAA", mediaType: "image/png" }] },
  ])("rejects invalid or unconsented inputs before quota or provider use: %j", async (patch) => {
    expect((await POST(request(patch))).status).toBe(400);
    expect(mocks.reserveUsage).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("does not call Gemini when authorization or quota fails", async () => {
    mocks.requireOwner.mockRejectedValueOnce(new HttpError(401, "Sign in first."));
    expect((await POST(request())).status).toBe(401);
    expect(mocks.reserveUsage).not.toHaveBeenCalled();
    mocks.reserveUsage.mockRejectedValueOnce(new HttpError(429, "Daily limit reached."));
    expect((await POST(request())).status).toBe(429);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("offers a transcript fallback on provider rejection without retrying or scraping", async () => {
    mocks.fetch.mockImplementation(async () => Response.json({ error: { code: 400, message: "Video unavailable" } }, { status: 400 }));
    const response = await POST(request());
    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain("transcript");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetchPublicText).not.toHaveBeenCalled();
  });
});