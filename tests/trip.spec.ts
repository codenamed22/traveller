import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { newStop, newTrip, tripDate, type Trip, type PlanResult } from "../src/lib/trip";

test("edit bookings, preserve calendar dates, and export a draft", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByLabel("Trip name").fill("Three days in Paris");
  await page.getByLabel("City", { exact: true }).fill("Paris, France");
  await page.getByLabel("Hotel or starting point").fill("Hotel des Grands Boulevards");
  await page.getByLabel("Start date").fill("2026-10-12");
  await page.getByLabel("City timezone").fill("Europe/Paris");
  await page.getByLabel("New place name").fill("Louvre Museum");
  await page.getByRole("button", { name: "Add place", exact: true }).click();
  await page.getByLabel("Visit minutes").fill("90");
  await page.getByLabel("Assigned day").selectOption("1");
  await page.getByLabel("Fixed booking", { exact: true }).check();
  await page.getByLabel("Booked time").fill("10:30");
  await expect(page.getByLabel("Optional if the day is full")).toBeDisabled();
  await page.getByLabel("Start date").fill("2026-10-13");
  await expect(page.getByLabel("Assigned day")).toHaveValue("0");
  await expect(page.getByLabel("Booked time")).toHaveValue("10:30");
  await page.getByLabel("New place name").fill("Jardin du Luxembourg");
  await page.getByRole("button", { name: "Add place", exact: true }).click();
  await page.getByLabel("New place name").fill("Musee d'Orsay and the riverside sculpture garden");
  await page.getByRole("button", { name: "Add place", exact: true }).click();
  await page.getByRole("button", { name: /Musee d'Orsay and/ }).click();
  await page.locator(".trip-settings > summary").click();
  await expect(page.locator(".stop-item")).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download trip backup" }).click();
  const download = await downloadPromise;
  const output = testInfo.outputPath("trip-backup.json");
  await download.saveAs(output);
  const backup = JSON.parse(await readFile(output, "utf8"));
  expect(backup.trip.stops[0]).toMatchObject({ day: 0, fixedTime: "10:30", duration: 90 });
  expect(backup.trip.startDate).toBe("2026-10-13");
  expect(backup.plan).toBeNull();
  await page.screenshot({ path: testInfo.outputPath("workspace.png"), fullPage: true });
  if (testInfo.project.name === "mobile") {
    await page.getByRole("button", { name: "Map", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Map not connected" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("map.png"), fullPage: true });
  }
  expect(errors).toEqual([]);
});

test("review pasted places and keep AI off without consent", async ({ page }) => {
  const extractionRequests: string[] = [];
  page.on("request", (request) => { if (request.url().endsWith("/api/import")) extractionRequests.push(request.url()); });
  await page.goto("/");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByLabel("Places or itinerary").fill("Louvre Museum\nLuxembourg Gardens");
  await expect(page.getByRole("button", { name: "Extract itinerary" })).toBeDisabled();
  await page.getByRole("button", { name: "Review place list" }).click();
  await expect(page.getByRole("dialog")).toHaveAccessibleName("Review imported places");
  await expect(page.getByLabel("Place", { exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "Confirm 2 places" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".stop-item")).toHaveCount(2);
  expect(extractionRequests).toEqual([]);
});

test("paid and persistence endpoints reject unauthenticated access", async ({ request }) => {
  for (const path of ["/api/plan", "/api/import", "/api/places", "/api/timing"]) {
    const response = await request.post(path, { data: {} });
    expect([401, 503]).toContain(response.status());
  }
  const response = await request.get("/api/trips");
  expect([401, 503]).toContain(response.status());
});

test("reads a PDF locally and previews images without cloud transmission", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => { if (request.url().endsWith("/api/import")) requests.push(request.url()); });
  await page.goto("/");
  const screenshot = await page.screenshot({ caret: "initial" });
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByRole("button", { name: "Document", exact: true }).click();
  await page.getByLabel("Itinerary document").setInputFiles({ name: "itinerary.png", mimeType: "image/png", buffer: screenshot });
  await expect(page.getByRole("img", { name: "itinerary.png" })).toBeVisible();
  const stream = "BT /F1 12 Tf 20 200 Td (Louvre Museum at 10:00 on October 13. Luxembourg Gardens in the afternoon.) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  await page.getByLabel("Itinerary document").setInputFiles({ name: "itinerary.pdf", mimeType: "application/pdf", buffer: Buffer.from(pdf) });
  await expect(page.getByLabel("Extracted text")).toContainText("Louvre Museum", { timeout: 15_000 });
  expect(requests).toEqual([]);
});

test("collects selected ideas across imports without replacing bookings", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.getByLabel("Start date").fill("2026-10-12");
  await page.getByLabel("New place name").fill("Louvre Museum");
  await page.getByRole("button", { name: "Add place", exact: true }).click();
  await page.getByLabel("Fixed booking", { exact: true }).check();
  await page.getByLabel("Booked time").fill("10:30");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByLabel("Places or itinerary").fill("Louvre Museum\nLuxembourg Gardens\nMusee d'Orsay");
  await page.getByRole("button", { name: "Review place list" }).click();
  await expect(page.getByLabel("Include Louvre Museum")).not.toBeChecked();
  await expect(page.getByText("Possible duplicate", { exact: true })).toBeVisible();
  await page.getByLabel("Include Musee d'Orsay").uncheck();
  await page.getByLabel("Add as optional ideas").check();
  await page.screenshot({ path: testInfo.outputPath("idea-review.png"), fullPage: true });
  await page.getByRole("button", { name: "Confirm 1 place", exact: true }).click();
  await expect(page.locator(".stop-item")).toHaveCount(2);
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByLabel("Places or itinerary").fill("Luxembourg Gardens\nSainte-Chapelle");
  await page.getByRole("button", { name: "Review place list" }).click();
  await expect(page.getByLabel("Include Luxembourg Gardens")).not.toBeChecked();
  await page.getByRole("button", { name: "Confirm 1 place", exact: true }).click();
  await expect(page.locator(".stop-item")).toHaveCount(3);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download trip backup" }).click();
  const output = testInfo.outputPath("collected-ideas.json");
  await (await downloadPromise).saveAs(output);
  const { trip } = JSON.parse(await readFile(output, "utf8"));
  expect(trip.stops[0]).toMatchObject({ name: "Louvre Museum", fixedTime: "10:30", day: 0, optional: false });
  expect(trip.stops[1]).toMatchObject({ name: "Luxembourg Gardens", fixedTime: null, day: null, optional: true });
  expect(trip.stops[2].name).toBe("Sainte-Chapelle");
});

test("offers YouTube input with separate consent and no hidden document preview", async ({ page }, testInfo) => {
  const requests: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("request", (request) => { if (request.url().endsWith("/api/import")) requests.push(request.url()); });
  await page.goto("/");
  const screenshot = await page.screenshot({ caret: "initial" });
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByRole("button", { name: "Document", exact: true }).click();
  await page.getByLabel("Itinerary document").setInputFiles({ name: "old-document.png", mimeType: "image/png", buffer: screenshot });
  await expect(page.getByRole("img", { name: "old-document.png" })).toBeVisible();
  await page.getByLabel(/Send the selected text/).check();
  await page.getByRole("button", { name: "YouTube", exact: true }).click();
  await expect(page.getByRole("img", { name: "old-document.png" })).toHaveCount(0);
  await expect(page.getByLabel(/Send this link/)).not.toBeChecked();
  await page.getByLabel("YouTube video URL").fill("https://youtu.be/abcdefghijk");
  await expect(page.getByRole("button", { name: "Find place ideas" })).toBeDisabled();
  await page.getByLabel(/Send this link/).check();
  await page.getByLabel("YouTube video URL").fill("https://youtu.be/lmnopqrstuv");
  await expect(page.getByLabel(/Send this link/)).not.toBeChecked();
  expect(await page.getByRole("dialog").evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("youtube-import.png"), fullPage: true });
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
});

