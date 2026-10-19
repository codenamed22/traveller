import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import type { UIMessage } from "ai";
import type { ProposalOutput } from "@/lib/assistant-ops";
import type { Journey } from "@/lib/journey";
import { newStop, newTrip } from "@/lib/trip";
import { Assistant, AssistantMessages, type AssistantHandle, type CardState } from "./Assistant";

let root: Root;
let container: HTMLElement;
let win: Window & typeof globalThis;
let entries: string[];
let stored: Record<string, string>;

// Just enough of location, history and storage for the panel's back-button handling and consent.
beforeEach(() => {
  const { document, window } = parseHTML("<html><body><div id='root'></div></body></html>");
  win = window as unknown as Window & typeof globalThis;
  container = document.getElementById("root") as unknown as HTMLElement;
  const location = { pathname: "/", search: "", hash: "" };
  entries = [""];
  const history = {
    pushState: (_state: unknown, _title: string, url: string) => { entries.push(url); location.hash = url; },
    replaceState: (_state: unknown, _title: string, url: string) => { entries[entries.length - 1] = url.startsWith("#") ? url : ""; location.hash = entries.at(-1)!; },
    back: () => { entries.pop(); location.hash = entries.at(-1) ?? ""; win.dispatchEvent(new win.Event("popstate")); },
  };
  stored = {};
  Object.defineProperty(win, "location", { value: location, configurable: true });
  Object.defineProperty(win, "history", { value: history, configurable: true });
  Object.defineProperty(win, "localStorage", { value: { getItem: (key: string) => stored[key] ?? null, setItem: (key: string, value: string) => { stored[key] = value; } }, configurable: true });
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("navigator", window.navigator);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  vi.stubGlobal("Node", window.Node);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

const button = (label: string) => [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(label) || candidate.getAttribute("aria-label") === label) as HTMLButtonElement | undefined;
const click = async (element: Element | undefined) => { expect(element).toBeTruthy(); await act(async () => { (element as HTMLElement).click(); }); };
const settle = async () => { for (let index = 0; index < 20; index++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };

const amsterdam = { ...newTrip(), city: "Amsterdam", hotel: "Motel One", startDate: "2026-12-24", days: 2, timeZone: "Europe/Amsterdam", stops: [newStop("Rum Baba")] };
const journey: Journey = { id: crypto.randomUUID(), title: "Christmas", cities: [amsterdam], plans: {} };
const proposal: ProposalOutput = { ok: true, summary: "Fit Rum Baba into Day 2", operations: [{ type: "update_stop", stopId: amsterdam.stops[0].id, day: 2 }], changes: ["Rum Baba: Flexible → Day 2"], warnings: ["Amsterdam's itinerary will need replanning."], errors: [] };

function renderAssistant(overrides: Partial<Parameters<typeof Assistant>[0]> = {}) {
  const props = { journey, view: { cityId: amsterdam.id, day: 0, tripMode: false, today: false }, model: "google/gemini-test", onApply: vi.fn(), onUndo: vi.fn(), onReplan: vi.fn(), ...overrides };
  return act(async () => root.render(createElement(Assistant, props)));
}

describe("trip assistant panel", () => {
  it("opens from the edge tab, asks for consent once per model and closes with back", async () => {
    await renderAssistant();
    expect(container.querySelector(".assistant-panel")?.className).not.toContain("open");
    await click(button("Open trip assistant"));
    expect(container.querySelector(".assistant-panel")?.className).toContain("open");
    expect(win.location.hash).toBe("#assistant");
    expect(container.textContent).toContain("shared with an AI service");
    expect(container.textContent).not.toContain("OpenRouter");
    expect(container.textContent).toContain("Charges apply based on AI and map usage.");
    await click(button("I agree, start chatting"));
    expect(stored["traveller.assistant.consent"]).toBe("1");
    expect(container.textContent).toContain("Make Day 1 lighter");
    await act(async () => win.history.back());
    expect(container.querySelector(".assistant-panel")?.className).not.toContain("open");
    expect(button("Open trip assistant")).toBeTruthy();
    // Consent is remembered, whichever model answers.
    await renderAssistant({ model: "other/model" });
    await click(button("Open trip assistant"));
    expect(container.textContent).not.toContain("Before you chat");
    await click(button("Close trip assistant"));
    expect(win.location.hash).toBe("");
  });

  it("suggests trip-day questions during the trip", async () => {
    stored["traveller.assistant.consent"] = "1";
    await renderAssistant({ view: { cityId: amsterdam.id, day: 0, tripMode: true, today: true } });
    await click(button("Open trip assistant"));
    expect(container.textContent).toContain("What's next?");
    expect(container.textContent).toContain("I'm running 30 minutes late");
  });

  it("sends the current trip with each message and shows the streamed reply", async () => {
    stored["traveller.assistant.consent"] = "1";
    const stream = ["start", "text-start", "text-delta", "text-end", "finish"].map((type) => JSON.stringify(type === "text-delta" ? { type, id: "t", delta: "Your next stop is Rum Baba." } : type.startsWith("text") ? { type, id: "t" } : { type }));
    const fetch = vi.fn(async () => new Response([...stream.map((line) => `data: ${line}\n\n`), "data: [DONE]\n\n"].join(""), { headers: { "Content-Type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" } }));
    vi.stubGlobal("fetch", fetch);
    await renderAssistant({ view: { cityId: amsterdam.id, day: 1, tripMode: true, today: true } });
    await click(button("Open trip assistant"));
    await click(button("What's next?"));
    await settle();
    const [url, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/assistant");
    const body = JSON.parse(String(options.body));
    expect(body).toMatchObject({ journey: { id: journey.id }, view: { cityId: amsterdam.id, day: 1, tripMode: true }, consent: true, provider: { provider: "openrouter", model: "google/gemini-test" } });
    expect(body.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.messages.at(-1).parts).toEqual([{ type: "text", text: "What's next?" }]);
    expect(Object.keys(body).sort()).toEqual(["consent", "journey", "messages", "operationId", "provider", "view"]);
    expect(container.textContent).toContain("Your next stop is Rum Baba.");
    expect(button("New chat")).toBeTruthy();
  });

  it("opens and sends a message handed to it, such as a planning failure, once consent is given", async () => {
    const fetch = vi.fn(async () => new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" } }));
    vi.stubGlobal("fetch", fetch);
    const handle = createRef<AssistantHandle>();
    await renderAssistant({ ref: handle });
    await act(async () => handle.current!.ask("Plan my days failed for Amsterdam: Day 2 is full."));
    expect(container.querySelector(".assistant-panel")?.className).toContain("open");
    expect(container.textContent).toContain("Before you chat");
    expect(fetch).not.toHaveBeenCalled();
    await click(button("I agree, start chatting"));
    await settle();
    const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.messages.at(-1).parts).toEqual([{ type: "text", text: "Plan my days failed for Amsterdam: Day 2 is full." }]);
  });

  it("opens with a message filled in but not sent, such as swapping a visit rain threatens", async () => {
    const fetch = vi.fn(async () => new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" } }));
    vi.stubGlobal("fetch", fetch);
    const handle = createRef<AssistantHandle>();
    await renderAssistant({ ref: handle });
    await act(async () => handle.current!.prefill("Rain is likely at Vondelpark on Day 1 (80%). Swap it for something indoors?"));
    expect(container.querySelector(".assistant-panel")?.className).toContain("open");
    await click(button("I agree, start chatting"));
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    // Sent as it stands once the traveller sends it.
    await act(async () => (container.querySelector(".assistant-input") as HTMLFormElement).dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.messages.at(-1).parts).toEqual([{ type: "text", text: "Rain is likely at Vondelpark on Day 1 (80%). Swap it for something indoors?" }]);
  });

  it("says so when a reply ends with nothing to show", async () => {
    stored["traveller.assistant.consent"] = "1";
    const chunks = [{ type: "start" }, { type: "tool-input-available", toolCallId: "c", toolName: "propose_changes", input: {} }, { type: "tool-output-available", toolCallId: "c", output: { ...proposal, ok: false, errors: ["Nope"] } }, { type: "finish" }];
    vi.stubGlobal("fetch", vi.fn(async () => new Response([...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), "data: [DONE]\n\n"].join(""), { headers: { "Content-Type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" } })));
    await renderAssistant();
    await click(button("Open trip assistant"));
    await click(button("Start each day 30 minutes earlier"));
    await settle();
    expect(container.querySelector(".proposal-card")).toBeNull();
    expect(container.textContent).toContain("I couldn't work that one out");
  });

  it("shows the server's reason when a message fails", async () => {
    stored["traveller.assistant.consent"] = "1";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "The daily service limit has been reached. Try again tomorrow." }, { status: 429 })));
    await renderAssistant();
    await click(button("Open trip assistant"));
    await click(button("What could I still fit in?"));
    await settle();
    expect(container.querySelector("[role=alert]")?.textContent).toContain("The daily service limit has been reached");
    expect(button("Try again")).toBeTruthy();
  });
});

