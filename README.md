# Traveller

A personal multi-city travel workspace built with Next.js, Google Maps, Neon Postgres, and a bounded HiGHS schedule optimizer.

## Local Development

Use a supported Node.js LTS release (22.13+ or 24+). The current lockfile was built and checked on Node.js 26.3.0.

```sh
npm ci
npm run dev
```

Open http://localhost:3000. Without credentials, multi-city setup, manual place entry, booking editing, pasted-list review, and JSON backup export/import work. Hotel/place search, maps, cloud saving, AI extraction, and route generation require the connections below. Unsaved drafts exist in the current browser tab only; save or export before leaving.

## Quick Trip Setup

Choose **New trip**, enter a title and departure date, then add cities. Paris, Amsterdam, and Brussels have quick-add buttons. The city field also suggests London, Rome, Barcelona, Berlin, Prague, Lisbon, Vienna, Tokyo, and New York. These are curated presets, not a live popularity ranking. Presets fill the timezone; quick-add buttons also fill an editable suggested stay length. Any custom city is accepted, with an editable IANA timezone that defaults to UTC.

Each journey supports up to 10 city visits, each with 1-7 days and up to 25 places. Dates default to consecutive stays and update as durations or order change during setup. Arrival dates can be overridden or reset to the consecutive default. Date ranges are inclusive; one city can end on the next city's arrival date for a shared transfer day, but earlier overlapping arrivals are rejected.

After creation, switch city tabs to edit that city's hotel, dates, bookings, and place list. Imports append to the active city, and **Plan my days** plans only that city. Later city edits do not automatically shift other cities or their bookings. **Save trip** and backup export include every city. Drafts can be saved before selecting hotels; route generation requires a confirmed hotel and places. Existing single-city saved trips and backups remain readable.

Cities can be added or removed later. Intercity flights, trains, transfer time, and accommodation availability are not planned or booked.

## Hotel Search

Enter a hotel name or address under **Hotel or starting point**, then select the search icon. The app combines it with the active city and calls Google Places Text Search, returning up to five names and addresses. Select the matching address to confirm the location; the app then requests place details and fills the hotel timezone when Google provides one. The hotel becomes that city's route starting point and, when enabled, its daily return point. Search can be repeated with a more specific address.

Search requires allowlisted Google sign-in, the migrated Neon database for quota tracking, and the private `GOOGLE_MAPS_API_KEY` with Places API (New) enabled. The browser Maps key alone cannot perform hotel search; it displays the map. Missing connections are explained in the search dialog. Search and confirmation each reserve one service unit. Hotel names, addresses, and coordinates returned by Google are transient; the confirmed place ID and user-entered text are saved. This is location search, not hotel availability, pricing, or booking.

## Connections

Set local values in an ignored `.env.local` at the project root. `.env.example` lists all variables. Never paste secrets into itinerary fields, commit them, or expose server keys with a `NEXT_PUBLIC_` prefix.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Neon pooled Postgres connection string; use TLS |
| `AUTH_SECRET` | Random authentication secret, at least 32 bytes of entropy |
| `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | Google OAuth web-client credentials |
| `ALLOWED_EMAILS` | Comma-separated personal email allowlist; verified Google email required |
| `AUTH_URL` | Canonical app origin; localhost for local use, deployed HTTPS origin on Vercel |
| `GOOGLE_MAPS_API_KEY` | Server-only Places API (New) and Routes API key |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | Browser key restricted to Maps JavaScript API and allowed website referrers |
| `NEXT_PUBLIC_GOOGLE_MAP_ID` | Google map ID for advanced markers; Google's demo map ID is used if omitted |
| `GOOGLE_GENERATIVE_AI_API_KEY`, `GEMINI_MODEL` | Paid Gemini key and an available multimodal model supporting structured output |
| `GEMINI_TIMING_MODEL` | Optional Search-grounded timing model; defaults to `gemini-2.5-flash-lite`, independently of the import model |
| `DAILY_USAGE_LIMIT` | Per-account daily service-unit cap; default 200 |

Register `http://localhost:3000/api/auth/callback/google` and the corresponding deployed URL as OAuth redirect URIs. Use one hostname consistently: a localhost OAuth callback is different from 127.0.0.1.

Enable billing and Maps JavaScript API, Places API (New), and Routes API in Google Cloud. Restrict browser keys by exact origins and API; restrict the private server key by API. Vercel has dynamic egress by default, so do not configure an arbitrary server IP restriction. Configure hard provider quotas as well as billing alerts. Alerts do not cap charges.

Next.js embeds `NEXT_PUBLIC_` values at build time. Restart development or redeploy after changing them. Backend connection flags indicate variable presence, not tested connectivity.

## Database

Apply the checked-in Drizzle migration before using saved trips or paid endpoints. Drizzle commands read `DATABASE_URL` from the process environment; provide it securely in your terminal environment or CI secret configuration.

```sh
npm run db:migrate
```

After schema changes:

```sh
npm run db:generate
```

The schema stores owner-scoped trips, accepted day/stop order, optimistic revisions, daily usage counters, and operation IDs. A stale revision cannot overwrite a newer edit. Retain operation IDs for idempotency; old usage and operation records can be pruned under an explicit maintenance policy. There is no automatic database migration during a build.