test("retains source links in backups and allows selection at the trip limit", async ({ page }) => {
  const sourceUrl = "https://www.youtube.com/watch?v=abcdefghijk";
  const trip = { ...newTrip(), city: "Paris", hotel: "Hotel", stops: Array.from({ length: 24 }, (_, index) => ({ ...newStop(`Place ${index + 1} ${"a".repeat(170)}`), source: "a".repeat(1000), sourceUrl: index === 0 ? sourceUrl : `${sourceUrl}&context=${"a".repeat(2900)}` })) };
  const backup = Buffer.from(JSON.stringify({ trip }));
  expect(backup.byteLength).toBeGreaterThan(100_000);
  await page.goto("/");
  await page.getByRole("button", { name: "Connections and settings" }).click();
  await page.getByLabel("Open trip backup").setInputFiles({ name: "ideas.json", mimeType: "application/json", buffer: backup });
  await expect(page.locator(".stop-item")).toHaveCount(24);
  await page.locator(".stop-summary").first().click();
  await expect(page.getByRole("link", { name: "Source link" })).toHaveAttribute("href", sourceUrl);
  await expect(page.getByRole("button", { name: "Confirm place on map" })).toBeVisible();
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByLabel("Places or itinerary").fill("New museum\nNew garden");
  await page.getByRole("button", { name: "Review place list" }).click();
  await expect(page.getByRole("button", { name: "Confirm 2 places" })).toBeDisabled();
  await page.getByLabel("Select all places").uncheck();
  await page.getByLabel("Include New garden").check();
  await page.getByRole("button", { name: "Confirm 1 place", exact: true }).click();
  await expect(page.locator(".stop-item")).toHaveCount(25);
});

