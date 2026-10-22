import { describe, expect, it } from "vitest";
import { fareRequestSchema, pickFare } from "./fares";

const route = (lines: string[], fare?: { currencyCode: string; units?: string; nanos?: number }) => ({
  ...(fare ? { travelAdvisory: { transitFare: fare } } : { travelAdvisory: {} }),
  legs: [{ steps: lines.map((line) => ({ transitDetails: { transitLine: { nameShort: line } } })) }],
});

describe("Google's fare for a ride", () => {
  it("takes the fare of the route on the plan's lines", () => {
    const routes = [route(["29"], { currencyCode: "EUR", units: "2", nanos: 50_000_000 }), route(["8"], { currencyCode: "EUR", units: "2", nanos: 550_000_000 }), route([])];
    expect(pickFare(routes, "8")).toEqual({ amount: 2.55, currency: "EUR" });
    expect(pickFare(routes, "29")).toEqual({ amount: 2.05, currency: "EUR" });
    expect(pickFare([route(["3", "2"], { currencyCode: "EUR", units: "2", nanos: 550_000_000 })], "3+2")).toEqual({ amount: 2.55, currency: "EUR" });
  });

  it("has none when the plan's route has none, or other routes disagree", () => {
    const brussels = [route(["R28"], { currencyCode: "EUR", units: "3" }), route(["89"])];
    expect(pickFare(brussels, "89")).toEqual({});
    expect(pickFare([route(["29"], { currencyCode: "EUR", units: "2" }), route(["8"], { currencyCode: "EUR", units: "3" })], "1")).toEqual({});
  });

  it("takes the fare every route agrees on when none takes the plan's lines, walks aside", () => {
    const routes = [route(["61"], { currencyCode: "EUR", units: "2", nanos: 50_000_000 }), route(["69"], { currencyCode: "EUR", units: "2", nanos: 50_000_000 }), route([])];
    expect(pickFare(routes, "76")).toEqual({ amount: 2.05, currency: "EUR" });
    expect(pickFare(routes, "")).toEqual({ amount: 2.05, currency: "EUR" });
    expect(pickFare([], "1")).toEqual({});
  });

  it("asks about at most 40 rides at a time, each at a known time", () => {
    const leg = { key: "2026-12-29|back", lines: "8", origin: { lat: 48.84, lng: 2.4 }, destination: { lat: 48.86, lng: 2.35 }, departure: "2026-12-29T08:10:00Z" };
    expect(fareRequestSchema.safeParse({ legs: [leg] }).success).toBe(true);
    expect(fareRequestSchema.safeParse({ legs: Array.from({ length: 41 }, () => leg) }).success).toBe(false);
    expect(fareRequestSchema.safeParse({ legs: [{ ...leg, departure: "tomorrow" }] }).success).toBe(false);
  });
});
