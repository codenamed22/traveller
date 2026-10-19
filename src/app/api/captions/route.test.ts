import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { HttpError } from "@/lib/server";

const mocks = vi.hoisted(() => ({ requireOwner: vi.fn(), reserveUsage: vi.fn(), fetch: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn(), allowedEmail: vi.fn(), authConfigured: vi.fn() }));
vi.mock("@/lib/server", async (original) => ({ ...await original<typeof import("@/lib/server")>(), requireOwner: mocks.requireOwner, reserveUsage: mocks.reserveUsage }));

const summary = { title: "Hyderabad", dates: "Oct 2026", cities: ["Hyderabad"], days: [{ label: "Day 1", city: "Hyderabad", places: ["Golconda Fort", "Charminar"], favourites: ["Golconda Fort"], note: "Met Priya at the gate", walkKm: 2.4 }] };
const suggested = { captions: [
  { caption: "Golconda at golden hour, and Charminar after.", hashtags: ["#Hyderabad", "Golconda Fort"] },
  { caption: "One day, two icons.", hashtags: ["Hyderabad"] },
  { caption: "Walked 2.4 km and would do it again.", hashtags: ["TravelDiaries"] },
] };

function request(patch: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/captions", { method: "POST", headers: { "Content-Type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({ summary, consent: true, provider: { provider: "openrouter", model: "test/model" }, operationId: crypto.randomUUID(), ...patch }) });
}
function completion(content: string) {
  return Response.json({ id: "test", object: "chat.completion", created: 1, model: "test/model", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("OPENROUTER_API_KEY", "test-only-key"); vi.stubEnv("OPENROUTER_MODEL", "test/model"); vi.stubEnv("OPENROUTER_ASSISTANT_MODEL", "");
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.requireOwner.mockResolvedValue("owner@example.com");
  mocks.reserveUsage.mockResolvedValue(undefined);
  mocks.fetch.mockResolvedValue(completion(JSON.stringify(suggested)));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("caption suggestions", () => {
  it("asks the agent once, for one unit, with the trip in words and the rules about people and references", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await response.json()).captions).toEqual([
      { caption: "Golconda at golden hour, and Charminar after.", hashtags: ["Hyderabad", "GolcondaFort"] },
      { caption: "One day, two icons.", hashtags: ["Hyderabad"] },
      { caption: "Walked 2.4 km and would do it again.", hashtags: ["TravelDiaries"] },
    ]);
    expect(mocks.reserveUsage).toHaveBeenCalledWith("owner@example.com", 1, expect.any(String));
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = mocks.fetch.mock.calls[0];
    expect(String(url)).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(options.body);
    expect(body.model).toBe("test/model");
    const text = JSON.stringify(body.messages);
    expect(text).toContain("Never include people's names");
    expect(text).toContain("Golconda Fort");
    expect(text).toContain("untrusted");
  });

  it("refuses before any charge without consent, for another model, or when the agent isn't set up", async () => {
    expect((await POST(request({ consent: false }))).status).toBe(400);
    expect((await POST(request({ provider: { provider: "openrouter", model: "other/model" } }))).status).toBe(409);
    vi.stubEnv("OPENROUTER_API_KEY", "");
    expect((await POST(request())).status).toBe(503);
    expect(mocks.reserveUsage).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("refuses photos or anything else besides the summary", async () => {
    const day = { ...summary.days[0], photos: ["AAAA"] };
    expect((await POST(request({ summary: { ...summary, days: [day] } }))).status).toBe(400);
    expect((await POST(request({ images: [] }))).status).toBe(400);
  });

  it("says when the day's allowance is used up, without asking the agent", async () => {
    mocks.reserveUsage.mockRejectedValue(new HttpError(429, "The daily service limit has been reached. Try again tomorrow."));
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("only for the owner", async () => {
    mocks.requireOwner.mockRejectedValue(new HttpError(401, "Sign in first."));
    expect((await POST(request())).status).toBe(401);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