A whole multi-city journey and its per-city saved orders occupy one JSONB row and are saved atomically with one revision. Existing single-city rows are wrapped on load. This multi-city change needs no additional SQL migration beyond the initial checked-in migration.

## Planning Behavior

**Plan my days** opens an editable popup for the active city. Opening it does not call Google or Gemini. Change daily hours, default transport, transit preferences, a standalone walking-leg limit, daily stop capacity, and hotel return. Each visit also has editable duration, day assignment, transport override, and optional status. Fixed bookings keep their day/time and remain required. Preferences can be applied to an incomplete hotel draft without buying routes.

**Optimize preview** requires confirmed places and generates a suggested day-by-day itinerary with visit times, walking/transit legs, travel totals, omitted optional places, and warnings. Nothing is accepted until **Use this plan**. Adjusting a preference invalidates the preview; closing the popup or a failed optimization preserves the previously accepted plan. **Apply preferences** saves the settings without generating a route and invalidates the previous saved order. These changes remain subject to normal trip saving/autosave and backups.

Routing does not use an LLM. Google Routes/Route Matrix travel estimates feed the existing HiGHS optimizer, which jointly assigns days and orders visits. Minimizing travel tends to group nearby places together while respecting bookings and capacity. Google's waypoint-order optimization alone is unsuitable here: transit routes do not support intermediate waypoints. **Balance daily activity** adds a weighted peak-day objective for visit, booking-buffer, and travel minutes; it excludes idle waiting and is not a guarantee of equally sized days or a global optimum.

Per-place walking/transit overrides take precedence over the city default; the hotel return follows the city default. The walking cap applies only to standalone walking legs, not walks within a transit journey. Google's **Less walking** and **Fewer transfers** preferences are sent on actual-departure transit route checks, not treated as hard guarantees.

- Each city has one hotel, 1-7 days, and up to 25 stops; every stop is required unless explicitly marked optional.
- Fixed appointments retain their day/time and arrival buffer. Moving a city's start preserves booked calendar dates or rejects the change.
- Google place candidates require user confirmation. Hotel confirmation also fills the IANA timezone when Google provides it.
- The optimizer assigns flexible sights and orders visits with real travel estimates. Its per-solve time limit is five seconds, with at most three solve/validate passes.
- Selected legs are queried again at the scheduled departure time, comparing walking and transit where allowed. The independent validator checks bookings, durations, connectivity, required stops, and hotel return.
- Transit candidate queries are budget-limited. A failed search is not a guarantee that no real-world route exists, and a successful result is not a globally optimal-route guarantee.
- Transit is available only within Google's date horizon (up to 7 days past and 100 days ahead); outside it the app labels walking-only planning. Transit-only requests outside the horizon are rejected.
- Opening hours are not yet enforced. The itinerary explicitly asks users to check venue hours and ticket conditions. Accessibility, fares, and live transit reliability are not guaranteed.
- Saved plans retain day/stop order, not Google route responses. Reopening requires route refresh; the current refresh action generates a newly checked candidate and may choose a different order. Venue hours, polylines, transit details, and Google coordinates are not persisted in Neon or backups.

### Optional Timing Research

Select up to five non-booked places and explicitly consent before researching timings. Only those public place names/IDs and the city are sent to Gemini and Google Search, not hotels, booking details, dates, or imported documents. The default Flash-Lite model is configurable separately from document extraction. Availability and Search support depend on the provider and selected model.

The endpoint makes two bounded model calls: Search-grounded research, then structured extraction from that evidence. It requires source URLs and grounding metadata, validates stop/source references, uses a shared 45-second timeout, and does not automatically retry. The popup shows sources, original research, and sandboxed Google Search suggestions. Research failures leave manual preferences and route planning available.

Suggestions never overwrite visit durations automatically. Explicitly apply a suggested duration or enter your own. Time-of-day advice is advisory only: it does not create a booking, enforce opening hours, or constrain the solver. Use explicit day assignments and existing booking controls for hard constraints. Only accepted preferences and durations are saved; research evidence and raw route previews are session-only.

Each research request reserves five service units. The five-place limit, output-token limits, and two model calls are not a dollar cap: Google controls the number of grounding searches and its billing. Configure provider quotas and billing controls; review current grounding attribution and retention terms before deployment.

## Import Boundaries

Plain place lists can be reviewed without AI. Scheduled text, supported public links, images, scanned PDFs, and public YouTube videos use consented Gemini extraction. Every result must be reviewed and confirmed. Raw uploads are not stored server-side; confirmed source excerpts and source URLs are saved with stops and included in backups. Whole-trip cloud save requests are limited to 3.5 MB; local JSON backup imports are limited to 10 MB. Cloud-provider retention terms still apply.

