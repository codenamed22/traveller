import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { HttpError } from "@/lib/server";

const mocks = vi.hoisted(() => ({ requireOwner: vi.fn(), reserveUsage: vi.fn(), fetch: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn(), allowedEmail: vi.fn(), authConfigured: vi.fn() }));
vi.mock("@/lib/server", async (original) => ({ ...await original<typeof import("@/lib/server")>(), requireOwner: mocks.requireOwner, reserveUsage: mocks.reserveUsage }));

const stopId = crypto.randomUUID();
const recommendation = { stopId, duration: 120, bestTime: "Morning", reason: "Allow time for the main collection.", sourceIndexes: [0] };
const grounding = { groundingChunks: [{ web: { uri: "https://example.com/museum", title: "Museum visits" } }],
  groundingSupports: [{ segment: { text: "A museum visit takes two hours.", startIndex: 0, endIndex: 29 }, groundingChunkIndices: [0] }],
  searchEntryPoint: { renderedContent: '<a href="https://www.google.com/search?q=museum">Museum visits</a>' }, webSearchQueries: ["museum visit duration"],
};

function request(patch: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/timing", { method: "POST", headers: { "Content-Type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({ city: "Paris", places: [{ id: stopId, name: "Museum" }], consent: true, operationId: crypto.randomUUID(), ...patch }) });
}
function response(text: string, grounded = false) {
  return Response.json({ candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", ...(grounded ? { groundingMetadata: grounding } : {}) }] });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "test-only-key"); vi.stubEnv("GEMINI_TIMING_MODEL", "");
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.requireOwner.mockResolvedValue("owner@example.com");
  mocks.reserveUsage.mockResolvedValue(undefined);
  mocks.fetch.mockImplementationOnce(async () => response("A museum visit takes two hours.", true))
    .mockImplementationOnce(async () => response(JSON.stringify({ recommendations: [recommendation] })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("optional grounded timing research", () => {
  it("uses real SDK search grounding then structured extraction with citations and no booking data", async () => {
    const result = await POST(request());
    expect(result.status).toBe(200);
    expect(result.headers.get("Cache-Control")).toBe("no-store");
    const data = await result.json();
    expect(data.recommendations).toEqual([recommendation]);
    expect(data.sources).toEqual([{ title: "Museum visits", url: "https://example.com/museum" }]);
    expect(data.searchEntryPoint).toBe(grounding.searchEntryPoint.renderedContent);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    const [url, options] = mocks.fetch.mock.calls[0];
    expect(String(url)).toContain("gemini-2.5-flash-lite");
    expect(JSON.parse(options.body).tools).toContainEqual({ googleSearch: {} });
    expect(JSON.parse(options.body).contents[0].parts[0].text).not.toContain("hotel");
    expect(JSON.parse(mocks.fetch.mock.calls[1][1].body).tools).toBeUndefined();
    expect(mocks.reserveUsage).toHaveBeenCalledWith("owner@example.com", 5, expect.any(String));
  });
  it.each([{ consent: false }, { places: [] }, { places: Array.from({ length: 6 }, () => ({ id: crypto.randomUUID(), name: "Place" })) }])("rejects unconsented or over-budget input: %j", async (patch) => {
    expect((await POST(request(patch))).status).toBe(400);
    expect(mocks.reserveUsage).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("does not present ungrounded model knowledge as research", async () => {
    mocks.fetch.mockReset().mockResolvedValueOnce(response("Two hours, from memory."));
    expect((await POST(request())).status).toBe(422);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it.each([{ stopId: crypto.randomUUID() }, { sourceIndexes: [4] }])("rejects invented place or source references: %j", async (patch) => {
    mocks.fetch.mockReset().mockResolvedValueOnce(response("A museum visit takes two hours.", true))
      .mockResolvedValueOnce(response(JSON.stringify({ recommendations: [{ ...recommendation, ...patch }] })));
    expect((await POST(request())).status).toBe(422);
  });
  it("checks authentication and quota before making paid requests", async () => {
    mocks.requireOwner.mockRejectedValueOnce(new HttpError(401, "Sign in first."));
    expect((await POST(request())).status).toBe(401);
    mocks.reserveUsage.mockRejectedValueOnce(new HttpError(429, "Daily limit reached."));
    expect((await POST(request())).status).toBe(429);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});