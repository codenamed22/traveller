import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { newStop, newTrip, persistedPlan, tripDate, type Trip, type PlanResult } from "../src/lib/trip";
import { liveRouteKey, newDayProgress, recoveryContext, recoveryMinute, remainingIds, type RecoveryRequest, type RecoveryResult } from "../src/lib/day-recovery";

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

test("marks a must-see and sets what kind of place it is", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByLabel("City", { exact: true }).fill("Paris, France");
  await page.getByLabel("New place name").fill("Cafe de Flore");
  await page.getByRole("button", { name: "Add place", exact: true }).click();
  await expect(page.getByLabel("Place type for Cafe de Flore")).toHaveValue("");
  await expect(page.getByLabel("Place type for Cafe de Flore").locator("option").first()).toHaveText("Automatic (Coffee)");
  await page.getByLabel("Place type for Cafe de Flore").selectOption("meal");
  await page.getByRole("checkbox", { name: "Must-see", exact: true }).check();
  await expect(page.locator(".stop-item").first().getByRole("img", { name: "Must-see" })).toBeVisible();
  // A booking keeps its place type; the time of day gives way to the booked time.
  await page.getByLabel("Fixed booking", { exact: true }).check();
  await expect(page.getByLabel("Place type for Cafe de Flore")).toHaveValue("meal");
  await expect(page.getByLabel("Time of day for Cafe de Flore")).toHaveCount(0);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download trip backup" }).click();
  const output = testInfo.outputPath("trip-backup.json");
  await (await downloadPromise).saveAs(output);
  expect(JSON.parse(await readFile(output, "utf8")).trip.stops[0]).toMatchObject({ name: "Cafe de Flore", kind: "meal", priority: 5 });
  await page.getByRole("checkbox", { name: "Must-see", exact: true }).uncheck();
  await expect(page.locator(".stop-item").first().getByRole("img", { name: "Must-see" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("map-status icons remain visible independently of booking locks", async ({ page }, testInfo) => {
  const trip = { ...newTrip(), city: "Paris", hotel: "Hotel", stops: [
    { ...newStop("Confirmed museum"), placeId: "museum-id" },
    newStop("Unconfirmed garden"),
    { ...newStop("Booked theatre"), placeId: "theatre-id", day: 0, fixedTime: "10:00" },
    { ...newStop("Booked unconfirmed gallery with a long name near the riverside"), day: 0, fixedTime: "12:00" },
  ] };
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Connections and settings" }).click();
  await page.getByLabel("Open trip backup").setInputFiles({ name: "status-icons.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ trip })) });
  const rows = page.locator(".stop-summary");
  await expect(rows).toHaveCount(4);
  for (const index of [0, 2]) await expect(rows.nth(index).getByRole("img", { name: "Location confirmed on map", exact: true })).toBeVisible();
  for (const index of [1, 3]) {
    await expect(rows.nth(index).getByRole("img", { name: "Location not confirmed on map", exact: true })).toBeVisible();
    await expect(rows.nth(index).getByTitle("Location not confirmed on map")).toBeVisible();
    await expect(rows.nth(index).locator(".lucide-map-pin-off")).toBeVisible();
  }
  for (const index of [0, 1]) await expect(rows.nth(index).getByRole("img", { name: "Booked appointment" })).toHaveCount(0);
  for (const index of [2, 3]) await expect(rows.nth(index).getByRole("img", { name: "Booked appointment" })).toBeVisible();
  await rows.nth(2).click();
  await page.getByLabel("Place name", { exact: true }).fill("Renamed theatre");
  await expect(rows.nth(2).getByRole("img", { name: "Location not confirmed on map", exact: true })).toBeVisible();
  await expect(rows.nth(2).getByRole("img", { name: "Booked appointment" })).toBeVisible();
  await rows.nth(2).click();
  for (const row of await rows.all()) expect(await row.evaluate((element) => element.querySelector(".stop-heading")!.getBoundingClientRect().right <= element.querySelector(".stop-statuses")!.getBoundingClientRect().left)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("place-status-icons.png"), fullPage: true });
  expect(errors).toEqual([]);
});

for (const duplicate of [{ label: "confirmed", placeId: "sango-place", match: "Same confirmed Google place" }, { label: "unconfirmed", placeId: null, match: "Possible name alias; location needs review" }]) test(`reviews ${duplicate.label} Sango aliases and preserves the chosen booking and both sources`, async ({ page }, testInfo) => {
  const trip = { ...newTrip(), city: "Amsterdam", hotel: "Hotel", startDate: "2026-12-24", stops: [
    { ...newStop("Sango"), placeId: "sango-place", day: 0, fixedTime: "15:13", source: "First itinerary" },
    { ...newStop("Sango Specialty Coffee"), placeId: duplicate.placeId, day: 0, fixedTime: "14:45", source: "Second itinerary" },
  ] };
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Connections and settings" }).click();
  await page.getByLabel("Open trip backup").setInputFiles({ name: "duplicate-places.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ trip })) });
  await page.getByRole("button", { name: "Review duplicates (1)", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Review duplicate places" });
  await expect(dialog.getByText(duplicate.match, { exact: true })).toBeVisible();
  await expect(dialog.getByText("15:13", { exact: true })).toBeVisible();
  await expect(dialog.getByText("14:45", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Merge visits" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Keep both visits" }).click();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator(".stop-item")).toHaveCount(2);
  await page.getByRole("button", { name: "Review duplicates (1)", exact: true }).click();
  await dialog.getByRole("radio", { name: "Keep Sango Specialty Coffee, visit 2", exact: true }).check();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  for (const radio of await dialog.getByRole("radio").all()) {
    const bounds = await radio.boundingBox();
    expect(bounds?.width).toBe(16);
    expect(bounds?.height).toBe(16);
  }
  await dialog.getByRole("heading").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("duplicate-comparison.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(page.locator(".stop-item")).toHaveCount(2);
  await page.getByRole("button", { name: "Review duplicates (1)", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Merge visits" })).toBeDisabled();
  await dialog.getByRole("radio", { name: "Keep Sango Specialty Coffee, visit 2", exact: true }).check();
  await dialog.getByRole("button", { name: "Merge visits" }).click();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator(".stop-item")).toHaveCount(1);
  await page.locator(".stop-summary").click();
  await expect(page.getByLabel("Booked time")).toHaveValue("14:45");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download trip backup" }).click();
  const output = testInfo.outputPath("merged-duplicate.json");
  await (await download).saveAs(output);
  const saved = JSON.parse(await readFile(output, "utf8"));
  expect(saved.trip.stops).toHaveLength(1);
  expect(saved.trip.stops[0]).toMatchObject({ id: trip.stops[1].id, placeId: "sango-place", name: "Sango Specialty Coffee", fixedTime: "14:45", day: 0, duration: 45, source: "Second itinerary\nFirst itinerary" });
  expect(errors).toEqual([]);
});

test("review pasted places and keep AI off without consent", async ({ page }) => {
  const extractionRequests: string[] = [];
  page.on("request", (request) => { if (request.url().endsWith("/api/import")) extractionRequests.push(request.url()); });
  await page.goto("/");
  await expect(page).toHaveTitle("Traveller | Trip planner");
  await expect(page.getByRole("heading", { name: "No places yet", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Connections and settings" }).click();
  const connections = page.getByRole("dialog", { name: "Connections", exact: true });
  await expect(connections).toContainText("Trip storage");
  await expect(connections).not.toContainText(/Neon|environment variables|allowlist/);
  await connections.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("AI import is unavailable.");
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
  for (const path of ["/api/plan", "/api/import", "/api/places", "/api/place-photos", "/api/timing", "/api/day-recovery", "/api/assistant"]) {
    const response = await request.post(path, { data: {} });
    expect([401, 503]).toContain(response.status());
  }
  const response = await request.get("/api/trips");
  expect([401, 503]).toContain(response.status());
  const shared = await request.patch(`/api/trips/${crypto.randomUUID()}`, { data: { shared: true } });
  expect([401, 503]).toContain(shared.status());
});

test("shared trips ask for sign-in and never show a trip to a visitor", async ({ page }) => {
  for (const path of ["/shared", `/shared/${crypto.randomUUID()}`]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Sign in to view shared trips" })).toBeVisible();
    await expect(page.getByText("Google sign-in is not configured yet.")).toBeVisible();
  }
  expect((await page.goto("/shared/not-a-trip"))!.status()).toBe(404);
});

test("place photos stay unavailable without connections and never enter trip backups", async ({ page }, testInfo) => {
  const trip: Trip = { ...newTrip(), city: "Paris", hotel: "Hotel", stops: [
    { ...newStop("Confirmed museum"), placeId: "museum-id" },
    newStop("Unconfirmed garden"),
  ] };
  let photoRequests = 0;
  page.on("request", (request) => { if (request.url().endsWith("/api/place-photos")) photoRequests++; });
  await page.goto("/");
  await page.getByRole("button", { name: "Connections and settings" }).click();
  await page.getByLabel("Open trip backup").setInputFiles({ name: "photo-trip.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ trip })) });

  const confirmed = page.getByRole("button", { name: /Confirmed museum/ });
  await confirmed.click();
  await expect(page.locator(".place-photos-carousel")).toContainText("Photos are unavailable");
  await page.getByRole("button", { name: /Unconfirmed garden/ }).click();
  await expect(page.locator(".place-photos-carousel")).toContainText("Confirm this place to view photos");
  expect(photoRequests).toBe(0);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download trip backup" }).click();
  const download = await downloadPromise;
  const output = testInfo.outputPath("photo-trip-backup.json");
  await download.saveAs(output);
  const backup = JSON.parse(await readFile(output, "utf8"));
  expect(JSON.stringify(backup)).not.toMatch(/photoUri|googleMapsUri|authorAttributions/);
});

test("recovery records progress, checks a selected route, previews and applies only today's decisions", async ({ page }, testInfo) => {
  await page.clock.install({ time: new Date("2026-10-13T12:00:00Z") });
  page.on("dialog", (dialog) => dialog.accept());
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  const trip: Trip = { ...newTrip(), city: "Amsterdam", hotel: "Hotel", hotelPlaceId: "hotel-id", startDate: "2026-10-13", timeZone: "UTC", days: 2, stops: [
    { ...newStop("Coffee"), placeId: "coffee-id", day: 0 },
    { ...newStop("Canal"), placeId: "canal-id", day: 0, duration: 15 },
    { ...newStop("Riverside sculpture garden and contemporary art pavilion"), placeId: "garden-id", day: 0 },
    { ...newStop("Booked museum"), placeId: "museum-id", day: 0, fixedTime: "14:00", duration: 60, buffer: 10 },
    { ...newStop("Tomorrow's park"), placeId: "park-id", day: 1 },
  ] };
  const plan = { days: [{ day: 0, stopIds: trip.stops.slice(0, 4).map((stop) => stop.id) }, { day: 1, stopIds: [trip.stops[4].id] }], omitted: [] };
  const requests: RecoveryRequest[] = [];
  const selectedLeg = { day: 0, from: "current", to: trip.stops[1].id, mode: "TRANSIT" as const, minutes: 20, meters: 500, polyline: "observed-transit", steps: [{ instruction: "Board tram", mode: "TRANSIT" as const, line: "Tram 2", from: "Coffee", to: "Canal" }] };
  await page.route("**/api/day-recovery", async (route) => {
    const body = route.request().postDataJSON() as RecoveryRequest; requests.push(body);
    const departure = recoveryMinute(body.trip, body.day, body.departureAt);
    const result: RecoveryResult = body.mode === "route" ? { status: "route-checked", context: recoveryContext(body), departureAt: body.departureAt, checkedAt: "2026-10-13T12:00:00Z", routes: [{ ...selectedLeg, mode: "WALK", minutes: 10, polyline: "observed-walk", steps: [] }, selectedLeg] } : {
      status: "recovery-checked", context: recoveryContext(body), departureAt: body.departureAt, checkedAt: "2026-10-13T12:00:00Z", options: [{ label: "Shorten Canal and skip garden", durations: { [trip.stops[1].id]: 10, [trip.stops[3].id]: 60 }, skipped: [trip.stops[2].id], day: { day: 0, date: trip.startDate, visits: [
        { stopId: trip.stops[1].id, start: departure + 20, end: departure + 30, leg: selectedLeg },
        { stopId: trip.stops[3].id, start: 840, end: 900, leg: { day: 0, from: trip.stops[1].id, to: trip.stops[3].id, mode: "WALK", minutes: 10, meters: 700 } },
      ], returnLeg: { day: 0, from: trip.stops[3].id, to: "hotel", mode: "TRANSIT", minutes: 20, meters: 2000 } } }],
    };
    await route.fulfill({ json: result });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Connections and settings" }).click();
  await page.getByLabel("Open trip backup").setInputFiles({ name: "recovery.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ trip, plan })) });
  await page.getByRole("button", { name: "Itinerary", exact: true }).click();
  await page.getByRole("button", { name: "Today", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Today", exact: true });
  await dialog.getByRole("button", { name: "Done", exact: true }).first().click();
  await dialog.getByLabel("Actual start", { exact: true }).fill("11:00");
  await dialog.getByLabel("Actual finish", { exact: true }).fill("12:00");
  await dialog.getByRole("button", { name: "Confirm completed visit" }).click();
  await expect(dialog.getByRole("button", { name: "Edit actual times for Coffee", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Edit actual times for Coffee", exact: true }).click();
  await dialog.getByRole("button", { name: "Confirm completed visit" }).click();
  await dialog.getByRole("button", { name: "+20 min", exact: true }).click();
  await dialog.getByLabel("Minimum minutes for Canal", { exact: true }).fill("10");
  await dialog.getByLabel(`Allow skipping ${trip.stops[2].name}`, { exact: true }).check();
  expect(requests).toHaveLength(0);
  await dialog.getByRole("button", { name: "Leave now / Refresh route", exact: true }).click();
  await dialog.getByRole("radio", { name: /Transit · 20 min/ }).check();
  await dialog.getByRole("button", { name: "Use this route", exact: true }).nth(1).click();
  expect(requests).toHaveLength(1);
  await dialog.getByRole("button", { name: "Keep current plan", exact: true }).click();
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(dialog.getByText("Selected next route: Canal", { exact: false })).toBeVisible();
  await dialog.getByLabel("Minimum minutes for Canal", { exact: true }).fill("10");
  await dialog.getByLabel(`Allow skipping ${trip.stops[2].name}`, { exact: true }).check();
  await dialog.getByRole("button", { name: "Replan today", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Use this plan" })).toBeVisible();
  expect(requests[1].preferredRoute).toEqual({ to: selectedLeg.to, key: liveRouteKey(selectedLeg) });
  expect(remainingIds(requests[1].stopIds, requests[1].progress)).toEqual(trip.stops.slice(1, 4).map((stop) => stop.id));
  await expect(dialog.getByText("Shortened from 15 to 10 min", { exact: false })).toBeVisible();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("recovery-preview.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Keep current plan", exact: true }).click();
  const downloadBackup = async (filename: string) => { const download = page.waitForEvent("download"); await page.getByRole("button", { name: "Download trip backup" }).click(); const output = testInfo.outputPath(filename); await (await download).saveAs(output); return JSON.parse(await readFile(output, "utf8")); };
  const cancelled = await downloadBackup("cancelled-recovery.json");
  expect(cancelled.journey.execution[trip.id][trip.startDate].remaining).toBeUndefined();
  expect(cancelled.journey.execution[trip.id][trip.startDate].completed).toEqual([{ stopId: trip.stops[0].id, start: 660, end: 720 }]);
  expect(cancelled.plan).toEqual(plan);
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await dialog.getByLabel("Minimum minutes for Canal", { exact: true }).fill("10");
  await dialog.getByLabel(`Allow skipping ${trip.stops[2].name}`, { exact: true }).check();
  await dialog.getByRole("button", { name: "Replan today", exact: true }).click();
  await dialog.getByRole("button", { name: "Use this plan", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const accepted = await downloadBackup("accepted-recovery.json");
  expect(accepted.trip.stops).toEqual(trip.stops);
  expect(accepted.plan).toEqual(plan);
  const progress = accepted.journey.execution[trip.id][trip.startDate];
  expect(progress.remaining).toMatchObject({ stopIds: [trip.stops[1].id, trip.stops[3].id], durations: { [trip.stops[1].id]: 10 }, skipped: [trip.stops[2].id] });
  expect(progress.remaining.snapshot.day.visits[0].leg).toEqual(selectedLeg);
  expect(progress.remaining.snapshot.origin).toEqual(requests[2].origin);
  await page.getByRole("button", { name: /Day 2/ }).click();
  await expect(page.getByRole("button", { name: "Today", exact: true })).toHaveCount(0);
  await expect(page.locator(".saved-order")).toContainText("Tomorrow's park");
  await page.reload();
  await page.getByRole("button", { name: "Connections and settings" }).click();
  await page.getByLabel("Open trip backup").setInputFiles({ name: "restored-recovery.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(accepted)) });
  await page.getByRole("button", { name: "Itinerary", exact: true }).click();
  await expect(page.locator(".today-summary")).toContainText("Actual 11:00 - 12:00");
  await expect(page.locator(".itinerary-stop").first()).toContainText("Canal");
  await expect(page.locator(".itinerary-stop").first()).toContainText("12:41 - 12:51 · 10 min");
  await expect(page.getByText("Saved day plan", { exact: false })).toBeVisible();
  await expect(page.getByText("Not a live travel check.", { exact: false })).toBeVisible();
  await page.locator(".travel-leg summary").first().click();
  await expect(page.locator(".leg-details").first()).toContainText("Tram 2 Coffee to Canal");
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await dialog.getByRole("button", { name: "Undo last change", exact: true }).click();
  await dialog.getByRole("button", { name: "Keep current plan", exact: true }).click();
  const undone = await downloadBackup("undone-recovery.json");
  expect(undone.journey.execution[trip.id][trip.startDate].remaining).toBeUndefined();
  expect(undone.journey.execution[trip.id][trip.startDate].completed).toEqual(progress.completed);
  expect(requests).toHaveLength(3);
  await page.getByLabel("City timezone", { exact: true }).fill("Europe/");
  await expect(page.locator(".today-summary")).toContainText("Actual 11:00 - 12:00");
  await page.getByLabel("City timezone", { exact: true }).fill("UTC");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("recovery-restored.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("recovery rejects stale approval and requires an explicit fresh replan", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-13T12:00:00Z") });
  const trip: Trip = { ...newTrip(), city: "Amsterdam", hotel: "Hotel", hotelPlaceId: "hotel", startDate: "2026-10-13", timeZone: "UTC", stops: [{ ...newStop("Canal"), placeId: "canal" }] };
  let calls = 0;
  await page.route("**/api/day-recovery", async (route) => {
    calls++; const body = route.request().postDataJSON() as RecoveryRequest; const minute = recoveryMinute(trip, 0, body.departureAt);
    const checkedAt = await page.evaluate(() => new Date().toISOString());
    await route.fulfill({ json: { status: "recovery-checked", context: recoveryContext(body), checkedAt, departureAt: body.departureAt, options: [{ label: "Keep Canal", durations: { [trip.stops[0].id]: 45 }, skipped: [], day: { day: 0, date: trip.startDate, visits: [{ stopId: trip.stops[0].id, start: minute + 10, end: minute + 55, leg: { day: 0, from: "current", to: trip.stops[0].id, mode: "WALK", minutes: 10, meters: 700 } }], returnLeg: { day: 0, from: trip.stops[0].id, to: "hotel", mode: "WALK", minutes: 10, meters: 700 } } }] } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Connections and settings" }).click();
  await page.getByLabel("Open trip backup").setInputFiles({ name: "stale-recovery.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ trip, plan: { days: [{ day: 0, stopIds: [trip.stops[0].id] }], omitted: [] } })) });
  await page.getByRole("button", { name: "Itinerary", exact: true }).click();
  await page.getByRole("button", { name: "Today", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Today", exact: true });
  await dialog.getByRole("button", { name: "Replan today", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Use this plan" })).toBeVisible();
  await page.clock.runFor(180_000);
  await dialog.getByRole("button", { name: "Use this plan" }).click();
  await expect(dialog.getByRole("alert")).toContainText("preview is stale");
  expect(calls).toBe(1);
  await dialog.getByRole("button", { name: "Replan today", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Use this plan" }).click();
  await expect(dialog).toHaveCount(0);
  expect(calls).toBe(2);
});

test("recovery ignores superseded responses and handles denied device location without paid work", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-13T12:00:00Z") });
  await page.addInitScript(() => { navigator.geolocation.getCurrentPosition = (_success, failure) => failure?.({ code: 1, message: "Denied", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }); });
  const trip: Trip = { ...newTrip(), city: "Amsterdam", hotel: "Hotel", hotelPlaceId: "hotel", startDate: "2026-10-13", timeZone: "UTC", stops: [{ ...newStop("Canal"), placeId: "canal" }] };
  let calls = 0;
  let release: (() => void) | undefined;
  await page.route("**/api/day-recovery", async (route) => {
    calls++; const body = route.request().postDataJSON() as RecoveryRequest;
    await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({ json: { status: "unresolved", context: recoveryContext(body), checkedAt: body.departureAt, departureAt: body.departureAt, message: "Superseded provider response" } }).catch(() => {});
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Connections and settings" }).click();
  await page.getByLabel("Open trip backup").setInputFiles({ name: "abort-recovery.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ trip, plan: { days: [{ day: 0, stopIds: [trip.stops[0].id] }], omitted: [] } })) });
  await page.getByRole("button", { name: "Itinerary", exact: true }).click();
  await page.getByRole("button", { name: "Today", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Today", exact: true });
  await dialog.getByRole("button", { name: "Use device location", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("denied or unavailable");
  expect(calls).toBe(0);
  await dialog.getByRole("button", { name: "Replan today", exact: true }).click();
  await expect.poll(() => calls).toBe(1);
  await dialog.getByRole("button", { name: "+10 min", exact: true }).click();
  release!();
  await expect(dialog.getByRole("button", { name: "Replan today", exact: true })).toBeEnabled();
  await expect(dialog.getByText("Superseded provider response")).toHaveCount(0);
  expect(calls).toBe(1);
  await dialog.getByRole("button", { name: "Keep current plan", exact: true }).click();
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
  await page.getByLabel("Places or itinerary").fill("Louvre Museum\nLuxembourg Gardens\nMusee d'Orsay\nluxembourg   gardens");
  await page.getByRole("button", { name: "Review place list" }).click();
  await expect(page.getByLabel("Include Louvre Museum")).not.toBeChecked();
  await expect(page.getByText("Possible duplicate", { exact: true })).toHaveCount(2);
  const review = page.getByRole("dialog", { name: "Review imported places" });
  await expect(review.getByRole("status")).toHaveText("2 possible duplicates found in this city or import. All excluded from this import.");
  await page.getByLabel("Select all places").check();
  await expect(page.getByRole("button", { name: "Confirm 4 places", exact: true })).toBeDisabled();
  await expect(review.getByRole("status")).toContainText("2 selected for another visit.");
  await page.getByRole("button", { name: "Skip duplicates", exact: true }).click();
  await expect(page.getByLabel("Include Louvre Museum")).not.toBeChecked();
  await expect(review.getByRole("status")).toContainText("All excluded");
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

test("import duplicates require explicit approval again after edits", async ({ page }, testInfo) => {
  const errors: string[] = [];
  const requests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (request.url().endsWith("/api/import")) requests.push(request.url()); });
  await page.goto("/");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByLabel("Places or itinerary").fill("Museum\nMUSEUM\nGarden");
  await page.getByRole("button", { name: "Review place list" }).click();
  const review = page.getByRole("dialog", { name: "Review imported places" });
  const confirmation = review.getByLabel("Include selected duplicates as separate visits");
  const accept = review.getByRole("button", { name: "Confirm 3 places", exact: true });
  await expect(review.getByRole("status")).toContainText("1 possible duplicate");
  await review.getByLabel("Select all places").check();
  await expect(accept).toBeDisabled();
  await confirmation.check();
  await expect(accept).toBeEnabled();
  await review.getByLabel("Place", { exact: true }).nth(2).fill("museum");
  await expect(review.getByRole("status")).toContainText("2 possible duplicates");
  await expect(confirmation).not.toBeChecked();
  await expect(accept).toBeDisabled();
  await review.getByLabel("Place", { exact: true }).nth(2).fill("Garden");
  await confirmation.check();
  await review.getByLabel("Visit minutes", { exact: true }).nth(1).fill("90");
  await expect(confirmation).not.toBeChecked();
  await expect(accept).toBeDisabled();
  await confirmation.check();
  expect(await review.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await review.getByRole("heading").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("duplicate-review.png"), fullPage: true });
  await accept.click();
  await expect(review).toHaveCount(0);
  await expect(page.locator(".stop-item")).toHaveCount(3);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download trip backup" }).click();
  const output = testInfo.outputPath("deliberate-repeat.json");
  await (await download).saveAs(output);
  const { trip } = JSON.parse(await readFile(output, "utf8"));
  expect(trip.stops.map((stop: { name: string }) => stop.name)).toEqual(["Museum", "MUSEUM", "Garden"]);
  expect(trip.stops[1].duration).toBe(90);
  expect(new Set(trip.stops.map((stop: { id: string }) => stop.id)).size).toBe(3);
  expect(errors).toEqual([]);
  expect(requests).toEqual([]);
});

test("duplicate updates require fresh approval and reject invalid details", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByLabel("Start date").fill("2026-10-12");
  await page.getByLabel("New place name").fill("Museum");
  await page.getByRole("button", { name: "Add place", exact: true }).click();
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByLabel("Places or itinerary").fill("Museum");
  await page.getByRole("button", { name: "Review place list" }).click();
  const review = page.getByRole("dialog", { name: "Review imported places" });
  await review.getByLabel("Date", { exact: true }).fill("2026-11-01");
  await review.getByLabel("Booked time").fill("10:00");
  await expect(review.getByText(/duplicate date is outside/)).toBeVisible();
  await expect(review.getByLabel("Apply these duplicate updates")).toHaveCount(0);
  await review.getByLabel("Date", { exact: true }).fill("2026-10-13");
  await expect(review.getByRole("button", { name: "Confirm 0 places" })).toBeDisabled();
  const approval = review.getByLabel("Apply these duplicate updates");
  await approval.check();
  await review.getByLabel("Visit minutes").fill("-5");
  await expect(approval).toHaveCount(0);
  await expect(review.getByText(/invalid duplicate details/)).toBeVisible();
  await review.getByLabel("Visit minutes").fill("90");
  await expect(approval).not.toBeChecked();
  await approval.check();
  await review.getByLabel("Booked time").fill("10:30");
  await expect(approval).not.toBeChecked();
  await approval.check();
  expect(await review.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("merge-proposal.png"), fullPage: true });
  await review.getByRole("button", { name: "Update 1 existing place", exact: true }).click();
  await expect(review).toHaveCount(0);
  await expect(page.getByLabel("Visit minutes")).toHaveValue("45");
  await expect(page.getByLabel("Assigned day")).toHaveValue("1");
  await expect(page.getByLabel("Booked time")).toHaveValue("10:30");
  expect(errors).toEqual([]);
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
  const trip = { ...newTrip(), city: "Paris", hotel: "Hotel", stops: Array.from({ length: 59 }, (_, index) => ({ ...newStop(`Place ${index + 1} ${"a".repeat(170)}`), source: "a".repeat(1000), sourceUrl: index === 0 ? sourceUrl : `${sourceUrl}&context=${"a".repeat(2900)}` })) };
  const backup = Buffer.from(JSON.stringify({ trip }));
  expect(backup.byteLength).toBeGreaterThan(100_000);
  await page.goto("/");
  await page.getByRole("button", { name: "Connections and settings" }).click();
  await page.getByLabel("Open trip backup").setInputFiles({ name: "ideas.json", mimeType: "application/json", buffer: backup });
  await expect(page.locator(".stop-item")).toHaveCount(59);
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
  await expect(page.locator(".stop-item")).toHaveCount(60);
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
  await expect(search.getByRole("alert")).toHaveText("Place search is unavailable. Check your sign-in and connections.");
  expect(requests).toEqual([]);
});

async function openPlanningTrip(page: Page, hotel = "Private hotel", stops?: Trip["stops"], patch: Partial<Trip> = {}) {
  const trip: Trip = {
    ...newTrip(), city: "Paris", hotel, hotelPlaceId: hotel ? "hotel-id" : null, startDate: "2026-10-12", timeZone: "Europe/Paris", days: 2,
    stops: stops ?? [{ ...newStop("Louvre Museum"), placeId: "museum-id", day: 0, fixedTime: "10:30" }, { ...newStop("Luxembourg Gardens"), placeId: "garden-id" }],
    ...patch,
  };
  await page.goto("/");
  await page.getByRole("button", { name: "Connections and settings" }).click();
  await page.getByLabel("Open trip backup").setInputFiles({ name: "planning.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ journey: { id: trip.id, title: trip.title, cities: [trip], plans: {} } })) });
  await expect(page.locator(".stop-item")).toHaveCount(trip.stops.length);
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

test("refresh travel times retains saved order and requires approval without optimization", async ({ page }, testInfo) => {
  page.on("dialog", (dialog) => dialog.accept());
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  const trip: Trip = { ...newTrip(), city: "Paris", hotel: "Hotel", hotelPlaceId: "hotel", startDate: "2026-10-12", timeZone: "Europe/Paris", days: 2,
    stops: [{ ...newStop("Booked museum"), placeId: "museum", day: 0, fixedTime: "10:30" }, { ...newStop("Park"), placeId: "park" }] };
  const original = previewFixture(trip);
  const plan = persistedPlan(original.schedule, trip, original.places);
  const requests: { mode: string; plan: unknown; trip: Trip }[] = [];
  let fail = false;
  await page.route("**/api/plan", async (route) => {
    const body = route.request().postDataJSON(); requests.push(body);
    expect(body.mode).toBe("refresh");
    if (fail) { await route.fulfill({ status: 422, json: { error: "Refreshed travel does not fit the saved itinerary. Your saved plan was kept." } }); return; }
    const refreshed = structuredClone(original);
    refreshed.schedule.generatedAt = "2026-10-13T09:00:00Z";
    refreshed.schedule.days[0].visits[1].leg.minutes += 20;
    refreshed.schedule.days[0].visits[1].start += 20; refreshed.schedule.days[0].visits[1].end += 20;
    await route.fulfill({ json: refreshed });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Connections and settings" }).click();
  await page.getByLabel("Open trip backup").setInputFiles({ name: "refresh.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ trip, plan })) });
  await page.getByRole("button", { name: /^Itinerary/ }).click();
  const downloadBackup = async (filename: string) => { const download = page.waitForEvent("download"); await page.getByRole("button", { name: "Download trip backup" }).click(); const output = testInfo.outputPath(filename); await (await download).saveAs(output); return JSON.parse(await readFile(output, "utf8")); };
  await page.getByRole("button", { name: "Refresh travel times", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Refresh travel times", exact: true });
  await expect(dialog.getByLabel("Refreshed itinerary preview")).toContainText("Park");
  await expect(dialog.getByRole("button", { name: "Use refreshed times" })).toBeVisible();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("refresh-preview.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Keep saved itinerary" }).click();
  expect((await downloadBackup("cancelled-refresh.json")).plan).toEqual(plan);
  fail = true;
  await page.getByRole("button", { name: "Refresh travel times", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Your saved plan was kept");
  await expect(dialog.getByRole("button", { name: "Use refreshed times" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Replan itinerary" })).toBeVisible();
  await dialog.getByRole("button", { name: "Keep saved itinerary" }).click();
  expect((await downloadBackup("failed-refresh.json")).plan).toEqual(plan);
  fail = false;
  await page.getByRole("button", { name: "Refresh travel times", exact: true }).click();
  await dialog.getByRole("button", { name: "Use refreshed times" }).click();
  const accepted = await downloadBackup("accepted-refresh.json");
  expect(accepted.plan.days).toEqual(plan.days);
  expect(accepted.trip).toEqual(trip);
  expect(accepted.plan.snapshot.schedule.days[0].visits[1].start).toBe(original.schedule.days[0].visits[1].start + 20);
  expect(accepted.plan.snapshot.schedule.days[0].visits[0].start).toBe(630);
  expect(requests).toHaveLength(3);
  expect(requests.every((request) => request.mode === "refresh" && JSON.stringify(request.plan) === JSON.stringify(plan))).toBe(true);
  expect(errors).toEqual([]);
});

test("itinerary persistence restores timings and complete routes without regeneration", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let calls = 0;
  let generated: PlanResult | undefined;
  await page.route("**/api/plan", async (route) => {
    calls++;
    const candidate = route.request().postDataJSON().trip as Trip;
    generated = previewFixture(candidate);
    const first = generated.schedule.days[0].visits[0];
    first.leg = { ...first.leg, mode: "TRANSIT", polyline: "_p~iF~ps|U_ulLnnqC_mqNvxq`@", fare: "EUR 2.50", sampledDeparture: 620,
      estimated: true, timetableDate: "2026-10-12", steps: [{ instruction: "Take the metro", mode: "TRANSIT", line: "M1", from: "Hotel station", to: "Museum station", departure: "10:20", arrival: "10:30" }],
      alternatives: [{ ...first.leg, polyline: "_p~iF~ps|U_ulLnnqC_mqNvxq`@" }] };
    generated.places = Object.fromEntries([ ["hotel", { id: candidate.hotelPlaceId!, name: candidate.hotel, address: "Paris", location: { lat: 48.85, lng: 2.35 } }],
      ...candidate.stops.map((stop) => [stop.id, { id: stop.placeId!, name: stop.name, address: "Paris", location: { lat: 48.86, lng: 2.34 } }]) ]);
    await route.fulfill({ json: generated });
  });
  const trip = await openPlanningTrip(page);
  const dialog = page.getByRole("dialog", { name: "Plan my days", exact: true });
  await dialog.getByRole("button", { name: "Optimize preview" }).click();
  await dialog.getByRole("button", { name: "Use this plan" }).click();
  await expect(dialog).toHaveCount(0);
  const timings = await page.locator(".itinerary-stop").allTextContents();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download trip backup" }).click();
  const path = testInfo.outputPath("timed-itinerary.json");
  await (await download).saveAs(path);
  const backup = JSON.parse(await readFile(path, "utf8"));
  expect(backup.plan.snapshot.schedule).toEqual(generated!.schedule);
  expect(backup.plan.snapshot.places).toEqual(generated!.places);
  await page.reload();
  await page.getByRole("button", { name: "Connections and settings" }).click();
  await page.getByLabel("Open trip backup").setInputFiles(path);
  await expect(page.locator(".stop-item")).toHaveCount(trip.stops.length);
  await page.getByRole("button", { name: /^Itinerary/ }).click();
  await expect(page.locator(".itinerary-stop")).toHaveText(timings);
  await expect(page.getByText("Not a live travel check.", { exact: false })).toBeVisible();
  await page.locator(".travel-leg summary").first().click();
  await expect(page.locator(".leg-details").first()).toContainText("M1 Hotel station to Museum station");
  await expect(page.locator(".leg-details").first()).toContainText("Estimated fare: EUR 2.50");
  await expect(page.locator(".travel-leg summary").first()).toContainText("timetable of 2026-10-12");
  await expect(page.locator(".itinerary-start").last()).toContainText("Back to Private hotel");
  expect(calls).toBe(1);
  // A note shows on the itinerary without making it out of date.
  await page.getByRole("button", { name: /^Places/ }).click();
  await page.locator(".stop-summary").first().click();
  await page.getByLabel("Notes").fill("Light trail ended in 2025; find a replacement.");
  await page.getByRole("button", { name: /^Itinerary/ }).click();
  await expect(page.locator(".itinerary-stop .stop-note")).toHaveText(["Light trail ended in 2025; find a replacement."]);
  await expect(page.getByText("This itinerary is out of date.", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: /^Places/ }).click();
  await page.getByLabel("Notes").fill("");
  // As does what a guide says about it, under the place once it's chosen.
  await page.getByText("About this place").click();
  await page.getByLabel("What it is").fill("The former royal palace, now the national art museum.");
  await page.getByLabel("What to do").fill("See the Winged Victory first.");
  await page.getByRole("button", { name: /^Itinerary/ }).click();
  await page.locator(".itinerary-stop").first().click();
  await expect(page.locator(".itinerary-content .place-about")).toHaveText("What it isThe former royal palace, now the national art museum.What to doSee the Winged Victory first.");
  await expect(page.getByText("This itinerary is out of date.", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: /^Places/ }).click();
  // So does making a place already in it a must-see.
  await page.getByRole("checkbox", { name: "Must-see", exact: true }).check();
  await page.getByRole("button", { name: /^Itinerary/ }).click();
  await expect(page.locator(".itinerary-stop").first().getByRole("img", { name: "Must-see" })).toBeVisible();
  await expect(page.getByText("This itinerary is out of date.", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: /^Places/ }).click();
  await page.getByRole("checkbox", { name: "Must-see", exact: true }).uncheck();
  await page.getByRole("button", { name: /^Itinerary/ }).click();
  await expect(page.locator(".itinerary-stop")).toHaveText(timings);
  await expect(page.locator(".confirmed-hotel")).toContainText("Private hotel");
  await page.getByLabel("Hotel or starting point").fill("Another hotel");
  await expect(page.locator(".confirmed-hotel")).toHaveCount(0);
  await expect(page.locator(".itinerary-start").last()).toContainText("Back to Private hotel");
  await page.getByLabel("City timezone").fill("UTC");
  await expect(page.getByText("This itinerary is out of date. Plan again after your changes.")).toBeVisible();
  await expect(page.locator(".itinerary-stop")).toHaveText(timings);
  const retainedDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download trip backup" }).click();
  const retainedPath = testInfo.outputPath("retained-timed-itinerary.json");
  await (await retainedDownload).saveAs(retainedPath);
  expect(JSON.parse(await readFile(retainedPath, "utf8")).plan).toEqual(backup.plan);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("saved-itinerary.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("exports the accepted itinerary as a printable page, Excel workbook and calendar", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.context().addInitScript(() => { window.print = () => undefined; });
  await page.route("**/api/plan", async (route) => {
    const candidate = route.request().postDataJSON().trip as Trip;
    const generated = previewFixture(candidate);
    generated.places = Object.fromEntries([["hotel", { id: "hotel-id", name: candidate.hotel, address: "1 Rue de Rivoli, Paris", location: { lat: 48.85, lng: 2.35 } }],
      ...candidate.stops.map((stop) => [stop.id, { id: stop.placeId!, name: stop.name, address: `${stop.name}, Paris`, location: { lat: 48.86, lng: 2.34 } }])]);
    await route.fulfill({ json: generated });
  });
  await openPlanningTrip(page);
  const dialog = page.getByRole("dialog", { name: "Plan my days", exact: true });
  const exportButton = page.getByRole("button", { name: "Export itinerary" });
  await expect(exportButton).toBeDisabled();
  await dialog.getByRole("button", { name: "Optimize preview" }).click();
  await dialog.getByRole("button", { name: "Use this plan" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(exportButton).toBeEnabled();

  await exportButton.click();
  await page.screenshot({ path: testInfo.outputPath("export-menu.png") });
  const workbook = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: /Excel/ }).click();
  const xlsx = await workbook;
  expect(xlsx.suggestedFilename()).toMatch(/\.xlsx$/);
  const xlsxPath = testInfo.outputPath("itinerary.xlsx");
  await xlsx.saveAs(xlsxPath);
  expect((await readFile(xlsxPath)).subarray(0, 2).toString()).toBe("PK");
  await expect(page.getByRole("menu", { name: "Export itinerary" })).toHaveCount(0);

  await exportButton.click();
  const calendar = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: /Calendar/ }).click();
  const icsPath = testInfo.outputPath("itinerary.ics");
  await (await calendar).saveAs(icsPath);
  const ics = await readFile(icsPath, "utf8");
  expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
  expect(ics).toContain("SUMMARY:Louvre Museum (booked)");
  expect(ics).toContain("DTSTART:20261012T083000Z");

  await exportButton.click();
  const popup = page.waitForEvent("popup");
  await page.getByRole("menuitem", { name: /PDF/ }).click();
  const printable = await popup;
  await printable.waitForLoadState();
  await expect(printable.getByRole("button", { name: "Save as PDF / Print" })).toBeVisible();
  await expect(printable.locator("h2")).toContainText("Paris");
  await expect(printable.locator(".visit").first()).toContainText("Louvre Museum");
  await expect(printable.getByText("Back at Private hotel around", { exact: false })).toBeVisible();
  await printable.close();

  await exportButton.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "Export itinerary" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("arrival and departure narrow the first and last day and appear in the itinerary", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const submitted: Trip[] = [];
  await page.route("**/api/plan", async (route) => {
    const candidate = route.request().postDataJSON().trip as Trip;
    submitted.push(candidate);
    const generated = previewFixture(candidate);
    // Day 1 starts at 15:05 (minute 905) after a 13:20 landing.
    let cursor = 905;
    generated.schedule.days[0].visits = generated.schedule.days[0].visits.map((visit) => { const start = cursor + 10; cursor = start + (visit.end - visit.start); return { ...visit, start, end: cursor }; });
    // The plan routes the airport to the hotel: 35 min by train, not the 45 assumed.
    if (candidate.arrival) generated.schedule.days[0].arrivalLeg = { day: 0, from: "arrival", to: "hotel", mode: "TRANSIT", minutes: 35, meters: 26_000, steps: [{ instruction: "Train", mode: "TRANSIT", line: "RER B", from: "Aéroport CDG 2", to: "Châtelet" }] };
    if (candidate.departure?.taxi) generated.schedule.days[1].departureLeg = { day: 1, from: "hotel", to: "departure", mode: "DRIVE", minutes: 20, meters: 4_100 };
    generated.places = { arrival: { id: "cdg-id", name: "Paris Charles de Gaulle", address: "95700 Roissy-en-France", location: { lat: 49.009, lng: 2.547 } }, departure: { id: "gare-id", name: "Gare du Nord", address: "18 Rue de Dunkerque, Paris", location: { lat: 48.88, lng: 2.355 } } };
    await route.fulfill({ json: generated });
  });
  await openPlanningTrip(page, "Private hotel", [{ ...newStop("Louvre Museum"), placeId: "museum-id", duration: 90 }, { ...newStop("Luxembourg Gardens"), placeId: "garden-id", duration: 60 }]);
  await page.getByRole("dialog", { name: "Plan my days", exact: true }).getByRole("button", { name: "Close dialog" }).click();
  // City details starts expanded.
  const arriving = page.locator("fieldset", { has: page.getByText("Arriving", { exact: true }) });
  await arriving.getByLabel("Arriving by").selectOption("FLIGHT");
  await arriving.getByLabel("Lands").fill("13:20");
  await arriving.getByLabel("Flight", { exact: true }).fill("AF 1234");
  await arriving.getByLabel("Airport", { exact: true }).fill("Paris Charles de Gaulle");
  await expect(arriving.getByLabel("Immigration & bags (min)")).toHaveAttribute("placeholder", "45");
  await expect(arriving.getByRole("status")).toHaveText("Sightseeing starts about 15:05 on Mon 12 Oct (lands 13:20, 45 min at the airport, 45 min to the hotel, 15 min to drop bags).");
  // The airport can be confirmed from a map search, as the departure station can (search needs Google connections).
  await arriving.getByRole("button", { name: "Find airport on map" }).click();
  const airportSearch = page.getByRole("dialog", { name: "Find your airport or station" });
  await expect(airportSearch.getByLabel("Place or address")).toHaveValue(/Paris Charles de Gaulle/);
  await airportSearch.getByRole("button", { name: "Close dialog" }).click();
  const leaving = page.locator("fieldset", { has: page.getByText("Leaving on day 2", { exact: true }) });
  await leaving.getByLabel("Leaving by").selectOption("TRAIN");
  await leaving.getByLabel("Departs").fill("17:00");
  await leaving.getByLabel("Station or stop").fill("Gare du Nord");
  await leaving.getByLabel("Hotel to station, if no route (min)").fill("25");
  await expect(leaving.getByRole("status")).toHaveText("Visits end about 16:00 on Tue 13 Oct (back at the hotel for bags, leave 16:15, 25 min to the station, 20 min there before 17:00).");
  await leaving.getByLabel("Check out in the morning and go straight there from the last visit").check();
  await expect(leaving.getByRole("status")).toHaveText("Confirm Gare du Nord on the map to plan the last leg straight there.");
  await leaving.getByRole("button", { name: "Find station on map" }).click();
  const search = page.getByRole("dialog", { name: "Find your airport or station" });
  await expect(search.getByLabel("Place or address")).toHaveValue(/Gare du Nord/);
  await search.getByRole("button", { name: "Close dialog" }).click();
  await leaving.getByLabel("Check out in the morning and go straight there from the last visit").uncheck();
  // An early flight or train, before public transport runs, can be reached by car or taxi instead.
  await expect(leaving.getByLabel("To the station by")).toHaveValue("TRANSIT");
  await leaving.getByLabel("To the station by").selectOption("TAXI");
  await page.screenshot({ path: testInfo.outputPath("arrival-departure.png"), fullPage: true });

  await page.getByRole("button", { name: "Plan my days", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Plan my days", exact: true });
  await dialog.getByRole("button", { name: "Optimize preview" }).click();
  await dialog.getByRole("button", { name: "Use this plan" }).click();
  await expect(dialog).toHaveCount(0);
  expect(submitted.at(-1)).toMatchObject({ arrival: { mode: "FLIGHT", time: "13:20", place: "Paris Charles de Gaulle", reference: "AF 1234" }, departure: { mode: "TRAIN", time: "17:00", transferMinutes: 25, taxi: true } });
  await page.getByRole("button", { name: /^Itinerary/ }).click();
  await expect(page.getByLabel("Arrival")).toContainText("Land at Paris Charles de Gaulle 13:20 · AF 1234");
  await expect(page.getByLabel("Arrival")).toContainText("At Private hotel about 14:40");
  const arrivalLeg = page.locator(".travel-leg").first();
  await expect(arrivalLeg).toContainText("Public transit · 35 min");
  await arrivalLeg.locator("summary").click();
  await expect(arrivalLeg).toContainText("RER B Aéroport CDG 2 to Châtelet");
  // The city's public transport app is a tap away on a transit leg, until the traveller picks their own.
  await expect(arrivalLeg.getByRole("link", { name: "Open Bonjour RATP" })).toHaveAttribute("href", "https://apps.apple.com/app/id507107090");
  const around = page.locator("fieldset", { has: page.getByText("Getting around", { exact: true }) });
  await expect(around.getByLabel("Transport app")).toHaveAttribute("placeholder", "Bonjour RATP");
  await around.getByLabel("Transport app").fill("IDFM");
  await around.getByLabel("App link").fill("https://www.iledefrance-mobilites.fr/");
  await expect(arrivalLeg.getByRole("link", { name: "Open IDFM" })).toHaveAttribute("href", "https://www.iledefrance-mobilites.fr/");
  // A card starts from how Paris charges.
  await around.getByRole("button", { name: "Add a transport card" }).click();
  await expect(around.getByLabel("Card name")).toHaveValue("Navigo Easy");
  await expect(around.getByLabel("Pay with")).toHaveValue("balance");
  await expect(around.getByLabel("Fare per ride")).toHaveValue("2.55");
  await expect(around.getByLabel("Day pass")).toHaveValue("12.3");
  await around.getByLabel("Travellers").selectOption("2");
  await expect(around.getByLabel("Travellers")).toHaveValue("2");
  // A price emptied on the way to another stays empty while it's typed.
  await around.getByLabel("Fare per ride").fill("");
  await around.getByLabel("Fare per ride").pressSequentially("2.6");
  await expect(around.getByLabel("Fare per ride")).toHaveValue("2.6");
  await expect(page.locator(".itinerary-start").filter({ hasText: "Depart" })).toContainText("Depart 14:55");
  // The routed time replaces the assumed 45 min; the typed minutes stay as the fallback.
  await expect(arriving.getByRole("status")).toHaveText("Sightseeing starts about 14:55 on Mon 12 Oct (lands 13:20, 45 min at the airport, 35 min to the hotel, 15 min to drop bags).");
  await page.screenshot({ path: testInfo.outputPath("arrival-itinerary.png"), fullPage: true });
  // A taxi to the station links Uber, from the hotel to the station.
  await page.getByRole("button", { name: /^Day 2/ }).click();
  const taxiLeg = page.locator(".travel-leg").filter({ hasText: "Car or taxi" });
  await taxiLeg.locator("summary").click();
  const uber = new URL((await taxiLeg.getByRole("link", { name: "Uber" }).getAttribute("href"))!);
  expect([uber.hostname, uber.searchParams.get("dropoff[nickname]")]).toEqual(["m.uber.com", "Gare du Nord"]);
  await expect(taxiLeg.getByRole("link", { name: "Open IDFM" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a direct departure ends the last day at the confirmed station", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/plan", async (route) => {
    const candidate = route.request().postDataJSON().trip as Trip;
    const generated = previewFixture(candidate);
    generated.schedule.days = generated.schedule.days.slice(0, 1);
    generated.places = { hotel: { id: "hotel-id", name: "Private hotel", address: "", location: { lat: 48.85, lng: 2.35 } }, departure: { id: "gare-id", name: "Gare du Nord", address: "18 Rue de Dunkerque, Paris", location: { lat: 48.88, lng: 2.355 } } };
    await route.fulfill({ json: generated });
  });
  await openPlanningTrip(page, "Private hotel", [{ ...newStop("Coffee"), placeId: "coffee-id", duration: 45 }], { days: 1, returnToHotel: true, departure: { mode: "TRAIN", time: "17:00", place: "Gare du Nord", placeId: "gare-id", direct: true } });
  const dialog = page.getByRole("dialog", { name: "Plan my days", exact: true });
  await dialog.getByRole("button", { name: "Optimize preview" }).click();
  await dialog.getByRole("button", { name: "Use this plan" }).click();
  await expect(dialog).toHaveCount(0);
  const leaving = page.locator("fieldset", { has: page.getByText("Leaving", { exact: true }) });
  await expect(leaving.getByRole("status")).toHaveText("Check out in the morning; the last visit on Mon 12 Oct is planned so you reach Gare du Nord by 16:40, 20 min before 17:00.");
  await expect(leaving.getByLabel("Hotel to station, if no route (min)")).toHaveCount(0);
  await page.getByRole("button", { name: /^Itinerary/ }).click();
  await expect(page.getByText("At Gare du Nord", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Departure")).toContainText("Checked out; at Gare du Nord by 16:40");
  expect(errors).toEqual([]);
});

test("day trips held to one day by their places' days offer to let the planner choose", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openPlanningTrip(page, "Hotel", [
    { ...newStop("Belfry"), placeId: "belfry", day: 0 },
    { ...newStop("Markt light trail"), placeId: "markt", day: 0 },
    { ...newStop("Louvre Museum"), placeId: "museum-id" },
  ]);
  const dialog = page.getByRole("dialog", { name: "Plan my days", exact: true });
  await dialog.getByRole("button", { name: "Add day trip" }).click();
  await dialog.getByLabel("Day-trip name 1").fill("Bruges");
  await dialog.getByLabel("Include Belfry in Bruges").check();
  await dialog.getByLabel("Include Markt light trail in Bruges").check();
  const group = dialog.getByRole("group", { name: "Bruges group" });
  await expect(group.getByRole("status")).toHaveText("2 of its places are set to Day 1, so Bruges can only go on Day 1. Let the planner pick the day");
  await group.getByRole("button", { name: "Let the planner pick the day" }).click();
  await expect(group.getByRole("status")).toHaveCount(0);
  await expect(group.getByText("/ Day 1")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("day-trip groups distinguish provisional outlines from approved itineraries", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const submitted: Trip[] = [];
  let provisional = true;
  await page.route("**/api/plan", async (route) => {
    const body = route.request().postDataJSON();
    if (body.mode === "check") { await route.fulfill({ json: { connections: [], warnings: [] } }); return; }
    const trip = body.trip as Trip;
    submitted.push(trip);
    const group = trip.dayGroups![0];
    if (provisional) {
      await route.fulfill({ json: { status: "provisional", verified: false, code: "missing-data", message: "Return transit has not been found in the sampled departures.", outline: [{ groupId: group.id, stopIds: group.stopIds, allowedDays: group.allowedDays }, ...trip.stops.filter((stop) => !group.stopIds.includes(stop.id)).map((stop) => ({ stopIds: [stop.id], allowedDays: [0] }))], unresolved: [{ groupId: group.id, day: 1, direction: "return", outcome: "noRoute" }], warnings: ["Untimed outline only. No saved itinerary was changed."] } });
      return;
    }
    const result = previewFixture({ ...trip, stops: trip.stops.filter((stop) => !group.stopIds.includes(stop.id)) });
    const dayTrip = previewFixture({ ...trip, stops: trip.stops.filter((stop) => group.stopIds.includes(stop.id)) }).schedule.days[0];
    result.schedule.days[1] = { ...dayTrip, day: 1, date: tripDate(trip, 1), visits: dayTrip.visits.map((visit) => ({ ...visit, leg: { ...visit.leg, day: 1 } })), returnLeg: { ...dayTrip.returnLeg!, day: 1 } };
    await route.fulfill({ json: result });
  });
  const trip = await openPlanningTrip(page, "Hotel", [
    { ...newStop("Amsterdam museum"), placeId: "museum", day: 0, fixedTime: "10:30" },
    { ...newStop("Oudegracht canal walk"), placeId: "canal" },
    { ...newStop("Stadskasteel Oudaen lunch"), placeId: "lunch" },
  ]);
  const dialog = page.getByRole("dialog", { name: "Plan my days", exact: true });
  const addGroup = async () => {
    await dialog.getByRole("button", { name: "Add day trip" }).click();
    await dialog.getByLabel("Day-trip name 1").fill("Utrecht");
    await dialog.getByLabel("Include Oudegracht canal walk in Utrecht").check();
    await dialog.getByLabel("Include Stadskasteel Oudaen lunch in Utrecht").check();
    await dialog.getByLabel("Day 1 allowed for Utrecht").uncheck();
    await expect(dialog.getByLabel("Exclusive day for Utrecht")).toBeChecked();
  };
  const downloadBackup = async (name: string) => {
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download trip backup" }).click();
    const path = testInfo.outputPath(name);
    await (await download).saveAs(path);
    return JSON.parse(await readFile(path, "utf8"));
  };
  await addGroup();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.getByRole("group", { name: "Utrecht group" }).screenshot({ path: testInfo.outputPath("day-trip-groups.png") });
  await dialog.getByRole("button", { name: "Optimize preview" }).click();
  await expect(dialog.getByLabel("Provisional itinerary outline")).toContainText("Return travel: No route found at the checked departure times");
  await expect(dialog.getByRole("heading", { name: "Plan my days", exact: true })).toBeInViewport();
  await expect(dialog.getByRole("button", { name: "Use this plan" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Approve changes" })).toHaveCount(0);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("day-trip-provisional.png"), fullPage: true });
  expect(submitted[0].dayGroups![0]).toMatchObject({ name: "Utrecht", allowedDays: [1], exclusive: true, stopIds: trip.stops.slice(1).map((stop) => stop.id) });
  expect(submitted[0].stops).toEqual(trip.stops);
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  const discarded = await downloadBackup("discarded-group.json");
  expect(discarded.trip.dayGroups).toBeUndefined();
  expect(discarded.trip.stops).toEqual(trip.stops);
  expect(discarded.plan).toBeNull();
  await page.getByRole("button", { name: "Plan my days", exact: true }).first().click();
  await expect(dialog.getByLabel("Day-trip name 1")).toHaveCount(0);
  await addGroup();
  provisional = false;
  await dialog.getByRole("button", { name: "Optimize preview" }).click();
  await expect(dialog.getByLabel("Suggested itinerary")).toContainText("Oudegracht canal walk");
  await dialog.getByRole("button", { name: "Use this plan" }).click();
  await expect(dialog).toHaveCount(0);
  const accepted = await downloadBackup("approved-group.json");
  expect(accepted.trip.dayGroups).toEqual(submitted[1].dayGroups);
  expect(new Set(accepted.plan.days[1].stopIds)).toEqual(new Set(trip.stops.slice(1).map((stop) => stop.id)));
  provisional = true;
  await page.getByRole("button", { name: "Plan my days", exact: true }).first().click();
  await dialog.getByRole("button", { name: "Resolve conflicts", exact: true }).click();
  const resolver = page.getByRole("dialog", { name: "Resolve conflicts", exact: true });
  await resolver.getByRole("button", { name: "Check travel gaps" }).click();
  await resolver.getByRole("button", { name: "Preview adjusted plan" }).click();
  await expect(resolver.getByLabel("Provisional itinerary outline")).toBeVisible();
  await expect(resolver.getByRole("button", { name: "Approve changes" })).toHaveCount(0);
  await resolver.getByRole("button", { name: "Cancel", exact: true }).click();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  const unchanged = await downloadBackup("preserved-group.json");
  expect(unchanged.trip).toEqual(accepted.trip);
  expect(unchanged.plan).toEqual(accepted.plan);
  await page.getByRole("combobox", { name: "Days", exact: true }).selectOption("1");
  await expect(page.getByRole("combobox", { name: "Days", exact: true })).toHaveValue("2");
  await expect(page.getByText("A day-trip group includes later days. Adjust its eligible days explicitly first.")).toBeVisible();
  await page.locator(".section-tabs").getByRole("button", { name: /^Places/ }).click();
  const canal = page.locator(".stop-item").filter({ hasText: "Oudegracht canal walk" });
  await canal.getByRole("button").first().click();
  await canal.getByRole("button", { name: "Remove", exact: true }).click();
  const reduced = await downloadBackup("removed-group-member.json");
  expect(reduced.trip.dayGroups[0].stopIds).toEqual([trip.stops[2].id]);
  const lunch = page.locator(".stop-item").filter({ hasText: "Stadskasteel Oudaen lunch" });
  await lunch.getByRole("button").first().click();
  await lunch.getByRole("button", { name: "Remove", exact: true }).click();
  expect((await downloadBackup("removed-empty-group.json")).trip.dayGroups).toBeUndefined();
  expect(errors).toEqual([]);
});

test("conflict resolution checks Google first and requires approval before changing bookings", async ({ page }, testInfo) => {
  const requests: { trip: Trip; mode?: string }[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/plan", async (route) => {
    const body = route.request().postDataJSON(); requests.push(body);
    await route.fulfill({ json: body.mode === "check" ? { connections: [{ day: 0, from: body.trip.stops[0].id, to: body.trip.stops[1].id, availableMinutes: -50, minutes: 10, mode: "WALK" }], warnings: ["Direct Google estimates; alternatives may exist."] } : previewFixture(body.trip) });
  });
  const trip = await openPlanningTrip(page, "Hotel", [
    { ...newStop("Louvre Museum"), placeId: "museum", day: 0, fixedTime: "10:30", source: "Confirmed ticket" },
    { ...newStop("Luxembourg Gardens"), placeId: "garden", day: 0, fixedTime: "10:40", source: "Suggested walk" },
  ]);
  await page.getByRole("button", { name: "Resolve conflicts", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Resolve conflicts", exact: true });
  expect(requests).toHaveLength(0);
  await dialog.getByRole("button", { name: "Check travel gaps" }).click();
  await expect(dialog.getByLabel("Google travel estimates")).toContainText("10 min estimated walking");
  await expect(dialog.getByLabel("Keep Louvre Museum fixed")).toBeChecked();
  await expect(dialog.getByLabel("Keep Luxembourg Gardens fixed")).toBeChecked();
  await dialog.getByRole("button", { name: "Preview adjusted plan" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Selected fixed reservations still overlap");
  await expect(dialog.getByRole("heading", { name: "Selected fixed reservations still overlap" })).toBeFocused();
  await expect(dialog.getByLabel("Additional flexibility")).toHaveCount(0);
  expect(requests).toHaveLength(1);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("resolution-decisions.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Make Luxembourg Gardens flexible", exact: true }).click();
  await expect(dialog.getByLabel("Reservations needing a decision")).toHaveCount(0);
  await expect(dialog.getByLabel("Keep Louvre Museum fixed")).toBeChecked();
  await expect(dialog.getByLabel("Keep Luxembourg Gardens fixed")).not.toBeChecked();
  expect(requests).toHaveLength(1);
  await dialog.getByRole("button", { name: "Preview adjusted plan" }).click();
  await expect(dialog.getByLabel("Proposed changes")).toContainText("11:25");
  expect(requests[1].trip.stops[0]).toEqual(trip.stops[0]);
  expect(requests[1].trip.stops[1]).toEqual({ ...trip.stops[1], fixedTime: null });
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.getByRole("heading", { name: "Resolve conflicts", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("resolution-proposal.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const planning = page.getByRole("dialog", { name: "Plan my days" });
  await expect(planning.getByLabel("Booked time for Luxembourg Gardens")).toHaveValue("10:40");
  await planning.getByRole("button", { name: "Resolve conflicts", exact: true }).click();
  await dialog.getByRole("button", { name: "Check travel gaps" }).click();
  await expect(dialog.getByLabel("Keep Luxembourg Gardens fixed")).toBeChecked();
  await dialog.getByRole("button", { name: "Allow all visit times to move", exact: true }).click();
  await expect(dialog.getByLabel("Keep Louvre Museum fixed")).not.toBeChecked();
  await expect(dialog.getByLabel("Keep Luxembourg Gardens fixed")).not.toBeChecked();
  await expect(dialog.getByLabel("Timing permissions")).toContainText("0 booking times locked / 2 released");
  await expect(dialog.getByLabel("Reservations needing a decision")).toHaveCount(0);
  expect(requests).toHaveLength(3);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(planning.getByLabel("Booked time for Louvre Museum")).toHaveValue("10:30");
  await expect(planning.getByLabel("Booked time for Luxembourg Gardens")).toHaveValue("10:40");
  await planning.getByRole("button", { name: "Resolve conflicts", exact: true }).click();
  await dialog.getByRole("button", { name: "Check travel gaps" }).click();
  await dialog.getByRole("button", { name: "Allow all visit times to move", exact: true }).click();
  await dialog.getByLabel("Keep Louvre Museum fixed").check();
  await dialog.getByRole("button", { name: "Preview adjusted plan" }).click();
  await dialog.getByRole("button", { name: "Approve changes" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download trip backup" }).click();
  const output = testInfo.outputPath("approved-resolution.json");
  await (await download).saveAs(output);
  const backup = JSON.parse(await readFile(output, "utf8"));
  expect(backup.trip.stops[0]).toEqual(trip.stops[0]);
  expect(backup.trip.stops[1]).toEqual({ ...trip.stops[1], fixedTime: null });
  expect(backup.plan.days[0].stopIds).toHaveLength(2);
  expect(errors).toEqual([]);
});

test("conflict resolution selectively shortens visits and releases days only with approval", async ({ page }, testInfo) => {
  const submitted: Trip[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/plan", async (route) => {
    const body = route.request().postDataJSON();
    if (body.mode === "check") { await route.fulfill({ json: { connections: [], warnings: [] } }); return; }
    submitted.push(body.trip);
    const selected = { ...body.trip, stops: body.trip.stops.map((stop: Trip["stops"][number]) => ({ ...stop, duration: stop.durationOptions?.at(-1) ?? stop.duration })) };
    await route.fulfill({ json: previewFixture(selected) });
  });
  const trip = await openPlanningTrip(page, "Hotel", [
    { ...newStop("Louvre Museum"), placeId: "museum", day: 0, fixedTime: "10:30", source: "Confirmed ticket" },
    { ...newStop("Canal Cafe"), placeId: "cafe", day: 0, fixedTime: "10:40", source: "Suggested lunch" },
  ]);
  await page.getByRole("button", { name: "Resolve conflicts", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Resolve conflicts", exact: true });
  await dialog.getByRole("button", { name: "Check travel gaps" }).click();
  await expect(dialog.getByLabel("Duration flexibility for Canal Cafe")).toHaveCount(0);
  await dialog.getByLabel("Keep Canal Cafe fixed").uncheck();
  const allDays = dialog.getByLabel("Allow all flexible visits to change days", { exact: true });
  await expect(allDays).not.toBeChecked();
  await allDays.check();
  await dialog.getByLabel("Duration flexibility for Canal Cafe").selectOption("eatery20");
  await dialog.getByLabel("Duration flexibility for Canal Cafe").selectOption("eatery10");
  expect(submitted).toHaveLength(0);
  await dialog.getByLabel("Timing permissions").scrollIntoViewIfNeeded();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("resolution-shorter-controls.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Preview adjusted plan", exact: true }).click();
  await expect(dialog.getByLabel("Proposed changes")).toContainText("41 min");
  expect(submitted[0].stops[0]).toEqual(trip.stops[0]);
  expect(submitted[0].stops[1]).toEqual({ ...trip.stops[1], day: null, fixedTime: null, durationOptions: [45, 41] });
  await page.screenshot({ path: testInfo.outputPath("resolution-shorter-proposal.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const planning = page.getByRole("dialog", { name: "Plan my days" });
  await expect(planning.getByLabel("Visit minutes for Canal Cafe")).toHaveValue("45");
  await planning.getByRole("button", { name: "Resolve conflicts", exact: true }).click();
  await dialog.getByRole("button", { name: "Check travel gaps" }).click();
  await dialog.getByLabel("Keep Canal Cafe fixed").uncheck();
  await expect(dialog.getByLabel("Duration flexibility for Canal Cafe")).toHaveValue("original");
  await expect(allDays).not.toBeChecked();
  await allDays.check();
  await dialog.getByLabel("Duration flexibility for Canal Cafe").selectOption("eatery20");
  await dialog.getByLabel("Keep Canal Cafe fixed").check();
  await dialog.getByLabel("Keep Canal Cafe fixed").uncheck();
  await expect(dialog.getByLabel("Duration flexibility for Canal Cafe")).toHaveValue("original");
  await allDays.check();
  await dialog.getByLabel("Duration flexibility for Canal Cafe").selectOption("eatery20");
  await dialog.getByRole("button", { name: "Preview adjusted plan", exact: true }).click();
  await expect(dialog.getByLabel("Proposed changes")).toContainText("36 min");
  await dialog.getByRole("button", { name: "Approve changes", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download trip backup" }).click();
  const output = testInfo.outputPath("shorter-resolution.json");
  await (await download).saveAs(output);
  const backup = JSON.parse(await readFile(output, "utf8"));
  expect(backup.trip.stops[0]).toEqual(trip.stops[0]);
  expect(backup.trip.stops[1]).toEqual({ ...trip.stops[1], day: null, fixedTime: null, duration: 36 });
  expect(backup.plan.omitted).toEqual([]);
  expect(errors).toEqual([]);
});

for (const permission of ["day", "omission"] as const) test(`conflict resolution asks before allowing ${permission} after a failed preview`, async ({ page }, testInfo) => {
  const submitted: Trip[] = [];
  await page.route("**/api/plan", async (route) => {
    const body = route.request().postDataJSON();
    if (body.mode === "check") { await route.fulfill({ json: { connections: [], warnings: [] } }); return; }
    submitted.push(body.trip);
    if (submitted.length === 1) { await route.fulfill({ status: 422, json: { error: "No schedule fits these bookings and available routes." } }); return; }
    const result = previewFixture(body.trip);
    const garden = result.schedule.days[0].visits.pop()!;
    result.schedule.days[0].returnLeg!.from = body.trip.stops[0].id;
    if (permission === "day") {
      result.schedule.days[1].visits = [{ ...garden, start: 600, end: 600 + body.trip.stops[1].duration, leg: { ...garden.leg, day: 1, from: "hotel" } }];
      result.schedule.days[1].returnLeg = { ...result.schedule.days[0].returnLeg!, day: 1, from: garden.stopId };
    } else result.schedule.omitted = [garden.stopId];
    await route.fulfill({ json: result });
  });
  const trip = await openPlanningTrip(page, "Hotel", [
    { ...newStop("Louvre Museum"), placeId: "museum", day: 0, fixedTime: "10:30", source: "Confirmed ticket" },
    { ...newStop("Luxembourg Gardens"), placeId: "garden", day: 0, fixedTime: "10:40", source: "Suggested walk" },
  ]);
  await page.getByRole("button", { name: "Resolve conflicts", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Resolve conflicts", exact: true });
  await dialog.getByRole("button", { name: "Check travel gaps" }).click();
  await dialog.getByLabel("Keep Luxembourg Gardens fixed").uncheck();
  await expect(dialog.getByLabel("Additional flexibility")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Preview adjusted plan" }).click();
  await expect(dialog.getByRole("alert")).toContainText("No schedule fits");
  await expect(dialog.getByLabel("Additional flexibility")).toBeVisible();
  await expect(dialog.getByLabel("Allow another day for Louvre Museum")).toHaveCount(0);
  const anotherDay = dialog.getByLabel("Allow another day for Luxembourg Gardens");
  const optional = dialog.getByLabel("Allow omission of Luxembourg Gardens");
  await expect(anotherDay).not.toBeChecked();
  await expect(optional).not.toBeChecked();
  await anotherDay.check(); await optional.check();
  await dialog.getByLabel("Keep Luxembourg Gardens fixed").check();
  await dialog.getByLabel("Keep Luxembourg Gardens fixed").uncheck();
  await expect(anotherDay).not.toBeChecked();
  await expect(optional).not.toBeChecked();
  await (permission === "day" ? anotherDay : optional).check();
  expect(submitted).toHaveLength(1);
  await dialog.getByLabel("Additional flexibility").scrollIntoViewIfNeeded();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("resolution-permissions.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Preview adjusted plan" }).click();
  await expect(dialog.getByLabel("Proposed changes")).toContainText(permission === "day" ? "2026-10-13, 10:00" : "Not scheduled (optional)");
  expect(submitted[1].stops[0]).toEqual(trip.stops[0]);
  const expected = { ...trip.stops[1], fixedTime: null, day: permission === "day" ? null : 0, optional: permission === "omission" };
  expect(submitted[1].stops[1]).toEqual(expected);
  await dialog.getByRole("button", { name: "Approve changes" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download trip backup" }).click();
  const output = testInfo.outputPath("permission-resolution.json");
  await (await download).saveAs(output);
  const backup = JSON.parse(await readFile(output, "utf8"));
  expect(backup.trip.stops[0]).toEqual(trip.stops[0]);
  expect(backup.trip.stops[1]).toEqual(expected);
  expect(backup.trip.stops).toHaveLength(2);
  if (permission === "day") expect(backup.plan.days[1].stopIds).toEqual([trip.stops[1].id]);
  else expect(backup.plan.omitted).toEqual([trip.stops[1].id]);
});

test("conflict resolution handles lookup failures and refuses unverified or changed reservations", async ({ page }, testInfo) => {
  let requests = 0;
  await page.route("**/api/plan", async (route) => {
    requests++;
    const body = route.request().postDataJSON();
    if (body.mode === "check") { await route.fulfill({ status: 502, json: { error: "Google Maps could not complete the request." } }); return; }
    const result = previewFixture(body.trip);
    if (requests === 2) result.verified = false;
    else { result.schedule.days[0].visits[0].start += 5; result.schedule.days[0].visits[0].end += 5; }
    await route.fulfill({ json: result });
  });
  const trip = await openPlanningTrip(page);
  await page.getByRole("button", { name: "Resolve conflicts", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Resolve conflicts", exact: true });
  await dialog.getByRole("button", { name: "Check travel gaps" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Google Maps could not complete");
  expect(requests).toBe(1);
  await dialog.getByRole("button", { name: "Review without estimates" }).click();
  await dialog.getByRole("button", { name: "Preview adjusted plan" }).click();
  await expect(dialog.getByRole("alert")).toContainText("not passed route verification");
  await expect(dialog.getByRole("button", { name: "Approve changes" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Preview adjusted plan" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Louvre Museum: booking time changed");
  await expect(dialog.getByRole("button", { name: "Approve changes" })).toHaveCount(0);
  expect(requests).toBe(3);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("dialog", { name: "Plan my days" }).getByRole("button", { name: "Close dialog" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download trip backup" }).click();
  const output = testInfo.outputPath("failed-resolution.json");
  await (await download).saveAs(output);
  const backup = JSON.parse(await readFile(output, "utf8"));
  expect(backup.trip.stops).toEqual(trip.stops);
  expect(backup.plan).toBeNull();
});

test("planning overlaps offer time suggestions and an explicit any-time checkbox", async ({ page }, testInfo) => {
  const requests: string[] = [];
  const errors: string[] = [];
  page.on("request", (request) => { if (/\/api\/(plan|timing)$/.test(request.url())) requests.push(request.url()); });
  page.on("pageerror", (error) => errors.push(error.message));
  const trip = await openPlanningTrip(page, "Private hotel", [
    { ...newStop("Sango Specialty Coffee"), placeId: "sango-id", day: 0, fixedTime: "14:45", source: "14:45 - 15:30 | Sango Specialty Coffee" },
    { ...newStop("Sango"), placeId: "sango-id", day: 0, fixedTime: "15:13" },
    { ...newStop("Canal cruise"), placeId: "cruise-id", day: 0, fixedTime: "17:00", source: "Reserved ticket" },
  ]);
  const dialog = page.getByRole("dialog", { name: "Plan my days" });
  const optimize = dialog.getByRole("button", { name: "Optimize preview" });
  const flexible = dialog.getByLabel("Any time slot for Sango Specialty Coffee", { exact: true });
  await expect(dialog.getByRole("alert")).toContainText("60 min needed, 28 available");
  await expect(optimize).toBeDisabled();
  await expect(optimize).toHaveAccessibleDescription(/1 fixed booking conflict remains/);
  await dialog.getByRole("button", { name: "Review visit times", exact: true }).last().click();
  await expect(dialog.getByRole("heading", { name: "Visits", exact: true })).toBeFocused();
  await expect(flexible).not.toBeChecked();
  expect(requests).toEqual([]);
  await dialog.getByLabel("Visit minutes for Sango Specialty Coffee", { exact: true }).fill("20");
  await dialog.getByLabel("Arrival buffer for Sango", { exact: true }).fill("5");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(optimize).toBeEnabled();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Plan my days", exact: true }).first().click();
  await expect(dialog.getByLabel("Visit minutes for Sango Specialty Coffee", { exact: true })).toHaveValue("45");
  await expect(dialog.getByLabel("Arrival buffer for Sango", { exact: true })).toHaveValue("15");
  await dialog.getByRole("heading", { name: "Plan my days", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("booking-conflicts.png"), fullPage: true });
  const suggestion = dialog.getByRole("button", { name: "Use suggested time 15:45 for Sango", exact: true });
  await suggestion.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("booking-suggestions.png"), fullPage: true });
  await suggestion.click();
  await expect(dialog.getByLabel("Booked time for Sango", { exact: true })).toHaveValue("15:45");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(optimize).toBeEnabled();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Plan my days", exact: true }).first().click();
  await expect(dialog.getByLabel("Booked time for Sango", { exact: true })).toHaveValue("15:13");
  await flexible.check();
  await expect(dialog.getByLabel("Booked time for Sango Specialty Coffee", { exact: true })).toHaveValue("");
  await expect(dialog.locator("#planning-blocker")).toHaveCount(0);
  await expect(dialog.getByLabel("Booked time for Sango Specialty Coffee", { exact: true })).toBeDisabled();
  await expect(dialog.getByLabel("Day for Sango Specialty Coffee", { exact: true })).toHaveValue("0");
  await expect(dialog.getByLabel("Day for Sango Specialty Coffee", { exact: true })).toBeEnabled();
  await expect(optimize).toBeEnabled();
  await flexible.uncheck();
  await expect(dialog.getByLabel("Booked time for Sango Specialty Coffee", { exact: true })).toHaveValue("14:45");
  await expect(optimize).toBeDisabled();
  await flexible.check();
  await dialog.getByLabel("Optional Sango Specialty Coffee", { exact: true }).check();
  await flexible.uncheck();
  await expect(dialog.getByLabel("Optional Sango Specialty Coffee", { exact: true })).not.toBeChecked();
  await expect(dialog.getByLabel("Optional Sango Specialty Coffee", { exact: true })).toBeDisabled();
  await flexible.check();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Plan my days", exact: true }).first().click();
  await expect(flexible).not.toBeChecked();
  await flexible.check();
  await dialog.getByText("Original source", { exact: true }).first().click();
  await expect(dialog.getByText(trip.stops[0].source, { exact: true })).toBeVisible();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await flexible.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("booking-controls.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Apply preferences" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download trip backup" }).click();
  const output = testInfo.outputPath("released-time.json");
  await (await download).saveAs(output);
  const backup = JSON.parse(await readFile(output, "utf8"));
  expect(backup.trip.stops).toHaveLength(3);
  expect(backup.trip.stops[0]).toEqual({ ...trip.stops[0], fixedTime: null });
  expect(backup.trip.stops[1]).toEqual(trip.stops[1]);
  expect(backup.trip.stops[2]).toEqual(trip.stops[2]);
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
});

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
  await dialog.getByLabel(/^Standalone walking leg limit/).fill("15");
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

test("planning failures offer one click to apply all suggested fixes and plan again", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const submitted: Trip[] = [];
  await page.route("**/api/plan", async (route) => {
    const trip = route.request().postDataJSON().trip as Trip;
    submitted.push(trip);
    const [museum, garden, cafe] = trip.stops;
    await route.fulfill(submitted.length === 1 ? { status: 422, json: { error: "No schedule fits these bookings and opening hours. Long explanation.", code: "sampled-model-conflict", fixes: [
      { stopId: museum.id, stopName: museum.name, issue: "Booked 10:00 on Day 1. It's at least 66 min from the hotel and the day starts at 09:00.", action: "rebook", time: "10:30" },
      { stopId: garden.id, stopName: garden.name, issue: "Open 12:00–21:00, which leaves no gap around Day 1's bookings. Day 2 has room.", action: "optimize-day" },
      { stopId: cafe.id, stopName: cafe.name, issue: "Closed, or open too briefly, on every trip day.", action: "make-optional" },
    ] } } : { json: previewFixture(trip) });
  });
  await openPlanningTrip(page, "Private hotel", [
    { ...newStop("Louvre Museum"), placeId: "museum-id", day: 0, fixedTime: "10:00" },
    { ...newStop("Luxembourg Gardens"), placeId: "garden-id", day: 0 },
    { ...newStop("Corner Cafe"), placeId: "cafe-id" },
  ]);
  const dialog = page.getByRole("dialog", { name: "Plan my days" });
  await dialog.getByRole("button", { name: "Optimize preview" }).click();
  const alert = dialog.getByRole("alert");
  await expect(alert).toContainText("3 visits can't be scheduled as set");
  await expect(alert).toContainText("Suggested: book it at 10:30");
  // Asking the assistant is offered only where it is set up.
  await expect(dialog.getByRole("button", { name: "Ask the assistant to fix this" })).toHaveCount(0);
  await expect(alert).toContainText("Luxembourg Gardens: Open 12:00–21:00");
  await expect(alert).toContainText("Suggested: set Day to Optimize");
  await expect(alert).toContainText("Suggested: mark Optional");
  await expect(alert.getByText("Long explanation.")).toBeHidden();
  await alert.getByRole("button", { name: "Apply all suggestions and plan again" }).click();
  await expect(dialog.getByRole("button", { name: "Use this plan" })).toBeVisible();
  expect(submitted).toHaveLength(2);
  expect(submitted[1].stops.map((stop) => [stop.day, stop.optional, stop.fixedTime])).toEqual([[0, false, "10:30"], [null, false, null], [null, true, null]]);
  await dialog.getByRole("button", { name: "Preferences", exact: true }).click();
  await expect(dialog.getByLabel("Day for Luxembourg Gardens", { exact: true })).toHaveValue("");
  await expect(dialog.getByLabel("Optional Corner Cafe")).toBeChecked();
  expect(errors).toEqual([]);
});

test("planning timing guidance uses original references as opt-in soft windows", async ({ page }, testInfo) => {
  const requests: { city: string; places: { id: string; name: string; source: string; sourceUrl?: string }[]; consent: boolean }[] = [];
  const planningRequests: { trip: Trip }[] = [];
  await page.route("**/api/plan", async (route) => {
    planningRequests.push(route.request().postDataJSON());
    await route.fulfill({ status: 422, json: { error: "No schedule fits the supplied preview." } });
  });
  await page.route("**/api/timing", async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    await route.fulfill({ json: { recommendations: [{ stopId: body.places[0].id, duration: 120, bestTime: "Dinner service", reason: "The original itinerary describes an evening meal.", preferredTimeWindow: { start: "18:00", end: "21:00" }, sourceIndexes: [0, 1] }], sources: [{ title: "Official garden guide", url: "https://example.com/garden" }, { title: "Original itinerary: Luxembourg Gardens", url: "https://example.com/original-itinerary" }], research: "The original note identifies an evening meal; use the venue's evening service window as a flexible preference.", searchEntryPoint: "<a href='https://www.google.com/search?q=garden' target='_blank'>Google Search</a>" } });
  });
  const trip = await openPlanningTrip(page, "Private hotel", [
    { ...newStop("Louvre Museum"), placeId: "museum-id" },
    { ...newStop("Luxembourg Gardens"), placeId: "garden-id", source: "Original itinerary: dinner at this bouillon.", sourceUrl: "https://example.com/original-itinerary" },
  ]);
  const dialog = page.getByRole("dialog", { name: "Plan my days" });
  const research = dialog.getByRole("button", { name: "Research timing windows" });
  await expect(research).toBeDisabled();
  await dialog.getByLabel("Research timing for Luxembourg Gardens").check();
  await expect(research).toBeDisabled();
  await dialog.getByLabel(/Send selected place names, original notes and links/).check();
  await research.click();
  await expect(dialog.getByText("Suggested: 120 min", { exact: true })).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ city: "Paris", consent: true, places: [{ id: trip.stops[1].id, name: "Luxembourg Gardens", source: "Original itinerary: dinner at this bouillon.", sourceUrl: "https://example.com/original-itinerary" }] });
  expect(JSON.stringify(requests)).not.toContain("Private hotel");
  expect(JSON.stringify(requests)).not.toContain("10:30");
  await expect(dialog.getByLabel("Visit minutes for Luxembourg Gardens")).toHaveValue("45");
  await dialog.getByRole("button", { name: "Use this time window" }).click();
  const preferredStart = dialog.getByLabel("Preferred start time for Luxembourg Gardens");
  await expect(preferredStart).toHaveValue("18:00");
  await dialog.getByLabel("Preferred end time for Luxembourg Gardens").fill("21:00");
  await preferredStart.fill("17:30");
  await dialog.getByRole("button", { name: "Optimize preview" }).click();
  await expect(dialog.getByRole("alert")).toContainText("No schedule fits the supplied preview");
  expect(planningRequests).toHaveLength(1);
  expect(planningRequests[0].trip.stops[1].preferredTimeWindow).toEqual({ start: "17:30", end: "21:00", sources: ["https://example.com/garden", "https://example.com/original-itinerary"] });
  await dialog.getByRole("button", { name: "Clear time preference" }).click();
  await expect(dialog.getByLabel("Preferred start time for Luxembourg Gardens")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Use this time window" }).click();
  await expect(dialog.locator("iframe")).toHaveAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox");
  await dialog.getByRole("button", { name: "Use 120 min for Luxembourg Gardens" }).click();
  await expect(dialog.getByLabel("Visit minutes for Luxembourg Gardens")).toHaveValue("120");
  await dialog.getByLabel("Visit minutes for Luxembourg Gardens").fill("75");
  await dialog.getByText("Google Search evidence", { exact: true }).click();
  await expect(dialog.getByRole("link", { name: "Official garden guide", exact: true }).first()).toHaveAttribute("href", "https://example.com/garden");
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("planning-research.png"), fullPage: true });
  await dialog.getByLabel("Research timing for Luxembourg Gardens").uncheck();
  await expect(dialog.getByLabel(/Send selected place names, original notes and links/)).not.toBeChecked();
  await expect(dialog.getByText("Suggested: 120 min", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Apply preferences" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download trip backup" }).click();
  const output = testInfo.outputPath("manual-timing.json");
  await (await download).saveAs(output);
  const backup = JSON.parse(await readFile(output, "utf8"));
  expect(backup.trip.stops[1].duration).toBe(75);
  expect(backup.trip.stops[1].preferredTimeWindow).toEqual({ start: "18:00", end: "21:00", sources: ["https://example.com/garden", "https://example.com/original-itinerary"] });
  expect(JSON.stringify(backup)).toContain("https://example.com/garden");
});
test("trip mode opens today's day full screen, records progress and closes with back", async ({ page }, testInfo) => {
  // 10:00 in Paris on the first day of the trip.
  await page.clock.install({ time: new Date("2026-10-13T08:00:00Z") });
  const coffee = { ...newStop("Coffee"), placeId: "coffee-id", duration: 45 };
  const museum = { ...newStop("Museum"), placeId: "museum-id", day: 0, fixedTime: "11:30", duration: 90 };
  const dinner = { ...newStop("Dinner"), placeId: "dinner-id", duration: 60 };
  const trip: Trip = { ...newTrip(), city: "Paris", hotel: "Hotel", hotelPlaceId: "hotel-id", startDate: "2026-10-13", days: 2, timeZone: "Europe/Paris", dailyStart: "09:00", dailyEnd: "21:00", stops: [coffee, museum, dinner] };
  const walk = (from: string, to: string, minutes: number) => ({ day: 0, from, to, mode: "WALK" as const, minutes, meters: 800 });
  const at = (day: number, hour: number, minute = 0) => day * 1440 + hour * 60 + minute;
  const schedule = { generatedAt: "2026-10-12T08:00:00Z", warnings: [], omitted: [], days: [
    { day: 0, date: "2026-10-13", visits: [{ stopId: coffee.id, start: at(0, 9, 30), end: at(0, 10, 15), leg: walk("hotel", coffee.id, 10) }, { stopId: museum.id, start: at(0, 11, 30), end: at(0, 13), leg: walk(coffee.id, museum.id, 20) }], returnLeg: walk(museum.id, "hotel", 15) },
    { day: 1, date: "2026-10-14", visits: [{ stopId: dinner.id, start: at(1, 19), end: at(1, 20), leg: walk("hotel", dinner.id, 10) }], returnLeg: walk(dinner.id, "hotel", 10) },
  ] };
  const place = (id: string, name: string) => ({ id, name, address: `${name}, Paris`, location: { lat: 48.86, lng: 2.35 } });
  const plan = persistedPlan(schedule, trip, { hotel: place("hotel-id", "Hotel"), [coffee.id]: place("coffee-id", "Coffee"), [museum.id]: place("museum-id", "Museum"), [dinner.id]: place("dinner-id", "Dinner") });
  await page.goto("/");
  await page.getByRole("button", { name: "Connections and settings" }).click();
  await page.getByLabel("Open trip backup").setInputFiles({ name: "trip-mode.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ trip, plan })) });
  // The assistant is for signed-in editors with a configured model only.
  await expect(page.getByRole("button", { name: "Open trip assistant" })).toHaveCount(0);
  const mobile = testInfo.project.name === "mobile";
  if (mobile) await page.getByRole("button", { name: "Today's plan" }).click();
  else await page.getByRole("button", { name: "Trip mode" }).click();
  const tripMode = page.getByRole("dialog", { name: "Trip mode, Day 1 · Tue 13 Oct" });
  await expect(tripMode).toBeVisible();
  expect(page.url()).toContain("#trip");
  const box = (await tripMode.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect([box.x, box.y, box.width, box.height]).toEqual([0, 0, viewport.width, viewport.height]);
  const card = tripMode.locator(".trip-card");
  await expect(card).toContainText("Next · 1 of 2Coffee09:30–10:15Leave by 09:20 · 10 min walk · now");
  expect(await card.getByRole("link", { name: "Directions" }).getAttribute("href")).toMatch(/^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=Coffee&destination_place_id=coffee-id&travelmode=walking$/);
  await card.getByRole("button", { name: "Done" }).click();
  await expect(tripMode.getByRole("status")).toContainText("Coffee marked done");
  await expect(card).toContainText("Next · 2 of 2Museum11:30–13:00Booked");
  await expect(card).toContainText("Leave by 11:10 · 20 min walk · in 1 h 10 min");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("trip-mode.png") });

  await tripMode.getByRole("button", { name: "Show the whole day" }).click();
  await expect(tripMode.locator(".trip-timeline")).toContainText("Museum11:30 - 13:00 · 90 min");
  await tripMode.getByRole("button", { name: "Trip menu" }).click();
  const menu = tripMode.getByRole("navigation", { name: "Trip days" });
  await expect(menu).toContainText("Day 1 · Tue 13 Oct2 stops · 1/2 doneToday");
  await menu.getByRole("button", { name: /^Day 2/ }).click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Trip mode, Day 2 · Wed 14 Oct" })).toBeVisible();
  await page.getByRole("button", { name: "Trip menu" }).click();
  await page.goBack();
  await expect(page.getByRole("navigation", { name: "Trip days" })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: /^Trip mode/ })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("dialog", { name: /^Trip mode/ })).toHaveCount(0);
  expect(page.url()).not.toContain("#trip");

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download trip backup" }).click();
  const output = testInfo.outputPath("trip-mode-backup.json");
  await (await download).saveAs(output);
  const backup = JSON.parse(await readFile(output, "utf8"));
  expect(backup.journey.execution[trip.id]["2026-10-13"].completed).toEqual([{ stopId: coffee.id, start: 555, end: 600 }]);
});

test("a chosen place's card in trip mode stays below the bar and scrolls when it's taller than the screen", async ({ page }, testInfo) => {
  await page.clock.install({ time: new Date("2026-10-13T08:00:00Z") });
  const mobile = testInfo.project.name === "mobile";
  await page.setViewportSize(mobile ? { width: 390, height: 640 } : { width: 980, height: 600 });
  const long = "A long line from a guide about the place, its history and its setting, to fill the card. ".repeat(3).slice(0, 290);
  const market = { ...newStop("Albert Cuyp Market"), placeId: "market-id", duration: 60, source: "Walk 5 mins to the market.", about: { what: long, expect: long, todo: long } };
  const trip: Trip = { ...newTrip(), city: "Amsterdam", hotel: "Hotel", hotelPlaceId: "hotel-id", startDate: "2026-10-13", days: 1, timeZone: "Europe/Amsterdam", dailyStart: "09:00", dailyEnd: "21:00", stops: [market] };
  const schedule = { generatedAt: "2026-10-12T08:00:00Z", warnings: [], omitted: [], days: [{ day: 0, date: "2026-10-13", visits: [{ stopId: market.id, start: 600, end: 660, leg: { day: 0, from: "hotel", to: market.id, mode: "WALK" as const, minutes: 10, meters: 800 } }] }] };
  const place = (id: string, name: string) => ({ id, name, address: `${name}, Amsterdam`, location: { lat: 52.35, lng: 4.89 } });
  const plan = persistedPlan(schedule, trip, { hotel: place("hotel-id", "Hotel"), [market.id]: place("market-id", "Albert Cuyp Market") });
  await page.goto("/");
  await page.getByRole("button", { name: "Connections and settings" }).click();
  await page.getByLabel("Open trip backup").setInputFiles({ name: "trip-mode.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ trip, plan })) });
  if (mobile) await page.getByRole("button", { name: "Today's plan" }).click();
  else await page.getByRole("button", { name: "Trip mode" }).click();
  const tripMode = page.getByRole("dialog", { name: /^Trip mode/ });
  // Boxes once the sheet has finished sliding to its height.
  const settled = async (locator: Locator) => {
    let last = -1;
    await expect.poll(async () => { const y = (await locator.boundingBox())!.y; const same = y === last; last = y; return same; }).toBe(true);
    return (await locator.boundingBox())!;
  };
  await tripMode.getByRole("button", { name: "Show the whole day" }).click();
  await tripMode.locator(".trip-timeline .itinerary-stop").first().click();
  const card = tripMode.locator(".trip-card");
  await expect(card.locator(".place-about")).toContainText("What to do");
  // The guide's notes take the place of the original itinerary's line.
  await expect(card).not.toContainText("Walk 5 mins to the market.");
  const bar = (await tripMode.locator(".trip-mode-bar").boundingBox())!;
  const sheet = await settled(tripMode.getByRole("region", { name: "Day plan" }));
  expect(sheet.y).toBeGreaterThanOrEqual(bar.y + bar.height);
  // The card's top is in view, and the rest scrolls within the sheet.
  const label = (await card.locator(".trip-card-label").boundingBox())!;
  expect(label.y).toBeGreaterThanOrEqual(sheet.y);
  await expect(tripMode.locator(".sheet-header")).toHaveClass(/scrolls/);
  await page.screenshot({ path: testInfo.outputPath("trip-mode-about.png") });
});

test("a transport card in trip mode counts the rides, takes top-ups, says when a day pass is cheaper and stays where it's dragged", async ({ page }, testInfo) => {
  // 10:00 in Paris on the first day of the trip.
  await page.clock.install({ time: new Date("2026-10-13T08:00:00Z") });
  const coffee = { ...newStop("Coffee"), placeId: "coffee-id", duration: 45 };
  const museum = { ...newStop("Museum"), placeId: "museum-id", duration: 90 };
  const trip: Trip = { ...newTrip(), city: "Paris", hotel: "Hotel", hotelPlaceId: "hotel-id", startDate: "2026-10-13", days: 1, timeZone: "Europe/Paris", dailyStart: "09:00", dailyEnd: "21:00", stops: [coffee, museum] };
  const at = (hour: number, minute = 0) => hour * 60 + minute;
  const schedule = { generatedAt: "2026-10-12T08:00:00Z", warnings: [], omitted: [], days: [{ day: 0, date: "2026-10-13", visits: [
    { stopId: coffee.id, start: at(9, 30), end: at(10, 15), leg: { day: 0, from: "hotel", to: coffee.id, mode: "TRANSIT" as const, minutes: 20, meters: 4000 } },
    { stopId: museum.id, start: at(11), end: at(12, 30), leg: { day: 0, from: coffee.id, to: museum.id, mode: "WALK" as const, minutes: 15, meters: 900 } },
  ], returnLeg: { day: 0, from: museum.id, to: "hotel", mode: "WALK" as const, minutes: 20, meters: 1500 } }] };
  const place = (id: string, name: string) => ({ id, name, address: `${name}, Paris`, location: { lat: 48.86, lng: 2.35 } });
  const plan = persistedPlan(schedule, trip, { hotel: place("hotel-id", "Hotel"), [coffee.id]: place("coffee-id", "Coffee"), [museum.id]: place("museum-id", "Museum") });
  const card = { kind: "tickets", name: "Navigo Easy", currency: "EUR", travellers: 2, ridePrice: 2.55, dayPass: 2, airportPrice: 14 };
  const journey = { id: crypto.randomUUID(), title: "Paris", cities: [trip], plans: { [trip.id]: plan }, transport: { [trip.id]: { card } } };
  const open = async () => {
    if (testInfo.project.name === "mobile") await page.getByRole("button", { name: "Today's plan" }).click();
    else await page.getByRole("button", { name: "Trip mode" }).click();
  };
  await page.goto("/");
  await page.getByRole("button", { name: "Connections and settings" }).click();
  await page.getByLabel("Open trip backup").setInputFiles({ name: "transport.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ journey })) });
  await page.keyboard.press("Escape");
  // The metro to the coffee for two costs more than two day passes.
  await page.getByRole("button", { name: /^Itinerary/ }).click();
  await expect(page.locator(".pass-advice")).toHaveText("1 ride ≈ €5.10; day passes (€4.00) are cheaper");
  await page.screenshot({ path: testInfo.outputPath("pass-advice.png") });
  await open();
  const tripMode = page.getByRole("dialog", { name: "Trip mode, Day 1 · Tue 13 Oct" });
  const chip = tripMode.getByRole("button", { name: /^Transport card/ });
  await expect(chip).toHaveText("0 tickets");
  await chip.click();
  const panel = tripMode.getByRole("region", { name: "Transport card" });
  // The metro to the coffee, for two.
  await expect(panel).toContainText("Navigo Easyfor 2");
  await expect(panel).toContainText("Today0 rides · 1 to go");
  await expect(panel).toContainText("To add2 tickets");
  await expect(panel.locator(".pass-advice")).toHaveText("Today: 1 ride ≈ €5.10; day passes (€4.00) are cheaper");
  await expect(panel.getByRole("button", { name: "Day pass" })).toHaveClass(/primary/);
  await panel.getByRole("button", { name: "Top up" }).click();
  await expect(panel.getByLabel("Tickets")).toHaveValue("10");
  await expect(panel.getByLabel("Paid")).toHaveValue("25.5");
  await panel.getByRole("button", { name: "Add", exact: true }).click();
  await expect(chip).toHaveText("10 tickets");
  await expect(panel).not.toContainText("To add");
  await expect(panel).toContainText("Spent€25.50");
  await page.screenshot({ path: testInfo.outputPath("transport-panel.png") });
  await panel.getByRole("button", { name: "Close transport card" }).click();
  await tripMode.locator(".trip-card").getByRole("button", { name: "Done" }).click();
  await expect(chip).toHaveText("8 tickets");
  await chip.click();
  await expect(panel).toContainText("Today1 ride · 0 to go");
  await expect(panel.locator(".pass-advice")).toHaveCount(0);
  await panel.getByRole("button", { name: "Airport ride" }).click();
  await expect(panel).toContainText("Spent€53.50");
  await expect(chip).toHaveText("8 tickets");
  await panel.getByRole("button", { name: "Remove airport ride" }).click();
  await expect(panel).toContainText("Spent€25.50");
  await panel.getByRole("button", { name: "Close transport card" }).click();

  // Dragged to the bottom, it stays above the day plan, and there after trip mode closes and opens again.
  const box = (await chip.boundingBox())!;
  const viewport = page.viewportSize()!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(40, viewport.height - 300, { steps: 8 });
  await page.mouse.up();
  await expect(tripMode.locator(".transport-chip-wrap")).toHaveClass(/bottom-left/);
  await expect(panel).toHaveCount(0);
  await expect.poll(async () => { const moved = (await chip.boundingBox())!; const sheet = (await tripMode.locator(".bottom-sheet").boundingBox())!; return moved.y + moved.height <= sheet.y; }).toBe(true);
  await page.goBack();
  await open();
  await expect(page.locator(".transport-chip-wrap")).toHaveClass(/bottom-left/);
  await page.goBack();

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download trip backup" }).click();
  const output = testInfo.outputPath("transport-backup.json");
  await (await download).saveAs(output);
  const backup = JSON.parse(await readFile(output, "utf8"));
  expect(backup.journey.transport[trip.id].entries.map((entry: { kind: string; amount?: number; paid?: number; voided?: boolean }) => [entry.kind, entry.amount ?? entry.paid, Boolean(entry.voided)])).toEqual([["topup", 10, false], ["ride", 28, true]]);

  // The recap says what the card cost.
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Trip recap" }).click();
  await expect(page.getByRole("dialog", { name: "Recap" }).locator(".recap-transport")).toHaveText("Transport: €25.50");
});

test("a card counted in euros takes each ride's Google fare, and a fare can be corrected", async ({ page }, testInfo) => {
  // 10:00 in Paris on the first day of the trip.
  await page.clock.install({ time: new Date("2026-10-13T08:00:00Z") });
  const coffee = { ...newStop("Coffee"), placeId: "coffee-id", duration: 45 };
  const museum = { ...newStop("Museum"), placeId: "museum-id", duration: 90 };
  const trip: Trip = { ...newTrip(), city: "Paris", hotel: "Hotel", hotelPlaceId: "hotel-id", startDate: "2026-10-13", days: 1, timeZone: "Europe/Paris", dailyStart: "09:00", dailyEnd: "21:00", stops: [coffee, museum] };
  const at = (hour: number, minute = 0) => hour * 60 + minute;
  const bus = { day: 0, mode: "TRANSIT" as const, minutes: 20, meters: 4000, steps: [{ instruction: "Bus", mode: "TRANSIT", line: "29" }] };
  const schedule = { generatedAt: "2026-10-12T08:00:00Z", warnings: [], omitted: [], days: [{ day: 0, date: "2026-10-13", visits: [
    { stopId: coffee.id, start: at(9, 30), end: at(10, 15), leg: { ...bus, from: "hotel", to: coffee.id } },
    { stopId: museum.id, start: at(11), end: at(12, 30), leg: { ...bus, from: coffee.id, to: museum.id, steps: [{ instruction: "Metro", mode: "TRANSIT", line: "8" }] } },
  ], returnLeg: { day: 0, from: museum.id, to: "hotel", mode: "WALK" as const, minutes: 20, meters: 1500 } }] };
  const place = (id: string, name: string) => ({ id, name, address: `${name}, Paris`, location: { lat: 48.86, lng: 2.35 } });
  const plan = persistedPlan(schedule, trip, { hotel: place("hotel-id", "Hotel"), [coffee.id]: place("coffee-id", "Coffee"), [museum.id]: place("museum-id", "Museum") });
  const card = { kind: "balance", name: "Navigo Easy", currency: "EUR", travellers: 2, ridePrice: 2.55 };
  // Google's fares: the bus to the coffee, and the metro to the museum.
  const fares = { [`2026-10-13|${coffee.id}`]: { from: "hotel", to: coffee.id, lines: "29", amount: 2.05, currency: "EUR", at: Date.parse("2026-10-13T07:00:00Z") }, [`2026-10-13|${museum.id}`]: { from: coffee.id, to: museum.id, lines: "8", amount: 2.55, currency: "EUR", at: Date.parse("2026-10-13T07:00:00Z") } };
  const topUp = { id: crypto.randomUUID(), at: Date.parse("2026-10-13T07:30:00Z"), kind: "topup", amount: 20, paid: 20 };
  const journey = { id: crypto.randomUUID(), title: "Paris", cities: [trip], plans: { [trip.id]: plan }, transport: { [trip.id]: { card, entries: [topUp], fares } } };
  await page.goto("/");
  await page.getByRole("button", { name: "Connections and settings" }).click();
  await page.getByLabel("Open trip backup").setInputFiles({ name: "fares.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ journey })) });
  if (testInfo.project.name === "mobile") await page.getByRole("button", { name: "Today's plan" }).click();
  else await page.getByRole("button", { name: "Trip mode" }).click();
  const tripMode = page.getByRole("dialog", { name: "Trip mode, Day 1 · Tue 13 Oct" });
  const chip = tripMode.getByRole("button", { name: /^Transport card/ });
  await expect(chip).toHaveText("€20.00");
  await chip.click();
  const panel = tripMode.getByRole("region", { name: "Transport card" });
  const rides = panel.getByRole("list", { name: "Today's rides" });
  await expect(rides.getByRole("listitem")).toHaveText(["Coffee€4.10", "Museum€5.10"]);
  await panel.getByRole("button", { name: "Close transport card" }).click();
  await tripMode.locator(".trip-card").getByRole("button", { name: "Done" }).click();
  await expect(chip).toHaveText("€15.90");
  // The bus was a tram that cost more: corrected for both travellers.
  await chip.click();
  await panel.getByRole("button", { name: "Change the fare to Coffee" }).click();
  await expect(panel.getByLabel("Fare each")).toHaveValue("2.05");
  await panel.getByLabel("Fare each").fill("2.5");
  await panel.getByRole("button", { name: "Save" }).click();
  await expect(chip).toHaveText("€15.00");
  await expect(rides.getByRole("listitem").first()).toHaveText("Coffee€5.00");
  await expect(panel.locator(".transport-entries")).toContainText("Fare for Coffee · €2.50");
  await page.screenshot({ path: testInfo.outputPath("transport-fares.png") });
  await panel.getByRole("button", { name: "Remove fare" }).click();
  await expect(chip).toHaveText("€15.90");
});

test("a meal the plan leaves out is shown in the itinerary, with places nearby to add for it", async ({ page }, testInfo) => {
  await page.clock.install({ time: new Date("2026-10-12T08:00:00Z") });
  const museum = { ...newStop("Museum"), placeId: "museum-id", duration: 90 };
  const park = { ...newStop("Park"), placeId: "park-id", duration: 90 };
  const trip: Trip = { ...newTrip(), city: "Paris", hotel: "Hotel", hotelPlaceId: "hotel-id", startDate: "2026-10-13", days: 1, timeZone: "Europe/Paris", dailyStart: "09:00", dailyEnd: "18:00", stops: [museum, park] };
  const at = (hour: number, minute = 0) => hour * 60 + minute;
  const schedule = { generatedAt: "2026-10-12T08:00:00Z", warnings: [], omitted: [], days: [{ day: 0, date: "2026-10-13", visits: [
    { stopId: museum.id, start: at(10), end: at(11, 30), leg: { day: 0, from: "hotel", to: museum.id, mode: "WALK" as const, minutes: 15, meters: 1100 } },
    { stopId: park.id, start: at(12, 30), end: at(14), leg: { day: 0, from: museum.id, to: park.id, mode: "WALK" as const, minutes: 20, meters: 1500 } },
  ], returnLeg: { day: 0, from: park.id, to: "hotel", mode: "WALK" as const, minutes: 20, meters: 1500 } }] };
  const place = (id: string, name: string, lat: number) => ({ id, name, address: `${name}, Paris`, location: { lat, lng: 2.35 } });
  const plan = persistedPlan(schedule, trip, { hotel: place("hotel-id", "Hotel", 48.87), [museum.id]: place("museum-id", "Museum", 48.86), [park.id]: place("park-id", "Park", 48.85) });
  const asked: Record<string, unknown>[] = [];
  await page.route("**/api/places/nearby", async (route) => {
    asked.push(route.request().postDataJSON());
    await route.fulfill({ json: { places: [
      { id: "bistro-id", name: "Bistro", address: "1 Rue, Paris", location: { lat: 48.851, lng: 2.35 }, primaryType: "french_restaurant", rating: 4.6, reviews: 1240, price: "Moderate", walkMinutes: 4 },
      { id: "brasserie-id", name: "Brasserie", address: "2 Rue, Paris", location: { lat: 48.852, lng: 2.35 }, rating: 4.4, reviews: 800, walkMinutes: 6 },
    ] } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Connections and settings" }).click();
  await page.getByLabel("Open trip backup").setInputFiles({ name: "meals.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ trip, plan })) });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Itinerary/ }).click();
  await expect(page.getByRole("region", { name: "No breakfast planned" })).toContainText("Near Hotel");
  const lunch = page.getByRole("region", { name: "No lunch planned" });
  // At the park by the middle of lunchtime.
  await expect(lunch).toContainText("Near Park");
  await lunch.getByRole("button", { name: "Suggest" }).click();
  await expect(lunch.getByRole("listitem")).toHaveText([/Bistro4\.6 ★ \(1,240\) · 4 min walk · Moderate/, /Brasserie4\.4 ★ \(800\) · 6 min walk/]);
  expect(asked).toEqual([{ meal: "lunch", location: { lat: 48.85, lng: 2.35 }, date: "2026-10-13", start: "12:25", end: "13:25" }]);
  await page.screenshot({ path: testInfo.outputPath("meal-suggestions.png") });
  await lunch.getByRole("button", { name: "Add Bistro" }).click();
  await expect(page.getByRole("status")).toContainText("Added");
  await expect(lunch).toHaveCount(0);
  await page.getByRole("button", { name: /^Places/ }).click();
  await expect(page.getByText("Bistro", { exact: true }).first()).toBeVisible();
});

test("adds a day to a city up to the next city's first day", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New trip", exact: true }).click();
  const setup = page.getByRole("dialog", { name: "New trip" });
  await setup.getByLabel("Departure date").fill("2026-12-24");
  for (const city of ["Amsterdam", "Brussels", "Paris"]) await setup.getByRole("button", { name: city, exact: true }).click();
  await setup.getByLabel("Days in city 1").fill("4");
  await setup.getByLabel("Days in city 2").fill("3");
  await expect(setup.getByLabel("Arrival in city 2")).toHaveValue("2026-12-28");
  await expect(setup.getByLabel("Arrival in city 3")).toHaveValue("2026-12-31");
  await setup.getByRole("button", { name: "Create trip" }).click();
  await page.locator(".city-tabs").getByRole("button", { name: /Brussels/ }).click();
  const tabs = page.locator(".day-tabs");
  await expect(tabs.getByRole("button", { name: /^Day/ })).toHaveCount(3);
  // Leaving Brussels on the morning Paris starts.
  await tabs.getByRole("button", { name: "Add a day" }).click();
  await expect(tabs.getByRole("button", { name: /Day 4/ })).toHaveAttribute("aria-pressed", "true");
  await expect(tabs.getByRole("button", { name: /Day 4/ })).toContainText("Dec 31");
  await expect(page.getByRole("combobox", { name: "Days", exact: true })).toHaveValue("4");
  await expect(page.getByText("Day 4 is Dec 31, the day you move to Paris.")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("add-day.png") });
  await tabs.getByRole("button", { name: "Add a day" }).click();
  await expect(page.getByText("Paris starts Dec 31, so Brussels can't end later. Move Paris later first.")).toBeVisible();
  await expect(tabs.getByRole("button", { name: /^Day/ })).toHaveCount(4);
  await expect(page.getByRole("combobox", { name: "Days", exact: true })).toHaveValue("4");
  // The last city can grow to the 7-day limit.
  await page.locator(".city-tabs").getByRole("button", { name: /Paris/ }).click();
  while (await tabs.getByRole("button", { name: /^Day/ }).count() < 7) await tabs.getByRole("button", { name: "Add a day" }).click();
  await expect(tabs.getByRole("button", { name: "Add a day" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("the recap sets planned times against done ones and keeps the day's note and favourites", async ({ page }, testInfo) => {
  await page.clock.install({ time: new Date("2026-10-14T12:00:00Z") });
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  const trip: Trip = { ...newTrip(), city: "Amsterdam", hotel: "Hotel", startDate: "2026-10-13", timeZone: "UTC", days: 2, stops: [newStop("Coffee"), newStop("Canal walk"), newStop("Tomorrow's park")] };
  const [coffee, canal, park] = trip.stops;
  const walk = (from: string, to: string) => ({ day: 0, from, to, mode: "WALK" as const, minutes: 15, meters: 1200 });
  const schedule = { generatedAt: "2026-10-01T06:00:00Z", warnings: [], omitted: [], days: [
    { day: 0, date: "2026-10-13", visits: [{ stopId: coffee.id, start: 540, end: 600, leg: walk("hotel", coffee.id) }, { stopId: canal.id, start: 630, end: 690, leg: walk(coffee.id, canal.id) }], returnLeg: walk(canal.id, "hotel") },
    { day: 1, date: "2026-10-14", visits: [{ stopId: park.id, start: 900, end: 960, leg: walk("hotel", park.id) }] },
  ] };
  const progress = { ...newDayProgress(trip, 0, [coffee.id, canal.id]), version: 1, completed: [{ stopId: coffee.id, start: 555, end: 620 }], originId: coffee.id, readyAt: 620 };
  const journey = { id: crypto.randomUUID(), title: "Amsterdam", cities: [{ ...trip, hotel: "Hotel" }], plans: { [trip.id]: persistedPlan(schedule, trip, {}) }, execution: { [trip.id]: { "2026-10-13": progress } } };
  await page.goto("/");
  await page.getByRole("button", { name: "Connections and settings" }).click();
  await page.getByLabel("Open trip backup").setInputFiles({ name: "recap.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ journey })) });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Trip recap" }).click();
  const recap = page.getByRole("dialog", { name: "Recap" });
  await expect(recap.locator(".recap-summary")).toHaveText("2 days · 1 visit · 1 not visited · 2.4 km on foot");
  const first = recap.getByRole("region", { name: "Day 1 · Tue 13 Oct, Amsterdam" });
  await expect(first.locator(".recap-visit")).toHaveText(["CoffeePlanned 09:00–10:00 · Done 09:15–10:20", "Canal walkPlanned 10:30–11:30 · Not visited"]);
  await expect(recap.getByRole("region", { name: "Day 2 · Wed 14 Oct, Amsterdam" }).locator(".recap-visit")).toHaveText(["Tomorrow's parkPlanned 15:00–16:00 · Later today"]);
  await first.getByRole("button", { name: "Favourite Coffee" }).click();
  await expect(first.getByRole("button", { name: "Favourite Coffee" })).toHaveAttribute("aria-pressed", "true");
  await first.getByLabel("Day note").fill("Rain all morning, sun by the canal");
  await recap.getByRole("heading", { name: "Recap" }).click();
  await expect(recap.locator(".recap-summary")).toContainText("1 favourite");
  await recap.getByRole("button", { name: "Close dialog" }).click();

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download trip backup" }).click();
  const output = testInfo.outputPath("recap-backup.json");
  await (await download).saveAs(output);
  const backup = JSON.parse(await readFile(output, "utf8"));
  expect(backup.journey.journal).toEqual({ [trip.id]: { "2026-10-13": { note: "Rain all morning, sun by the canal", favourites: [coffee.id] } } });

  // Trip mode, on phones, shows the favourite and the note on that day.
  if (testInfo.project.name === "mobile") {
    await page.getByRole("button", { name: "Today's plan" }).click();
    await page.getByRole("button", { name: "Previous day" }).click();
    await expect(page.locator(".trip-timeline .favourite-icon")).toHaveCount(1);
    await expect(page.locator(".trip-timeline").getByLabel("Day note")).toHaveValue("Rain all morning, sun by the canal");
  }
  expect(errors).toEqual([]);
});
