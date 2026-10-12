import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { newStop, newTrip } from "../src/lib/trip";

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
  for (const path of ["/api/plan", "/api/import", "/api/places"]) {
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