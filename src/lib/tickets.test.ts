import { describe, expect, it } from "vitest";
import { sniffTicket, ticketName, ticketPlaceSchema, ticketsFor, type Ticket } from "./tickets";

describe("tickets", () => {
  it("knows a PDF, JPEG or PNG by its first bytes, whatever it's called", () => {
    const bytes = (...values: number[]) => new Uint8Array(values);
    expect(sniffTicket(new TextEncoder().encode("%PDF-1.4"))).toBe("application/pdf");
    expect(sniffTicket(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffTicket(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
    expect(sniffTicket(new TextEncoder().encode("<svg"))).toBeNull();
    expect(sniffTicket(bytes())).toBeNull();
  });

  it("keeps file names safe to show and send back", () => {
    expect(ticketName('Eurostar "9114"\n.pdf', "application/pdf")).toBe("Eurostar 9114.pdf");
    expect(ticketName("../", "image/png")).toBe("..");
    expect(ticketName(" / ", "image/jpeg")).toBe("Ticket.jpg");
    expect(ticketName("a".repeat(200), "application/pdf")).toHaveLength(120);
  });

  it("belongs to a visit, or to arriving or leaving, and is found there", () => {
    const cityId = crypto.randomUUID(), stopId = crypto.randomUUID();
    expect(ticketPlaceSchema.safeParse({ cityId, target: "stop", stopId }).success).toBe(true);
    expect(ticketPlaceSchema.safeParse({ cityId, target: "stop", stopId: null }).success).toBe(false);
    expect(ticketPlaceSchema.safeParse({ cityId, target: "arrival", stopId }).success).toBe(false);
    const ticket = (target: Ticket["target"], stop: string | null) => ({ id: crypto.randomUUID(), tripId: "t", cityId, target, stopId: stop, name: "x", mime: "application/pdf" as const, size: 1, sha256: "" });
    const all = [ticket("stop", stopId), ticket("departure", null), ticket("stop", crypto.randomUUID())];
    expect(ticketsFor(all, { cityId, target: "stop", stopId })).toEqual([all[0]]);
    expect(ticketsFor(all, { cityId, target: "departure", stopId: null })).toEqual([all[1]]);
  });
});
