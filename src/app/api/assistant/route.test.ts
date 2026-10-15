import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { newStop, newTrip, type Trip } from "@/lib/trip";
import type { Journey } from "@/lib/journey";

const mocks = vi.hoisted(() => ({ requireOwner: vi.fn(), reserveUsage: vi.fn(), searchPlaces: vi.fn(), fetch: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn(), canEdit: vi.fn(), authConfigured: vi.fn() }));
vi.mock("@/lib/server", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/server")>(), requireOwner: mocks.requireOwner, reserveUsage: mocks.reserveUsage }));
vi.mock("@/lib/google-maps", () => ({ searchPlaces: mocks.searchPlaces }));

const cake = { ...newStop("Rum Baba"), optional: true };
const amsterdam: Trip = { ...newTrip(), city: "Amsterdam", hotel: "Motel One", startDate: "2026-12-24", days: 3, timeZone: "Europe/Amsterdam", stops: [cake] };
const journey: Journey = { id: crypto.randomUUID(), title: "Christmas", cities: [amsterdam], plans: {} };
const userMessage = (text: string) => ({ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] });

function request(patch: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/assistant", { method: "POST", headers: { "Content-Type": "application/json", origin: "http://localhost" }, body: JSON.stringify({
    messages: [userMessage("Fit Rum Baba in on day 3")], journey, view: { cityId: amsterdam.id, day: 0 }, consent: true,
    provider: { provider: "openrouter", model: "google/gemini-test" }, operationId: crypto.randomUUID(), ...patch,
  }) });
}

// OpenRouter streams OpenAI-style chat completion chunks over server-sent events.
function sse(chunks: unknown[]) {
  const body = [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), "data: [DONE]\n\n"].join("");
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}
const chunk = (delta: unknown, finish: string | null = null) => ({ id: "gen", object: "chat.completion.chunk", created: 1, model: "google/gemini-test", choices: [{ index: 0, delta, finish_reason: finish }] });
const toolCall = (name: string, args: unknown, id = "call_1") => sse([
  chunk({ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }),
  chunk({}, "tool_calls"),
]);
const reply = (text: string) => sse([chunk({ role: "assistant", content: text }), chunk({}, "stop")]);