test("quickly creates three cities and keeps hotels and bookings separate through backup restore", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("/");
  await page.getByRole("button", { name: "New trip", exact: true }).click();
  const setup = page.getByRole("dialog", { name: "New trip" });
  await setup.getByLabel("Trip title").fill("Autumn in Europe");
  await setup.getByLabel("Departure date").fill("2026-10-30");
  for (const city of ["Paris", "Amsterdam", "Brussels"]) await setup.getByRole("button", { name: city, exact: true }).click();
  await setup.getByLabel("Days in city 2").fill("2");
  await expect(setup.getByLabel("Arrival in city 2")).toHaveValue("2026-11-02");
  await expect(setup.getByLabel("Arrival in city 3")).toHaveValue("2026-11-04");
  await expect(setup.getByLabel("Timezone for city 3")).toHaveValue("Europe/Brussels");
  expect(await setup.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
  await setup.getByRole("heading").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("new-trip.png"), fullPage: true });
  await setup.getByRole("button", { name: "Create trip" }).click();
  await expect(page.getByLabel("Trip name")).toHaveValue("Autumn in Europe");
  await expect(page.locator(".city-tabs button")).toHaveCount(3);
  await page.getByLabel("Hotel or starting point").fill("Paris hotel");
  await page.getByLabel("New place name").fill("Louvre Museum");
  await page.getByRole("button", { name: "Add place", exact: true }).click();
  await page.getByLabel("Assigned day").selectOption("1");
  await page.getByLabel("Fixed booking", { exact: true }).check();
  await page.getByLabel("Booked time").fill("10:30");
  await page.locator(".city-tabs").getByRole("button", { name: /Amsterdam/ }).click();
  await expect(page.getByLabel("Hotel or starting point")).toHaveValue("");
  await expect(page.locator(".stop-item")).toHaveCount(0);
  await expect(page.getByLabel("Start date")).toHaveValue("2026-11-02");
  await page.getByLabel("Hotel or starting point").fill("Amsterdam hotel");
  await page.locator(".city-tabs").getByRole("button", { name: /Paris/ }).click();
  await expect(page.getByLabel("Hotel or starting point")).toHaveValue("Paris hotel");
  await page.locator(".stop-summary").click();
  await expect(page.getByLabel("Booked time")).toHaveValue("10:30");
  await page.locator(".trip-settings > summary").click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("multi-city-workspace.png"), fullPage: true });
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download trip backup" }).click();
  const output = testInfo.outputPath("journey.json");
  await (await download).saveAs(output);
  const { journey } = JSON.parse(await readFile(output, "utf8"));
  expect(journey.cities).toHaveLength(3);
  expect(journey.cities[0].stops[0]).toMatchObject({ day: 1, fixedTime: "10:30" });
  expect(journey.cities[1].hotel).toBe("Amsterdam hotel");
  await page.reload();
  await page.getByRole("button", { name: "Connections and settings" }).click();
  await page.getByLabel("Open trip backup").setInputFiles(output);
  await expect(page.locator(".city-tabs button")).toHaveCount(3);
  await expect(page.getByLabel("Trip name")).toHaveValue("Autumn in Europe");
  await page.locator(".city-tabs").getByRole("button", { name: /Amsterdam/ }).click();
  await expect(page.getByLabel("Hotel or starting point")).toHaveValue("Amsterdam hotel");
  expect(errors).toEqual([]);
});

