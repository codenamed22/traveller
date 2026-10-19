import { describe, expect, it } from "vitest";
import { captionSummarySchema, tidyCaptions } from "./captions";

describe("caption suggestions", () => {
  it("tidies hashtags into words without the # sign, once each, at most 8", () => {
    expect(tidyCaptions({ captions: [{ caption: "Golden hour at the fort.", hashtags: ["#Golconda", "golconda", "Old City!", "#", "Hyderabad Diaries", "a", "b1", "c2", "d3", "e4", "f5", "g6"] }] })).toEqual([
      { caption: "Golden hour at the fort.", hashtags: ["Golconda", "OldCity", "HyderabadDiaries", "b1", "c2", "d3", "e4", "f5"] },
    ]);
  });

  it("keeps letters from any language", () => {
    expect(tidyCaptions({ captions: [{ caption: "Été à Paris.", hashtags: ["#ÉtéÀParis", "日本旅行"] }] })[0].hashtags).toEqual(["ÉtéÀParis", "日本旅行"]);
  });

  it("takes only what the posts show, in words", () => {
    const day = { label: "Day 1", city: "Hyderabad", places: ["Golconda Fort"], favourites: ["Golconda Fort"], walkKm: 2.4 };
    expect(captionSummarySchema.safeParse({ title: "Hyderabad", cities: ["Hyderabad"], days: [day] }).success).toBe(true);
    expect(captionSummarySchema.safeParse({ title: "Hyderabad", cities: ["Hyderabad"], days: [{ ...day, photos: ["data:image/jpeg;base64,AAAA"] }] }).success).toBe(false);
    expect(captionSummarySchema.safeParse({ title: "Hyderabad", cities: [], days: [day] }).success).toBe(false);
  });
});