async function events(response: Response) {
  const text = await response.text();
  return text.split("\n\n").flatMap((block) => block.startsWith("data: ") && block !== "data: [DONE]" ? [JSON.parse(block.slice(6))] : []);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("OPENROUTER_API_KEY", "test-only-key");
  vi.stubEnv("OPENROUTER_MODEL", "google/gemini-test");
  vi.stubEnv("OPENROUTER_ASSISTANT_MODEL", "");
  vi.stubEnv("GOOGLE_MAPS_API_KEY", "test-only-key");
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.requireOwner.mockResolvedValue("owner@example.com");
  mocks.reserveUsage.mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("trip assistant API", () => {
  it("streams a checked proposal after charging two units, without changing anything", async () => {
    mocks.fetch
      .mockResolvedValueOnce(toolCall("propose_changes", { summary: "Fit Rum Baba into Day 3", operations: [{ type: "update_stop", stopId: cake.id, day: 3, optional: false }] }))
      .mockResolvedValueOnce(reply("I've suggested moving Rum Baba to Day 3. Tap Apply to keep it."));
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
    const chunks = await events(response);
    const output = chunks.find((entry) => entry.type === "tool-output-available")?.output;
    expect(output).toMatchObject({ ok: true, summary: "Fit Rum Baba into Day 3", changes: ["Rum Baba: Flexible → Day 3 · optional → required"], errors: [] });
    expect(chunks.filter((entry) => entry.type === "text-delta").map((entry) => entry.delta).join("")).toContain("Tap Apply");
    expect(mocks.reserveUsage).toHaveBeenCalledTimes(1);
    expect(mocks.reserveUsage).toHaveBeenCalledWith("owner@example.com", 2, expect.any(String));
    const sent = JSON.parse(mocks.fetch.mock.calls[0][1].body);
    expect(String(mocks.fetch.mock.calls[0][0])).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(sent.model).toBe("google/gemini-test");
    expect(sent.tools.map((entry: { function: { name: string } }) => entry.function.name)).toEqual(["propose_changes", "find_place"]);
    // The trip goes in as labelled data, ahead of the conversation.
    expect(sent.messages[0].role).toBe("system");
    expect(JSON.stringify(sent.messages[1])).toContain("untrusted JSON");
    expect(JSON.stringify(sent.messages[1])).toContain(cake.id);
    // The model sees the tool result on the second step.
    expect(JSON.stringify(JSON.parse(mocks.fetch.mock.calls[1][1].body).messages)).toContain("optional → required");
  });

  it("reports invalid proposals back to the model instead of failing", async () => {
    mocks.fetch
      .mockResolvedValueOnce(toolCall("propose_changes", { summary: "Remove", operations: [{ type: "remove_stop", stopId: "made-up" }] }))
      .mockResolvedValueOnce(reply("I couldn't find that place."));
    const chunks = await events(await POST(request()));
    expect(chunks.find((entry) => entry.type === "tool-output-available")?.output).toMatchObject({ ok: false, errors: ["That place isn't in this trip."] });
  });

  it("looks places up on Google for one unit each, at most three per message", async () => {
    mocks.searchPlaces.mockResolvedValue([{ id: "g-toki", name: "Toki", address: "Binnen Dommersstraat 15", location: { lat: 52.38, lng: 4.89 } }]);
    for (let index = 0; index < 4; index++) mocks.fetch.mockResolvedValueOnce(toolCall("find_place", { cityId: amsterdam.id, query: "Toki coffee" }, `call_${index}`));
    mocks.fetch.mockResolvedValueOnce(reply("Found it."));
    const chunks = await events(await POST(request()));
    const outputs = chunks.filter((entry) => entry.type === "tool-output-available").map((entry) => entry.output);
    expect(outputs[0]).toEqual({ places: [{ placeId: "g-toki", name: "Toki", address: "Binnen Dommersstraat 15", location: { lat: 52.38, lng: 4.89 } }] });
    expect(outputs[3]).toEqual({ error: "No more lookups for this message. Add the place by name instead." });
    expect(mocks.searchPlaces).toHaveBeenCalledTimes(3);
    expect(mocks.searchPlaces).toHaveBeenCalledWith("Toki coffee, Amsterdam", amsterdam.hotelLocation);
    expect(mocks.reserveUsage.mock.calls.filter((call) => call[1] === 1)).toHaveLength(3);
  });

  it("repairs a place id the model mistyped from find_place, and drops one it never saw", async () => {
    const bouche = { id: "ChIJeaHQeG_Fw0cRqnvYPuQe9Fo", name: "Bouche", address: "Rue Lesbroussart", location: { lat: 50.8416133, lng: 4.3596525 } };
    mocks.searchPlaces.mockResolvedValue([bouche]);
    mocks.fetch
      .mockResolvedValueOnce(toolCall("find_place", { cityId: amsterdam.id, query: "Bouche" }))
      .mockResolvedValueOnce(toolCall("propose_changes", { summary: "Add coffee", operations: [
        { type: "add_stop", cityId: amsterdam.id, name: "Bouche", place: { placeId: "ChIJeaHQeG_Fw0cRqnvYPuc9Fo", location: bouche.location } },
        { type: "add_stop", cityId: amsterdam.id, name: "Invented", place: { placeId: "ChIJmadeUp", location: { lat: 1, lng: 1 } } },
      ] }, "call_2"))
      .mockResolvedValueOnce(reply("Suggested."));
    const chunks = await events(await POST(request()));
    const output = chunks.filter((entry) => entry.type === "tool-output-available").at(-1)?.output;
    expect(output.operations[0].place).toEqual({ placeId: bouche.id, location: bouche.location });
    expect(output.operations[1].place).toBeUndefined();
    expect(output.warnings).toContain("Confirm Invented on the map before planning.");
  });

  it("checks configuration, consent and model before spending anything", async () => {
    expect((await POST(request({ provider: { provider: "openrouter", model: "other/model" } }))).status).toBe(409);
    expect((await POST(request({ consent: false }))).status).toBe(400);
    vi.stubEnv("OPENROUTER_API_KEY", "");
    expect((await POST(request())).status).toBe(503);
    expect(mocks.reserveUsage).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("uses a separate assistant model when configured", async () => {
    vi.stubEnv("OPENROUTER_ASSISTANT_MODEL", "openai/tool-model");
    expect((await POST(request())).status).toBe(409);
    mocks.fetch.mockResolvedValueOnce(reply("Hi!"));
    const response = await POST(request({ provider: { provider: "openrouter", model: "openai/tool-model" } }));
    expect(response.status).toBe(200);
    await response.text();
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body).model).toBe("openai/tool-model");
  });

  it("drops a tool call that was stopped before it finished", async () => {
    mocks.fetch.mockResolvedValueOnce(reply("Sure."));
    const stopped = { id: "a", role: "assistant", parts: [{ type: "tool-propose_changes", toolCallId: "call_9", state: "input-available", input: { summary: "x" } }, { type: "text", text: "Let me" }] };
    const response = await POST(request({ messages: [userMessage("Move it"), stopped, userMessage("Never mind, what's next?")] }));
    expect(response.status).toBe(200);
    await response.text();
    expect(JSON.stringify(JSON.parse(mocks.fetch.mock.calls[0][1].body).messages)).not.toContain("call_9");
  });

  it("rejects an invalid trip, an empty or oversized message and a conversation ending with the assistant", async () => {
    expect((await POST(request({ journey: { ...journey, cities: [] } }))).status).toBe(400);
    // A trip the editor holds but can't save says what to fix.
    const conflicted = await POST(request({ journey: { ...journey, cities: [{ ...amsterdam, stops: amsterdam.stops.map((stop) => stop.id === cake.id ? { ...stop, day: 5 } : stop) }, ...journey.cities.slice(1)] } }));
    expect(conflicted.status).toBe(422);
    expect((await conflicted.json()).error).toBe("Fix this in the trip first, then ask again: Rum Baba is assigned outside this trip.");
    expect((await POST(request({ messages: [userMessage(" ")] }))).status).toBe(400);
    expect((await POST(request({ messages: [userMessage("x".repeat(2001))] }))).status).toBe(413);
    expect((await POST(request({ messages: [{ id: "a", role: "assistant", parts: [{ type: "text", text: "Hi" }] }] }))).status).toBe(400);
    expect((await POST(request({ messages: [{ id: "a", role: "user", parts: [{ type: "bogus" }] }] }))).status).toBe(400);
    expect(mocks.reserveUsage).not.toHaveBeenCalled();
  });
});