test("accepts custom cities, rejects overlapping dates, and adds or removes city visits", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New trip", exact: true }).click();
  let setup = page.getByRole("dialog", { name: "New trip" });
  await setup.getByLabel("Departure date").fill("2026-10-20");
  await setup.getByRole("button", { name: "Paris", exact: true }).click();
  await setup.getByRole("button", { name: "Add another city" }).click();
  await setup.getByLabel("City 2", { exact: true }).fill("Ghent, Belgium");
  await setup.getByLabel("Timezone for city 2").fill("Europe/Brussels");
  await setup.getByLabel("Arrival in city 2").fill("2026-10-21");
  await setup.getByRole("button", { name: "Create trip" }).click();
  await expect(setup.getByRole("alert")).toContainText("previous city");
  await setup.getByLabel("Reset arrival for city 2").click();
  await expect(setup.getByLabel("Arrival in city 2")).toHaveValue("2026-10-23");
  await setup.getByRole("button", { name: "Create trip" }).click();
  await page.getByRole("button", { name: "Add cities", exact: true }).click();
  setup = page.getByRole("dialog", { name: "Add cities" });
  await setup.getByRole("button", { name: "Brussels", exact: true }).click();
  await expect(setup.getByLabel("Arrival in city 1")).toHaveValue("2026-10-26");
  await setup.getByRole("button", { name: "Add cities", exact: true }).click();
  await expect(page.getByLabel("City", { exact: true })).toHaveValue("Brussels, Belgium");
  await expect(page.locator(".city-tabs button")).toHaveCount(3);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove current city" }).click();
  await expect(page.locator(".city-tabs button")).toHaveCount(2);
});

test("hotel search uses the active city and explains missing connections", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => { if (request.url().endsWith("/api/places")) requests.push(request.url()); });
  await page.goto("/");
  await page.getByLabel("City", { exact: true }).fill("Paris");
  await expect(page.getByLabel("City timezone")).toHaveValue("Europe/Paris");
  await page.getByLabel("Hotel or starting point").fill("The Hoxton");
  await page.getByRole("button", { name: "Find hotel on map" }).click();
  const search = page.getByRole("dialog", { name: "Find your hotel" });
  await expect(search.getByLabel("Place or address")).toHaveValue("The Hoxton Paris");
  await expect(search.getByRole("alert")).toContainText("Google Places server key");
  expect(requests).toEqual([]);
});

