import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { HttpError } from "@/lib/server";

const mocks = vi.hoisted(() => ({ requireOwner: vi.fn(), reserveUsage: vi.fn(), fetchPublicText: vi.fn(), fetch: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn(), allowedEmail: vi.fn(), authConfigured: vi.fn() }));
vi.mock("@/lib/server", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/server")>(), requireOwner: mocks.requireOwner, reserveUsage: mocks.reserveUsage }));
vi.mock("@/lib/safe-fetch", () => ({ fetchPublicText: mocks.fetchPublicText }));

// What the model returns for a place, and what the API returns for it.
const extracted = { name: "Louvre Museum", date: "2026-10-13", time: "10:30", duration: 90, source: "02:15 - Louvre Museum", warning: "", booked: true };
const candidate = { name: "Louvre Museum", date: "2026-10-13", time: "10:30", duration: 90, source: "02:15 - Louvre Museum", warning: "", plannedTime: null, dayTrip: null };

function request(patch: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/import", { method: "POST", headers: { "Content-Type": "application/json", origin: "http://localhost" }, body: JSON.stringify({
    text: "", images: [], url: "https://youtu.be/abcdefghijk?si=tracking", consent: true, provider: { provider: "gemini", model: "gemini-2.5-flash" },
    city: "Paris", startDate: "2026-10-12", timeZone: "Europe/Paris", operationId: crypto.randomUUID(), ...patch,
  }) });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "test-only-key");
  vi.stubEnv("GEMINI_MODEL", "gemini-2.5-flash");
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubEnv("OPENROUTER_MODEL", "");
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.requireOwner.mockResolvedValue("owner@example.com");
  mocks.reserveUsage.mockResolvedValue(undefined);
  mocks.fetchPublicText.mockResolvedValue("Tuesday 10:30 Louvre Museum, booked for 90 minutes");
  mocks.fetch.mockImplementation(async () => Response.json({
    candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify({ places: [extracted] }) }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 40, totalTokenCount: 90 },
  }));
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("multi-source import API", () => {
  it("serializes text and images to OpenRouter only with matching provider consent", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-only-key");
    vi.stubEnv("OPENROUTER_MODEL", "google/gemini-2.5-flash");
    mocks.fetch.mockResolvedValue(Response.json({ id: "test", object: "chat.completion", created: 1, model: "google/gemini-2.5-flash", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ places: [extracted] }) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
    const response = await POST(request({ url: undefined, text: "Museum", images: [{ data: "AAAA", mediaType: "image/png" }], provider: { provider: "openrouter", model: "google/gemini-2.5-flash" } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ places: [candidate] });
    const [url, options] = mocks.fetch.mock.calls[0];
    expect(String(url)).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(JSON.parse(options.body).model).toBe("google/gemini-2.5-flash");
    expect(JSON.parse(options.body).messages[1].content).toContainEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } });
  });
  it("returns arrival and departure from an itinerary, but not from a video", async () => {
    const departure = { mode: "TRAIN", date: "2026-10-14", time: "10:14", place: "Gare du Nord", reference: "Eurostar 9422", source: "10:14 Eurostar to London" };
    mocks.fetch.mockImplementation(async () => Response.json({
      candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify({ places: [extracted], arrival: null, departure }) }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 40, totalTokenCount: 90 },
    }));
    const response = await POST(request({ url: "https://example.com/itinerary" }));
    expect(await response.json()).toEqual({ places: [{ ...candidate, sourceUrl: "https://example.com/itinerary" }], departure });
    expect(JSON.stringify(JSON.parse(mocks.fetch.mock.calls[0][1].body))).toContain("never a check-in, boarding or platform time");
    expect(Object.keys(await (await POST(request())).json())).toEqual(["places"]);
  });
  it("turns itinerary times into planned times and tags day-trip towns", async () => {
    const places = [
      { ...extracted, name: "Rozenhoedkaai", time: "09:15", booked: false, dayTrip: "Bruges" },
      { ...extracted, name: "Wide Awake", time: "14:30", booked: true, alternativeGroup: "coffee", dayTrip: null },
      { ...extracted, name: "Grand-Place", time: "18:00", booked: false, dayTrip: "Paris" },
    ];
    mocks.fetch.mockImplementation(async () => Response.json({
      candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify({ places }) }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 40, totalTokenCount: 90 },
    }));
    const body = await (await POST(request({ url: "https://example.com/itinerary" }))).json();
    expect(body.places.map(({ name, time, plannedTime, dayTrip }: Record<string, unknown>) => ({ name, time, plannedTime, dayTrip }))).toEqual([
      { name: "Rozenhoedkaai", time: null, plannedTime: "09:15", dayTrip: "Bruges" },
      // An alternative is never a booking.
      { name: "Wide Awake", time: null, plannedTime: "14:30", dayTrip: null },
      // The supplied city itself is not a day trip.
      { name: "Grand-Place", time: null, plannedTime: "18:00", dayTrip: null },
    ]);
  });
  it("returns up to a city's 60 places and says how many were left out", async () => {
    const places = Array.from({ length: 63 }, (_, index) => ({ ...extracted, name: `Place ${index + 1}` }));
    mocks.fetch.mockImplementation(async () => Response.json({
      candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify({ places }) }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 40, totalTokenCount: 90 },
    }));
    const body = await (await POST(request({ url: "https://example.com/itinerary" }))).json();
    expect(body.places).toHaveLength(60);
    expect(body.places.at(-1).name).toBe("Place 60");
    expect(body.leftOut).toBe(3);
    const sent = JSON.parse(mocks.fetch.mock.calls[0][1].body);
    // Gemini rejects the full schema when the place list also has maxItems.
    expect(JSON.stringify(sent)).not.toContain("maxItems");
    expect(sent.generationConfig.maxOutputTokens).toBe(10_000);
  });
  it("asks for shorter sections when the reply is cut off", async () => {
    mocks.fetch.mockImplementation(async () => Response.json({
      candidates: [{ content: { role: "model", parts: [{ text: '{"places":[{"name":"Louvre' }] }, finishReason: "MAX_TOKENS" }],
      usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10_000, totalTokenCount: 10_050 },
    }));
    const response = await POST(request({ url: "https://example.com/itinerary" }));
    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain("Import it in shorter sections");
  });
  it.each([{ provider: "openrouter", model: "other" }, { provider: "gemini", model: "old-model" }])("rejects mismatched provider consent before any side effects: %j", async (provider) => {
    expect((await POST(request({ url: "https://example.com/itinerary", provider }))).status).toBe(409);
    expect(mocks.reserveUsage).not.toHaveBeenCalled();
    expect(mocks.fetchPublicText).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("keeps YouTube on Gemini even when standard extraction uses OpenRouter", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-only-key");
    vi.stubEnv("OPENROUTER_MODEL", "other/model");
    expect((await POST(request())).status).toBe(200);
    expect(String(mocks.fetch.mock.calls[0][0])).toContain("generativelanguage.googleapis.com");
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "");
    mocks.fetch.mockClear();
    expect((await POST(request())).status).toBe(503);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("passes a canonical YouTube URL directly through the real SDK without downloading it", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.fetchPublicText).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = mocks.fetch.mock.calls[0];
    expect(String(url)).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\//);
    expect(JSON.parse(options.body).contents[0].parts).toContainEqual({ fileData: { fileUri: "https://www.youtube.com/watch?v=abcdefghijk", mimeType: "video/mp4" } });
    expect(await response.json()).toEqual({ places: [{ ...candidate, date: null, time: null, duration: null, plannedTime: null, sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk" }] });
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