describe("assistant messages", () => {
  const messages: UIMessage[] = [
    { id: "u", role: "user", parts: [{ type: "text", text: "Fit Rum Baba in" }] },
    { id: "a", role: "assistant", parts: [
      { type: "tool-find_place", toolCallId: "lookup", state: "output-available", input: { cityId: amsterdam.id, query: "Rum Baba" }, output: { places: [] } },
      { type: "tool-propose_changes", toolCallId: "bad", state: "output-available", input: {}, output: { ...proposal, ok: false, errors: ["That place isn't in this trip."] } },
      { type: "tool-propose_changes", toolCallId: "good", state: "output-available", input: {}, output: proposal },
      { type: "text", text: "I've suggested Day 2. Tap Apply to keep it." },
    ] },
  ];
  const spies = () => ({ apply: vi.fn<(id: string, proposal: ProposalOutput) => void>(), dismiss: vi.fn<(id: string) => void>(), undo: vi.fn<(id: string, token: string) => void>(), replan: vi.fn<(cityId: string) => void>() });
  const render = (cards: Record<string, CardState>, handlers: ReturnType<typeof spies>) =>
    act(async () => root.render(createElement(AssistantMessages, { messages, cards, onApply: handlers.apply, onDismiss: handlers.dismiss, onUndo: handlers.undo, onReplan: handlers.replan })));

  it("renders replies as text, lookups as a note and valid proposals as cards to apply", async () => {
    const handlers = spies();
    await render({}, handlers);
    expect(container.textContent).toContain("Looked up “Rum Baba” on Google");
    expect(container.querySelectorAll(".proposal-card")).toHaveLength(1);
    const card = container.querySelector(".proposal-card")!;
    expect(card.textContent).toContain("Fit Rum Baba into Day 2");
    expect(card.textContent).toContain("Rum Baba: Flexible → Day 2");
    expect(card.textContent).toContain("will need replanning");
    expect(container.textContent).not.toContain("That place isn't in this trip.");
    await click(button("Apply"));
    expect(handlers.apply).toHaveBeenCalledWith("good", proposal);
    await click(button("Dismiss"));
    expect(handlers.dismiss).toHaveBeenCalledWith("good");
  });

  it("offers undo and replanning once applied, and explains a failure", async () => {
    const handlers = spies();
    await render({ good: { status: "applied", token: "t1", stale: [{ id: amsterdam.id, city: "Amsterdam" }] } }, handlers);
    expect(button("Apply")).toBeUndefined();
    await click(button("Undo"));
    expect(handlers.undo).toHaveBeenCalledWith("good", "t1");
    await click(button("Replan Amsterdam"));
    expect(handlers.replan).toHaveBeenCalledWith(amsterdam.id);
    await render({ good: { status: "failed", error: "That place isn't in this trip. Ask again for a fresh suggestion." } }, handlers);
    expect(container.querySelector(".proposal-error")?.textContent).toContain("Ask again");
    await render({ good: { status: "dismissed" } }, handlers);
    expect(container.textContent).toContain("Dismissed: Fit Rum Baba into Day 2");
  });
});