Import multiple sources into the active city to build its place list. Review checkboxes control which suggestions are appended; existing places and bookings are never replaced. Matching names (Unicode/case/whitespace-normalized) are flagged as possible duplicates and initially unchecked, including repeats within an import. A summary shows the duplicate count and whether any are selected. **Skip duplicates** deselects matching entries without deleting them. Including duplicates, even through **Select all places**, requires explicitly confirming them as separate visits; editing or changing the selection resets that confirmation. This is not semantic or Google place-ID deduplication: aliases need manual review. Selection is limited by the remaining capacity of the city's 25-place list, not by the raw number of suggestions.

The YouTube tab accepts a single watch, shortened `youtu.be`, Shorts, embed, or live video URL. Video links pasted into the Link tab are also recognized. Links are normalized to an HTTPS watch URL without tracking, timestamp, or playlist parameters. Gemini receives the URL directly through its native video input; the app does not scrape YouTube, download videos, or bypass access restrictions. Only public videos are supported; availability depends on the configured `GEMINI_MODEL`, provider restrictions, and the preview API. No extra YouTube API key is required. Processing uses the existing 40-second timeout and no automatic retries. Long or unavailable videos may fail; paste the relevant transcript into Text as a fallback. Video length is not capped by this app, and quota units are not a token/dollar ceiling; configure provider billing controls before use.

Video suggestions default to optional ideas with no booked dates, times, or inferred duration. The regular 45-minute editable visit default applies after confirmation. Video timestamps may appear in the source note but never become bookings. Other sources can also be imported as optional ideas; explicit bookings always remain required. All named locations and AI evidence need review. After confirming each location via Places, the Places view maps the entire collection; the Itinerary view maps the selected day's route. No coordinates are invented or persisted, and unconfirmed names do not appear as map pins.

PDF.js extracts text and renders scanned pages locally. Local files are limited to 10 MB and PDFs to 10 pages. Images are resized before cloud extraction; each request stays below 3.5 MB serialized, under Vercel's 4.5 MB function limit. Password-protected documents are not supported.

The public-page fetcher accepts HTTPS only, validates all resolved IPs, pins the connection to validated addresses, checks redirects, rejects compressed/non-text content, and bounds response size/time. It does not execute scripts, send cookies, follow page links, or access private/paywalled accounts. Google Maps documented place/directions parameters are supported; opaque saved-list links require a pasted-list fallback.

## Cost And Security

Every paid endpoint requires an allowlisted session, same-origin mutation request, and a Neon-backed atomic daily quota reservation. A place lookup costs one service unit; an extraction batch costs three; timing research costs five; a planning preview costs 30, including each re-optimization. These are application limits, not dollar prices. Failed calls retain their reservation to prevent retry abuse. Repeated operation IDs are rejected rather than performing the paid operation twice.

Each planning run permits at most 1,000 billable matrix elements and 100 route requests. A standard account budget therefore permits at most six full planning attempts per UTC day, less when other services are used. Also set quotas at Google/Gemini: application limits cannot protect a leaked key or direct browser-map usage. Deployment abuse controls are required before removing the personal allowlist.

Google content is requested only when needed and is not stored as a persistent route/place cache. Place IDs and user-authored itinerary data are retained. Review current Google Maps terms, billing-region restrictions, and attribution requirements before a public release. Trip deletion removes the live trip row; provider records and database backups follow their own retention policies.

## Verification

```sh
npm test
npm run typecheck
npm run lint
npm run build
npx playwright install chromium
npm run test:e2e
```

Unit tests cover city presets and date rules, malformed backups, legacy restoration, atomic owner/revision-scoped saves, booking/date constraints, DST, required-stop coverage, missing routes, optional omission, import interpretation, private-address rejection, YouTube URL validation, provenance, and actual Gemini SDK video serialization with mocked HTTP. Browser tests cover preset/custom city setup, adding/removing cities, independent hotels/bookings, whole-journey backups, hotel-search configuration guidance, manual editing, repeated-source selection, duplicate warnings, YouTube consent, source links, protected APIs, and desktop/mobile layouts without external service credentials. Screenshots are written under ignored `test-results/`.

Live Neon/OAuth, Google/Gemini responses, route rendering with a valid Maps key, and deployed Vercel cold-start performance still require credentialed smoke tests. Do not treat a successful local build as proof of live-provider or deployed compatibility.

Planner tests also cover geographic grouping, balanced activity, daily capacity, transport inheritance/overrides, hotel returns, walking limits, actual-departure Google requests, and consented grounded research with mocked provider HTTP. Popup tests cover draft cancellation, preview acceptance, failed re-optimization, manual duration overrides, source display, and fixed bookings. Playwright starts a separate credential-free server on port 3100 (override with `PLAYWRIGHT_PORT`), uses `.next/e2e`, and never reuses a signed-in development server. Paid popup responses are mocked.

## Vercel

Import the repository as a Next.js project. Use separate Neon branches and secret values for preview and production deployments. Configure the environment variables and OAuth callback for each approved origin, apply migrations separately, then deploy. Do not broadly allow arbitrary preview domains on a production browser key.

The planning handler uses the Node.js runtime with a 120-second limit. Next.js externalizes `highs` and traces its WASM asset into the function. Before release, verify a small known-answer route and a 25-stop fixture in a Vercel preview, inspect cold-start/runtime behavior, and verify actual Maps SKU usage. No Vercel deployment is created automatically by this repository.