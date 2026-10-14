import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/server";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({ requireOwner: vi.fn(), reserveUsage: vi.fn(), getPlacePhoto: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn(), allowedEmail: vi.fn(), authConfigured: vi.fn() }));
vi.mock("@/lib/server", async (original) => ({ ...await original<typeof import("@/lib/server")>(), requireOwner: mocks.requireOwner, reserveUsage: mocks.reserveUsage }));
vi.mock("@/lib/google-maps", () => ({ getPlacePhoto: mocks.getPlacePhoto }));

const input = () => ({ placeId: "museum-id", index: 0, operationId: crypto.randomUUID() });
function request(body: unknown) {
  return new Request("http://localhost/api/place-photos", { method: "POST", headers: { "Content-Type": "application/json", origin: "http://localhost" }, body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireOwner.mockResolvedValue("owner@example.com");
  mocks.reserveUsage.mockResolvedValue(undefined);
  mocks.getPlacePhoto.mockImplementation(async (placeId: string, index: number) => ({ placeId, index, total: 1, photo: { uri: "https://lh3.googleusercontent.com/photo", authors: [{ displayName: "Photographer" }], googleMapsUri: "https://maps.google.com/maps?cid=123" } }));
});

describe("place photo endpoint", () => {
  it("authenticates, reserves two service units, and returns a non-cacheable single frame", async () => {
    const body = input();
    const response = await POST(request(body));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.requireOwner).toHaveBeenCalledOnce();
    expect(mocks.reserveUsage).toHaveBeenCalledWith("owner@example.com", 2, body.operationId);
    expect(mocks.getPlacePhoto).toHaveBeenCalledWith("museum-id", 0, expect.any(AbortSignal));
    expect(await response.json()).toMatchObject({ placeId: "museum-id", index: 0, total: 1, photo: { authors: [{ displayName: "Photographer" }] } });
  });

  it("rejects invalid indices and request fields before reserving usage", async () => {
    expect((await POST(request({ ...input(), index: 4 }))).status).toBe(400);
    expect((await POST(request({ ...input(), extra: "not allowed" }))).status).toBe(400);
    expect(mocks.reserveUsage).not.toHaveBeenCalled();
    expect(mocks.getPlacePhoto).not.toHaveBeenCalled();
  });

  it("does not call Google for unauthenticated or duplicate operations", async () => {
    mocks.requireOwner.mockRejectedValueOnce(new HttpError(401, "Sign in."));
    expect((await POST(request(input()))).status).toBe(401);
    expect(mocks.reserveUsage).not.toHaveBeenCalled();

    mocks.reserveUsage.mockRejectedValueOnce(new HttpError(409, "Already submitted."));
    expect((await POST(request(input()))).status).toBe(409);
    expect(mocks.getPlacePhoto).not.toHaveBeenCalled();
  });

  it("rejects unsafe response URLs before returning them", async () => {
    mocks.getPlacePhoto.mockResolvedValueOnce({ placeId: "museum-id", index: 0, total: 1, photo: { uri: "javascript:alert(1)", authors: [], googleMapsUri: "https://maps.google.com/maps?cid=123" } });
    expect((await POST(request(input()))).status).toBe(400);
  });
});