async function openPlanningTrip(page: Page, hotel = "Private hotel") {
  const trip: Trip = {
    ...newTrip(), city: "Paris", hotel, hotelPlaceId: hotel ? "hotel-id" : null, startDate: "2026-10-12", timeZone: "Europe/Paris", days: 2,
    stops: [{ ...newStop("Louvre Museum"), placeId: "museum-id", day: 0, fixedTime: "10:30" }, { ...newStop("Luxembourg Gardens"), placeId: "garden-id" }],
  };
  await page.goto("/");
  await page.getByRole("button", { name: "Connections and settings" }).click();
  await page.getByLabel("Open trip backup").setInputFiles({ name: "planning.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ journey: { id: trip.id, title: trip.title, cities: [trip], plans: {} } })) });
  await expect(page.locator(".stop-item")).toHaveCount(2);
  await page.getByRole("button", { name: "Plan my days", exact: true }).first().click();
  return trip;
}

function previewFixture(trip: Trip): PlanResult {
  let cursor = 620;
  const visits = trip.stops.map((stop, index) => {
    const start = cursor + 10;
    cursor = start + stop.duration;
    return { stopId: stop.id, start, end: cursor, leg: { day: 0, from: index ? trip.stops[index - 1].id : "hotel", to: stop.id, mode: "WALK" as const, minutes: 10, meters: 700 } };
  });
  return { verified: true, places: {}, schedule: { generatedAt: "2026-10-12T08:00:00Z", warnings: [], omitted: [], days: [{ day: 0, date: tripDate(trip, 0), visits, returnLeg: { day: 0, from: trip.stops.at(-1)!.id, to: "hotel", mode: "WALK", minutes: 12, meters: 900 } }, { day: 1, date: tripDate(trip, 1), visits: [] }] } };
}

test("planning popup keeps drafts separate and preserves fixed bookings", async ({ page }, testInfo) => {
  const requests: string[] = [];
  page.on("request", (request) => { if (/\/api\/(plan|timing)$/.test(request.url())) requests.push(request.url()); });
  await openPlanningTrip(page, "");
  const dialog = page.getByRole("dialog", { name: "Plan my days" });
  await expect(dialog.getByRole("button", { name: "Optimize preview" })).toBeDisabled();
  await expect(dialog.getByLabel("Day for Louvre Museum")).toBeDisabled();
  await expect(dialog.getByLabel("Optional Louvre Museum")).toBeDisabled();
  await dialog.getByLabel("Maximum places per day").fill("2");
  await dialog.getByLabel("Visit minutes for Luxembourg Gardens").fill("85");
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Plan my days", exact: true }).first().click();
  await expect(dialog.getByLabel("Maximum places per day")).toHaveValue("25");
  await expect(dialog.getByLabel("Visit minutes for Luxembourg Gardens")).toHaveValue("45");
  await dialog.getByLabel("Day grouping").selectOption("BALANCED");
  await dialog.getByLabel("Default transport").selectOption("TRANSIT");
  await dialog.getByLabel("Maximum places per day").fill("2");
  await dialog.getByLabel("Standalone walking leg limit (min)").fill("15");
  await dialog.getByLabel("Visit minutes for Luxembourg Gardens").fill("85");
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.getByRole("heading", { name: "Plan my days", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("planning-preferences.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Apply preferences" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download trip backup" }).click();
  const output = testInfo.outputPath("preferences.json");
  await (await download).saveAs(output);
  const backup = JSON.parse(await readFile(output, "utf8"));
  expect(backup.trip.planning).toMatchObject({ goal: "BALANCED", mode: "TRANSIT", maxStopsPerDay: 2, maxWalkMinutes: 15 });
  expect(backup.trip.stops[0]).toMatchObject({ day: 0, fixedTime: "10:30", optional: false });
  expect(backup.trip.stops[1].duration).toBe(85);
  expect(backup.plan).toBeNull();
  expect(requests).toEqual([]);
});

test("planning popup previews before accepting and retains an accepted plan after failure", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const submitted: Trip[] = [];
  let fail = false;
  await page.route("**/api/plan", async (route) => {
    const trip = route.request().postDataJSON().trip as Trip;
    submitted.push(trip);
    await route.fulfill(fail ? { status: 422, json: { error: "No route meets these preferences." } } : { json: previewFixture(trip) });
  });
  await openPlanningTrip(page);
  const dialog = page.getByRole("dialog", { name: "Plan my days" });
  expect(submitted).toHaveLength(0);
  await dialog.getByRole("button", { name: "Optimize preview" }).click();
  await expect(dialog.getByLabel("Suggested itinerary")).toContainText("Louvre Museum");
  await dialog.getByRole("button", { name: "Preferences", exact: true }).click();
  await dialog.getByLabel("Visit minutes for Luxembourg Gardens").fill("80");
  await expect(dialog.getByRole("button", { name: "Suggested plan", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Optimize preview" }).click();
  await expect(dialog.getByRole("button", { name: "Use this plan" })).toBeVisible();
  expect(submitted).toHaveLength(2);
  expect(submitted[1].stops[1].duration).toBe(80);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("planning-preview.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  const discarded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download trip backup" }).click();
  const discardedPath = testInfo.outputPath("discarded-preview.json");
  await (await discarded).saveAs(discardedPath);
  const unchanged = JSON.parse(await readFile(discardedPath, "utf8"));
  expect(unchanged.trip.stops[1].duration).toBe(45);
  expect(unchanged.plan).toBeNull();
  await page.getByRole("button", { name: "Plan my days", exact: true }).first().click();
  await dialog.getByLabel("Visit minutes for Luxembourg Gardens").fill("80");
  await dialog.getByRole("button", { name: "Optimize preview" }).click();
  await dialog.getByRole("button", { name: "Use this plan" }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Plan my days", exact: true }).first().click();
  await dialog.getByLabel("Visit minutes for Luxembourg Gardens").fill("100");
  fail = true;
  await dialog.getByRole("button", { name: "Optimize preview" }).click();
  await expect(dialog.getByRole("alert")).toContainText("No route meets these preferences");
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  const accepted = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download trip backup" }).click();
  const acceptedPath = testInfo.outputPath("accepted-preview.json");
  await (await accepted).saveAs(acceptedPath);
  const backup = JSON.parse(await readFile(acceptedPath, "utf8"));
  expect(backup.trip.stops[1].duration).toBe(80);
  expect(backup.plan.days[0].stopIds).toEqual(backup.trip.stops.map((stop: Trip["stops"][number]) => stop.id));
  expect(errors).toEqual([]);
});

test("planning popup research requires consent and leaves duration overrides in control", async ({ page }, testInfo) => {
  const requests: { city: string; places: { id: string; name: string }[]; consent: boolean }[] = [];
  await page.route("**/api/timing", async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    await route.fulfill({ json: { recommendations: [{ stopId: body.places[0].id, duration: 120, bestTime: "Morning", reason: "A typical leisurely visit.", sourceIndexes: [0] }], sources: [{ title: "Official garden guide", url: "https://example.com/garden" }], research: "Allow around two hours; morning is an estimate, not an opening-hours guarantee.", searchEntryPoint: "<a href='https://www.google.com/search?q=garden' target='_blank'>Google Search</a>" } });
  });
  const trip = await openPlanningTrip(page);
  const dialog = page.getByRole("dialog", { name: "Plan my days" });
  const research = dialog.getByRole("button", { name: "Research selected timings" });
  await expect(research).toBeDisabled();
  await dialog.getByLabel("Research timing for Luxembourg Gardens").check();
  await expect(research).toBeDisabled();
  await dialog.getByLabel(/Send selected place names/).check();
  await research.click();
  await expect(dialog.getByText("Suggested: 120 min", { exact: true })).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ city: "Paris", consent: true, places: [{ id: trip.stops[1].id, name: "Luxembourg Gardens" }] });
  expect(JSON.stringify(requests)).not.toContain("Private hotel");
  expect(JSON.stringify(requests)).not.toContain("10:30");
  await expect(dialog.getByLabel("Visit minutes for Luxembourg Gardens")).toHaveValue("45");
  await expect(dialog.locator("iframe")).toHaveAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox");
  await dialog.getByRole("button", { name: "Use 120 min for Luxembourg Gardens" }).click();
  await expect(dialog.getByLabel("Visit minutes for Luxembourg Gardens")).toHaveValue("120");
  await dialog.getByLabel("Visit minutes for Luxembourg Gardens").fill("75");
  await dialog.getByText("Google Search evidence", { exact: true }).click();
  await expect(dialog.getByRole("link", { name: "Official garden guide", exact: true }).first()).toHaveAttribute("href", "https://example.com/garden");
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("planning-research.png"), fullPage: true });
  await dialog.getByLabel("Research timing for Luxembourg Gardens").uncheck();
  await expect(dialog.getByLabel(/Send selected place names/)).not.toBeChecked();
  await expect(dialog.getByText("Suggested: 120 min", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Apply preferences" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download trip backup" }).click();
  const output = testInfo.outputPath("manual-timing.json");
  await (await download).saveAs(output);
  const backup = JSON.parse(await readFile(output, "utf8"));
  expect(backup.trip.stops[1].duration).toBe(75);
  expect(JSON.stringify(backup)).not.toContain("Official garden guide");
});