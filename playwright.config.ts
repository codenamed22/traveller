import { defineConfig } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT || 3100);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: { baseURL, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { browserName: "chromium", viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { browserName: "chromium", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: `npm run dev -- --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    env: {
      PLAYWRIGHT_TEST: "1", DATABASE_URL: "", AUTH_SECRET: "", AUTH_GOOGLE_ID: "", AUTH_GOOGLE_SECRET: "", ALLOWED_EMAILS: "", AUTH_URL: baseURL,
      GOOGLE_MAPS_API_KEY: "", NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: "", GOOGLE_GENERATIVE_AI_API_KEY: "",
    },
  },
});