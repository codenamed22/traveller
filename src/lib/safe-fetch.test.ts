import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPublicText, isPublicAddress, validatePublicUrl } from "./safe-fetch";

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(), request: vi.fn(), close: vi.fn(),
  connect: null as null | { lookup: (hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => void },
}));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("undici", () => ({
  Agent: class {
    constructor(options: { connect: NonNullable<typeof mocks.connect> }) { mocks.connect = options.connect; }
    close = mocks.close;
  },
  request: mocks.request,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  mocks.close.mockResolvedValue(undefined);
});

describe("public URL validation", () => {
  it("rejects hostnames resolving to private addresses before making a request", async () => {
    mocks.lookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    await expect(fetchPublicText("https://example.com/trip")).rejects.toThrow("private or reserved");
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("rejects a redirect to a private host", async () => {
    const destroy = vi.fn();
    mocks.request.mockResolvedValue({ statusCode: 302, headers: { location: "https://127.0.0.1/secret" }, body: { destroy } });
    await expect(fetchPublicText("https://example.com/trip")).rejects.toThrow("Private network");
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it("pins the actual connection to the previously validated DNS result", async () => {
    mocks.request.mockImplementation(async () => {
      const callback = vi.fn();
      mocks.connect!.lookup("example.com", {}, callback);
      expect(callback).toHaveBeenCalledWith(null, "8.8.8.8", 4);
      return { statusCode: 200, headers: { "content-type": "text/plain" }, body: [Buffer.from("Museum at 10:00")] };
    });
    await expect(fetchPublicText("https://example.com/trip")).resolves.toBe("Museum at 10:00");
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
  });
  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fe80::1", "::ffff:127.0.0.1", "192.168.1.1", "0.0.0.0"])("rejects private/reserved address %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
  it("permits public addresses and rejects unsafe URL forms", () => {
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(validatePublicUrl("https://example.com/trip").hostname).toBe("example.com");
    for (const url of ["http://example.com", "https://user:pass@example.com", "https://example.com:8080", "https://[::1]", "https://127.1", "https://localhost"]) {
      expect(() => validatePublicUrl(url)).toThrow();
    }
  });
});