import { execFile } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newStop, newTrip, type Schedule, type TravelEdge } from "./trip";

vi.mock("server-only", () => ({}));
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
import { solveTripWithOrTools } from "./ortools";

const trip = { ...newTrip(), city: "Test city", hotel: "Test hotel", days: 1, timeZone: "UTC", startDate: "2026-12-24", stops: [newStop("Private visit name")] };
const travel: TravelEdge[] = [
  { day: 0, from: "hotel", to: trip.stops[0].id, mode: "WALK", minutes: 10, meters: 500 },
  { day: 0, from: trip.stops[0].id, to: "hotel", mode: "WALK", minutes: 10, meters: 500 },
];
const schedule: Schedule = { days: [{ day: 0, date: trip.startDate, visits: [{ stopId: trip.stops[0].id, start: 550, end: 595, leg: travel[0] }], returnLeg: travel[1] }], omitted: [], warnings: [], generatedAt: "2026-10-12T00:00:00Z" };
const result = { outcome: "feasible", schedule, startupMs: 1, elapsedMs: 10, firstSolutionMs: 2 };
type Callback = (error: Error | null, stdout: string, stderr: string) => void;
let completions: Callback[];
let inputs: PassThrough[];

beforeEach(() => {
  vi.stubEnv("TRAVELLER_ROUTING_PYTHON", "/test/python");
  completions = []; inputs = [];
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    completions.push(args[3] as Callback);
    const stdin = new PassThrough(); inputs.push(stdin);
    return { stdin } as unknown as ReturnType<typeof execFile>;
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

describe("bounded OR-Tools worker", () => {
  it("excludes credentials and private descriptions from worker input", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "test-secret");
    const pending = solveTripWithOrTools(trip, travel, 20);
    const payload = JSON.parse(inputs[0].read().toString());
    const options = vi.mocked(execFile).mock.calls[0][2];
    expect(options).toMatchObject({ timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 2_000_000 });
    expect(options).toHaveProperty("env.PYTHONNOUSERSITE", "1");
    expect(options).not.toHaveProperty("env.GOOGLE_MAPS_API_KEY");
    expect(payload.timeLimitMs).toBe(5000);
    expect(JSON.stringify(payload)).not.toContain("Private visit name");
    completions[0](null, JSON.stringify(result), "");
    expect(await pending).toEqual(schedule);
  });
  it.each(["garbage", JSON.stringify({ ...result, schedule: undefined }), JSON.stringify({ ...result, schedule: { ...schedule, days: [] } }), JSON.stringify({ ...result, schedule: { ...schedule, days: [{ ...schedule.days[0], returnLeg: { ...travel[1], minutes: 1 } }] } })])("rejects invalid or fabricated worker output %#", async (output) => {
    const pending = solveTripWithOrTools(trip, travel);
    completions[0](null, output, "");
    await expect(pending).rejects.toThrow(/invalid response|no schedule|independent validation|unknown connection/);
  });
  it("limits concurrent processes and releases capacity after failure", async () => {
    const first = solveTripWithOrTools(trip, travel);
    const second = solveTripWithOrTools(trip, travel);
    await expect(solveTripWithOrTools(trip, travel)).rejects.toThrow("busy");
    expect(execFile).toHaveBeenCalledTimes(2);
    completions[0](new Error("private worker stderr"), "", "secret");
    await expect(first).rejects.toThrow("worker failed");
    completions[1](null, JSON.stringify(result), "");
    await expect(second).resolves.toEqual(schedule);
    const third = solveTripWithOrTools(trip, travel);
    completions[2](null, JSON.stringify(result), "");
    await expect(third).resolves.toEqual(schedule);
  });
  it("does not start cancelled or expired requests", async () => {
    await expect(solveTripWithOrTools(trip, travel, 1, { signal: AbortSignal.abort() })).rejects.toThrow("cancelled");
    await expect(solveTripWithOrTools(trip, travel, 1, { timeoutMs: 0 })).rejects.toThrow("deadline");
    expect(execFile).not.toHaveBeenCalled();
  });
});