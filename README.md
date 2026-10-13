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

Each journey supports up to 10 city visits, each with 1-7 days and up to 60 places. Dates default to consecutive stays and update as durations or order change during setup. Arrival dates can be overridden or reset to the consecutive default. Date ranges are inclusive; one city can end on the next city's arrival date for a shared transfer day, but earlier overlapping arrivals are rejected.

After creation, switch city tabs to edit that city's hotel, dates, bookings, and place list. Imports append to the active city, and **Plan my days** plans only that city. Later city edits do not automatically shift other cities or their bookings. **Save trip** and backup export include every city. Drafts can be saved before selecting hotels; route generation requires a confirmed hotel and places. Existing single-city saved trips and backups remain readable.

Cities can be added or removed later. Intercity flights, trains, transfer time, and accommodation availability are not planned or booked.

## Hotel Search

Enter a hotel name or address under **Hotel or starting point**, then select the search icon. The app combines it with the active city and calls Google Places Text Search, returning up to five names and addresses. Select the matching address to confirm the location; the app then requests place details and fills the hotel timezone when Google provides one. The hotel becomes that city's route starting point and, when enabled, its daily return point. Search can be repeated with a more specific address.

Search requires allowlisted Google sign-in, the migrated Neon database for quota tracking, and the private `GOOGLE_MAPS_API_KEY` with Places API (New) enabled. The browser Maps key alone cannot perform hotel search; it displays the map. Missing connections are explained in the search dialog. Search and confirmation each reserve one service unit. Search candidates remain transient; confirmed place IDs and coordinates are saved, and accepted itinerary snapshots retain the displayed place names, addresses and coordinates. This is location search, not hotel availability, pricing, or booking.

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
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | Optional extraction provider/model for text, links, and images; takes precedence over Gemini for these sources, never for YouTube |
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

A whole multi-city journey and its per-city itinerary snapshots occupy one JSONB row and are saved atomically with one revision. Existing single-city rows are wrapped on load. This needs no additional SQL migration beyond the initial checked-in migration.

## Planning Behavior

**Plan my days** opens an editable popup for the active city. Opening it does not call Google or Gemini. Change daily hours, default transport, transit preferences, a standalone walking-leg limit, daily stop capacity, and hotel return. Each visit also has editable duration, day assignment, transport override, and optional status. Fixed bookings keep their day/time and remain required. Preferences can be applied to an incomplete hotel draft without buying routes.

**Day trips** adds explicit same-day groups within the existing hotel stay. Select members, eligible days, and whether the day excludes other visits. Groups are not inferred from names and do not create another hotel or satisfy a sightseeing visit merely by changing trains there. Required visits remain required; optional members may still be omitted. Conflicting retained day assignments must be explicitly released. Membership, eligible days, exclusivity and retained bookings are checked by both the schema and independent schedule validator. Older trips without groups are unchanged.

**Optimize preview** requires confirmed places and generates a suggested day-by-day itinerary with visit times, walking/transit legs, travel totals, omitted optional places, and warnings. Nothing is accepted until **Use this plan**. Acceptance saves the complete normalized schedule, route details and displayed places with the original trip/date/timezone context. Adjusting a preference invalidates the preview; closing the popup or a failed optimization preserves the previously accepted plan. **Apply preferences** saves the settings without generating a route and marks the retained itinerary out of date rather than erasing it. These changes remain subject to normal trip saving/autosave and backups.

Grouped or duration-flexible requests can instead return an untimed **Provisional outline** when route evidence, search or verification is incomplete. It has a distinct `status: "provisional"`, `verified: false` contract with unresolved travel and eligible days, not a `Schedule` with invented zero-minute legs. Neither preview flow offers approval for it, and it cannot replace the accepted itinerary or appear as verified map geometry. A provisional HTTP 200 response means there is an outline to review, not a solved itinerary. Responses remain authenticated, quota-controlled and `no-store`.

Routing does not use an LLM. Google Routes/Route Matrix travel estimates feed the existing HiGHS optimizer, which jointly assigns days and orders visits. Minimizing travel tends to group nearby places together while respecting bookings and capacity. Google's waypoint-order optimization alone is unsuitable here: transit routes do not support intermediate waypoints. **Balance daily activity** adds a weighted peak-day objective for visit, booking-buffer, and travel minutes; it excludes idle waiting and is not a guarantee of equally sized days or a global optimum.

For 26-60 places without explicit day groups, selective duration permissions or the opt-in native engine, the legacy two-second HiGHS assignment first groups visits geographically around booking gaps, visit durations and daily capacity. A failed grouping gets one bounded reassignment using cached walking links. Grouped and duration-flexible requests bypass these heuristic day assignments and jointly choose days, order and approved durations. Bounded geographic insertion supplies independently validated initial candidates; those assignments are hints, never new user locks. This is not an exhaustive search or a global route-optimality guarantee.

Per-place walking/transit overrides take precedence over the city default; the hotel return follows the city default. Standalone walks are limited to 1.5 km and any configured minute cap; these limits do not cover walks within a transit journey. Google's **Less walking** and **Fewer transfers** preferences are sent on actual-departure transit route checks, not treated as hard guarantees.

- Each city has one hotel, 1-7 days, and up to 60 stops (at most 25 per day); every stop is required unless explicitly marked optional.
- Fixed appointments retain their day/time and arrival buffer. Moving a city's start preserves booked calendar dates or rejects the change.
- The resolver shows remaining locked-time conflicts with per-visit **Make flexible** actions and a live lock count before previewing. **Allow all visit times to move** explicitly releases every original booking time for the proposed plan; individual reservations can be re-locked. These choices do not change days, durations or required visits, make paid requests, or mutate the draft until an approved preview is applied. Overlap-only failures focus the unresolved choices rather than asking about day changes or optional visits.
- **Resolve conflicts** starts with an explicit Google travel-gap check for consecutive fixed bookings and hotel departure/return. It requests only duration/distance at the relevant departure times, with no Places lookups, matrix, optimizer or AI calls; at most two route requests per connection and `2 * (fixed bookings + days)` requests overall (maximum 134). A nonempty check reserves 3 usage units; full previews retain the 30-unit charge. Direct-route estimates are advisory, not a proof of infeasibility, and unavailable estimates never become zero-minute routes.
- The guided flow keeps all current reservations locked by default. Only explicitly released times can move; other constraints remain unchanged unless separately approved. **Allow all flexible visits to change days** releases day assignments without making visits optional. Each unlocked visit defaults to its original duration; explicitly mark an eatery for up to 10% or 20% shortening, or permit a 15-minute visit to become 10 minutes. Eateries are not inferred from names. Selections grant permission, not immediate reductions; re-locking clears that visit's permissions. Locked reservation durations and arrival buffers remain unchanged. A failed preview exposes separate per-visit day and omission permissions. Only a verified, independently validated before/after proposal can be approved. Cancellation leaves the planning draft and saved trip untouched. Omitted optional visits stay in the trip; proposed visit times remain itinerary times, not new fixed reservations.
- Approved durations are individual choice variables in the HiGHS day/order model. Lexicographic tiers first minimize priority-weighted duration loss, then maximize explicitly optional visit utility, then optimize travel and the selected balance goal. A lower tier runs only after the preceding value is proven optimal for the sampled model, or reaches its known lower bound. Tiers and construction share the existing five-second pass budget; validated incumbents survive incomplete searches. Whole-minute choices round up, with a five-minute minimum and the separately approved 15-to-10-minute choice. `schedule.optimization` reports achieved weighted loss and proven tiers; a timed-out feasible result is not described as globally minimum loss. Protected bookings, buffers, required visits, groups, day limits and hotel returns remain enforced. Duration choices do not trigger additional provider acquisitions. Approval alone materializes chosen durations and removes transient permissions. The old uniform-level/restoration utility remains for comparison tests, not production planning.
- Explicit groups acquire hotel-to-member and member-to-hotel evidence before general local sampling, using up to three confirmed member endpoints and two bounded departure candidates on eligible dates. This phase uses at most 160 elements inside the unchanged 1,000-element budget. Transit is prioritized where allowed; no fictional station or centroid visits are introduced. Missing sampled bridges stop an exclusive required group early with a provisional outline, not a claim of real-world impossibility. Local candidates respect group eligibility and exclusivity; directed coverage must hold for all required group members on one common day. Google point-to-point transit routes can already contain trains, metro, station walks and transfers.
- Sparse route sampling prioritizes connections between consecutive fixed bookings, regardless of import order. If routing fails, booking diagnostics compare available travel gaps (including hotel departure/return) with shortest-path lower bounds across the sampled connections, not just a direct leg. These remain sampled-route diagnostics, not proof that no other route exists; day-group repair is still attempted.
- Joint/native, grouped and selective-duration previews check directed hotel reachability before solving. Missing required visits trigger targeted inbound/outbound queries to nearby reachable visits and the hotel, including a later transit departure where eligible. Up to five batches share at most 100 additional matrix elements within the existing 1,000-element cap; already queried connection/departure combinations are skipped. Walking observations are reused only on eligible days, and all existing transport, walking, booking, and hotel constraints remain enforced. Unrepaired coverage stops optimization without shortening visits. Repaired graphs still require a solver result and actual-departure verification.
- Planning preferences flag booking overlaps before requesting routes. **Any time slot** releases only that visit's time, retaining its assigned day and original source; unchecking restores the last booked time in the draft. Overlapping bookings offer the nearest available same-day time around other bookings and arrival buffers, explicitly **before travel**. Suggestions apply only when selected and do not guarantee route feasibility. Booked times and arrival buffers are editable. Closing discards draft edits; applying preferences commits them. The server rejects proven overlaps before reserving planning quota. Only release or move times that are flexible, not actual reservations.
- Google place candidates require user confirmation. Hotel confirmation also fills the IANA timezone when Google provides it.
- The optimizer assigns flexible sights and orders visits with real travel estimates. Its per-solve time limit is five seconds, with at most three solve/validate passes.
- Selected legs are queried again at the scheduled departure time, comparing walking and transit where allowed. The independent validator checks bookings, durations, connectivity, required stops, and hotel return.
- Transit candidate queries are budget-limited. A failed search is not a guarantee that no real-world route exists, and a successful result is not a globally optimal-route guarantee.
- When every visit has an assigned day, an infeasible result can identify blocked days with up to 0.5 seconds of additional solving per day against cached routes, without more Google requests. The diagnostic reports required-visit counts and durations; it does not move days or omit visits automatically.
- An infeasible transit preview can use one additional later-departure matrix sample (at most 200 elements, still within the 1,000-element total). Fixed visits use their booked end time; flexible visits use a midday sample. The hotel departure and all visit constraints remain unchanged. Sampled improvements only generate candidates: every selected leg must still pass actual-departure verification. Disconnected required visits and missing hotel connections are reported separately from booking overlaps.
- Transit is available only within Google's date horizon (up to 7 days past and 100 days ahead); outside it the app labels walking-only planning. Transit-only requests outside the horizon are rejected.
- Opening hours are not yet enforced. The itinerary explicitly asks users to check venue hours and ticket conditions. Accessibility, fares, and live transit reliability are not guaranteed.
- Neon saves, autosave and JSON backups retain accepted visit start/end times, outbound/inter-visit/return legs, walking/transit alternatives, polylines, transit steps and times, fares, estimate/timetable flags, warnings, generation timestamps, optimization metadata and displayed places. Reload, city switching and backup restore show the accepted snapshot without an automatic provider call. Saved routes are labeled as snapshots, not current/live checks; source edits preserve the original times/date/timezone and mark the itinerary out of date. Legacy order-only saves remain readable, but missing historical timings cannot be recovered automatically. Venue hours are not stored or enforced.

**Refresh travel times** follows the saved days and visit order, fetching each walking/transit connection at its chronological departure time, including hotel return. It does not regroup days, request a route matrix or invoke the optimizer. Durations, omissions, required visits and fixed bookings are retained; flexible visits can shift later when travel requires it. Published substitute timetables remain explicitly labeled as estimates, not actual trip-date service. The independently validated preview replaces saved timings/routes only after **Use refreshed times**; cancellation, missing routes, booking/day-end conflicts, changed input and provider failures preserve the saved itinerary. **Replan itinerary** is a separate explicit action if a different order is needed. Refresh reserves 3 service units per started block of 10 legs (minimum 3, maximum 21), with at most four route calls per leg including timetable fallbacks, no matrix calls and a shared 110-second place/route-work deadline. Missing place display data may require at most one place lookup per hotel/scheduled visit; matching saved places or confirmed coordinates are reused. Existing authentication, operation-ID deduplication and same-origin protections apply.

### Today And Day Recovery

On the actual trip date in the city's timezone, open **Itinerary > Today** from an accepted day, including a saved order restored from a backup or Neon. Record **Done** with actual start/finish times, correct those times explicitly, add **+10/+20 min**, or enter a custom **Ready to leave** time. **Skip visit** records a day-local fact without deleting the place. A fixed reservation requires **Record missed booking**; this does not cancel or refund its ticket. These local actions do not call paid providers.

Select the current hotel/place or opt in to one device-location reading. Accuracy errors and denied permission leave manual selection available. There is no background location tracking. **Leave now / Refresh route** checks only the chosen next leg and exposes Google walking/transit alternatives when available. Selecting a route preserves that preference for a later recovery; it does not certify the rest of the day. The map displays the observed route and current origin, not invented geometry.

**Replan today** solves only unfinished visits from the ready time to the real hotel when return is enabled. It first tries to keep every visit and duration; conditional alternatives use only specifically permitted skips and per-visit minimums, including custom whole-minute limits. Fixed bookings, their durations/buffers, group intent, walking limits and the day end remain protected. Preview exact times, order, shortened durations, skipped visits and hotel return before **Apply this recovery**. Failed, cancelled, superseded or more-than-two-minute-old checks cannot overwrite accepted day decisions. **Keep current plan** discards the proposal; **Undo last recovery** restores the previous remainder while retaining actual completed facts.

Confirmed progress and accepted remaining order/durations/skips are saved in Journey JSONB and backups. Accepted recovery also retains the exact timed day, normalized route details, checked/departure timestamps, places and selected origin, including a device-location origin if used for that accepted recovery. The previous remainder retains its snapshot for undo. Standalone next-route checks and unaccepted previews remain transient; there is no background location tracking. Source trip preferences, the baseline saved itinerary, other cities and future days are unchanged. Reloads display accepted recovery as a saved snapshot, never a fresh live check. Source edits require explicit reconciliation; the original timezone must be restored if actual timed progress exists. No additional SQL migration is required.

Each explicit next-route check reserves 3 service units; each replan reserves 30. Route checks permit at most two route calls and a 30-second operation deadline. Replanning shares at most 250 matrix elements, `max(12, 6 * (pending visits + 1))` route calls, a 45-second deadline and five seconds of solver work across at most three verification/correction passes. Already checked proposals survive failures while searching further alternatives. These are caps, not latency or feasibility guarantees. Live recovery never uses substitute timetable dates, assumed travel or geographic travel estimates. "Checked with Google at HH:MM" is not a guarantee of transit performance; venue hours and ticket conditions still need checking.

### Optional Timing Research

Select up to five non-booked places and explicitly consent before researching timings. Only those public place names/IDs and the city are sent to Gemini and Google Search, not hotels, booking details, dates, or imported documents. The default Flash-Lite model is configurable separately from document extraction. Availability and Search support depend on the provider and selected model.

The endpoint makes two bounded model calls: Search-grounded research, then structured extraction from that evidence. It requires source URLs and grounding metadata, validates stop/source references, uses a shared 45-second timeout, and does not automatically retry. The popup shows sources, original research, and sandboxed Google Search suggestions. Research failures leave manual preferences and route planning available.

Suggestions never overwrite visit durations automatically. Explicitly apply a suggested duration or enter your own. Time-of-day advice is advisory only: it does not create a booking, enforce opening hours, or constrain the solver. Use explicit day assignments and existing booking controls for hard constraints. Only accepted preferences and durations are saved; research evidence and raw route previews are session-only.

Each research request reserves five service units. The five-place limit, output-token limits, and two model calls are not a dollar cap: Google controls the number of grounding searches and its billing. Configure provider quotas and billing controls; review current grounding attribution and retention terms before deployment.

## Import Boundaries

Planning requests use the same 3.5 MB serialized body limit as cloud saves, so 60-stop trips can retain source notes and links without hitting the former 100 KB planning limit. The 60-stop schema limit is still enforced before quota is reserved.

Plain place lists can be reviewed without AI. Scheduled text, supported public links, images, and scanned PDFs use OpenRouter when configured, otherwise Gemini. YouTube requires Gemini. Consent names the actual provider and model, including OpenRouter's downstream model provider. Requests bind consent to that configuration; a mismatch is rejected before quota or provider use, with no silent fallback. Every result must be reviewed and confirmed. Raw uploads are not stored server-side; confirmed source excerpts and source URLs are saved with stops and included in backups. Whole-trip cloud save requests are limited to 3.5 MB; local JSON backup imports are limited to 10 MB. Cloud-provider retention terms still apply.

Import multiple sources into the active city to build its place list. Matching names (Unicode/case/whitespace-normalized) are flagged as possible duplicates and initially unchecked, including repeats within an import. **Skip duplicates** only deselects entries. Including duplicates, even through **Select all places**, requires confirming them as separate visits; editing or changing the selection resets that confirmation. The separate **Apply these duplicate updates** checkbox shows and approves missing date/time fields (and missing duration fields in new suggestions). Existing visit durations are never overwritten. Invalid, out-of-trip, conflicting, or ambiguous details are not merged. Approval resets when the reviewed data changes, and applied facts retain source evidence. Imports are limited to 25 suggestions per batch and the remaining capacity of the city's 60-place list.

The city-list **Review duplicates** action matches Google place IDs even when names, bookings, or source notes differ. When a location is unconfirmed it also flags identical names and narrow descriptive aliases such as "Sango" / "Sango Specialty Coffee" as possible matches; different confirmed place IDs remain separate. The comparison shows both visits and requires selecting which date, time, duration, and settings to keep before merging. Source notes and links are combined without truncation; oversized evidence blocks the merge. Map confirmation is retained when combining a confirmed and unconfirmed entry. **Keep both visits** leaves intentional repeat visits unchanged. Closing the review applies no pending selection. No visit is removed automatically.

The YouTube tab accepts a single watch, shortened `youtu.be`, Shorts, embed, or live video URL. Video links pasted into the Link tab are also recognized. Links are normalized to an HTTPS watch URL without tracking, timestamp, or playlist parameters. Gemini receives the URL directly through its native video input; the app does not scrape YouTube, download videos, or bypass access restrictions. Only public videos are supported; availability depends on the configured `GEMINI_MODEL`, provider restrictions, and the preview API. No extra YouTube API key is required. Processing uses the existing 40-second timeout and no automatic retries. Long or unavailable videos may fail; paste the relevant transcript into Text as a fallback. Video length is not capped by this app, and quota units are not a token/dollar ceiling; configure provider billing controls before use.

Video suggestions default to optional ideas with no booked dates, times, or inferred duration. The regular 45-minute editable visit default applies after confirmation. Video timestamps may appear in the source note but never become bookings. Other sources can also be imported as optional ideas; explicit bookings always remain required. All named locations and AI evidence need review. After confirming each location via Places, the Places view maps the entire collection; the Itinerary view maps the selected day's route. Confirmed coordinates and accepted itinerary geometry are persisted; no coordinates are invented, and unconfirmed names do not appear as map pins.

PDF.js extracts text and renders scanned pages locally. Local files are limited to 10 MB and PDFs to 10 pages. Images are resized before cloud extraction; each request stays below 3.5 MB serialized, under Vercel's 4.5 MB function limit. Password-protected documents are not supported.

The public-page fetcher accepts HTTPS only, validates all resolved IPs, pins the connection to validated addresses, checks redirects, rejects compressed/non-text content, and bounds response size/time. It does not execute scripts, send cookies, follow page links, or access private/paywalled accounts. Google Maps documented place/directions parameters are supported; opaque saved-list links require a pasted-list fallback.

## Cost And Security

Every paid endpoint requires an allowlisted session, same-origin mutation request, and a Neon-backed atomic daily quota reservation. A place lookup costs one service unit; an extraction batch costs three; timing research costs five; a planning preview costs 30, including each re-optimization. These are application limits, not dollar prices. Failed calls retain their reservation to prevent retry abuse. Repeated operation IDs are rejected rather than performing the paid operation twice.

Each planning run permits at most 1,000 billable matrix elements and `max(100, 6 * (grouped stop count + days))` route requests, at most 402 for 60 stops over 7 days. The route budget covers two modes over three validation passes. Matrix sampling reserves hotel and successor connections before extra alternatives, but cannot guarantee a feasible graph for every trip. Place details are additionally fetched for the hotel and stops. A standard account budget permits at most six planning attempts per UTC day, less when other services are used. Also set quotas at Google/OpenRouter: application limits cannot protect a leaked key or direct browser-map usage. Deployment abuse controls are required before removing the personal allowlist.

Google content is requested only when needed. Explicitly accepted itineraries retain the normalized route/place fields shown to the user, not raw provider responses or a reusable provider cache. Rendered snapshots retain Google Maps attribution and are not treated as live evidence. Review current Google Maps storage/retention permissions, billing-region restrictions and attribution requirements before deployment; this change does not certify provider-license compliance or implement automatic retention expiry. Trip deletion removes the live trip row, including its snapshots and saved recovery origins; exported files, provider records and database backups follow their own retention policies.

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

Live Neon/OAuth, Google/Gemini/OpenRouter responses, route rendering with a valid Maps key, and deployed Vercel cold-start performance still require credentialed smoke tests. Do not treat a successful local build as proof of live-provider or deployed compatibility.

Planner tests also cover geographic grouping, balanced activity, daily capacity, transport inheritance/overrides, hotel returns, walking limits, actual-departure Google requests, and consented grounded research with mocked provider HTTP. Popup tests cover draft cancellation, preview acceptance, failed re-optimization, manual duration overrides, source display, and fixed bookings. Playwright starts a separate credential-free server on port 3100 (override with `PLAYWRIGHT_PORT`), uses `.next/e2e`, and never reuses a signed-in development server. Paid popup responses are mocked.

### Offline Planning Benchmark

Run `npm run benchmark:planning` (or `node node_modules/vitest/vitest.mjs run src/lib/planning-benchmark.test.ts --reporter=verbose --silent=false`). The benchmark uses synthetic, deterministic 33-stop/four-day dense and sparse graphs, not retained Google content or a replay of a real trip. An independently validated witness proves each case is feasible. No paid APIs or saved trips are involved.

Both HiGHS strategies receive the same two-second solver budget. The opt-in `feasibility-first` experiment temporarily removes objective costs, then restores them and warm-starts optimization if it found an incumbent. Before the bounded construction hints were added, both strategies exhausted their budgets on this machine without a solution on either graph (4,488 and 1,480 edges). The historical measurements below are not current performance guarantees or diagnoses of a real preview failure. The reporting test allows an incomplete search; a passing reporting test alone does not mean an itinerary was found. Missing quality/violation metrics are `null`, not zero.

An isolated OR-Tools RoutingModel adapter consumes the identical inputs and returns candidates to the same independent validator. HiGHS remains the default; the app has an experimental opt-in integration via the absolute interpreter path in `TRAVELLER_ROUTING_PYTHON`. The asynchronous worker has a 15-second process limit, at most two concurrent processes per Node process, request cancellation, and a minimal credential-free payload/environment. No native runtime has been deployed or certified. Install its pinned dependency through your approved package registry:

Explicit groups or duration choices always use the coupled HiGHS model, including when that experimental environment variable is present; the native worker does not implement those decisions.

```sh
python3 -m venv /tmp/traveller-routing-benchmark
/tmp/traveller-routing-benchmark/bin/python -m pip install -r scripts/planning-requirements.txt
TRAVELLER_BENCHMARK_PYTHON=/tmp/traveller-routing-benchmark/bin/python node node_modules/vitest/vitest.mjs run src/lib/planning-benchmark.test.ts --reporter=verbose --silent=false
```

Without that variable, OR-Tools cases are explicitly skipped. When enabled, the two benchmark cases require a feasible, independently valid result; an installation or subprocess failure fails the check. Six additional adapter checks cover fixed bookings and arrival buffers, assigned days, transport and walking limits, optional disconnected visits, hotel returns, required missing routes, daily capacity, and daily end times.

Measured locally on macOS ARM64 with Python 3.13.4 and OR-Tools 9.14.6206 on 2026-10-12, using the same two-second search budget:

| Strategy | Dense graph | Sparse graph | First feasible solution | Final travel minutes | Validation violations |
| --- | --- | --- | --- | --- | --- |
| HiGHS optimized | Incomplete | Incomplete | None observed | Not available | No schedule |
| HiGHS feasibility-first | Incomplete | Incomplete | None observed | Not available | No schedule |
| OR-Tools RoutingModel | Feasible | Feasible | About 2 ms on each graph | 352 on each graph | 0 on each graph |

OR-Tools continued improving for the remaining search budget; its roughly 2 ms first-solution time is not total request latency. Successful reruns took about 2.1 seconds end to end, including about 65-67 ms for native import/model setup. Initial subprocess attempts hit the 15-second runner limit; a subsequent standalone native import took seven seconds before later runs became fast. The exact cause of those initial timeouts is unconfirmed. Startup metrics are reported separately and deployment cold starts remain an explicit risk; the runner and two-second solver limits were not increased.

These results do not establish that a real itinerary is solved. The latest authorized 33-stop/four-day live native preview returned incomplete searches on both the initial and later-transit graphs, with no first solution or actual-departure verification; saved trip data remained unchanged. Broader shuffled/mode integration cases also have unresolved failures. Async process limits, warm starts, DST/balancing coverage, request-local departure-indexed samples, and actual-departure repair are implemented, but representative live feasibility and deployed runtime compatibility remain gates. The solver still receives a static per-day graph selected from samples, not a transit timetable; OR-Tools objectives also differ from HiGHS's small timing and walking-distance tie breakers. Selective duration relaxation does not repair incomplete route construction or prove the live trip fits. Preserve the independent validator and approval flow, and do not retain Google responses for replay without checking applicable retention terms.

Planning API responses include ordered `diagnostics` once a stage runs, including provisional outcomes and errors. Group access, grouping, coverage repair, solving and actual-departure validation are distinct stages. Diagnostics report sanitized counts, elapsed time, engine, construction time, seed availability, first-solution callbacks, objective tiers and optimality, without place names, IDs, coordinates or raw provider responses. Matrix outcomes distinguish available, no route, provider error and excluded queries. Group-index/day/direction summaries additionally expose unqueried and outside-horizon evidence. The request-local ledger is not persisted. Failure codes distinguish hard input conflicts, sampled-model conflicts, missing data, incomplete search, provider errors, budget exhaustion and verification failure; they do not depend on the display-detail flag. A null first-solution callback is not zero latency and can coexist with an independently validated construction hint. All responses are `no-store`.

The 2026-10-12 authorized selective live check exercised connection repair: disconnected required visits fell from seven to five, but the run exhausted 1,000 matrix elements without full coverage. It reported 741 available entries, 160 no-route entries, 99 constraint-excluded entries, and no per-entry provider errors. No solver or actual-departure verification was reached, and saved data/revision remained unchanged. This is partial recovery, not a verified itinerary or proof that the remaining visits are unreachable in reality.

The redesigned pipeline passes a mocked 33-stop Amsterdam-shaped integration case: all 1,770 original visit minutes, all five Utrecht visits together on an exclusive day, four hotel round trips, independent validation and mocked actual-departure checks, within the existing budgets. It also tests moving a visit instead of shortening it, selective six-minute reduction when necessary, and missing group access without any optimizer call. These route times are synthetic, not retained Google data or verified Christmas transit. Desktop/mobile tests cover group editing, cancellation, non-approvable provisional outlines and preservation of accepted plans. No new paid Amsterdam preview or saved-trip change was performed; real dates, routes, venue hours and ticket conditions remain acceptance gates.

## Vercel

Import the repository as a Next.js project. Use separate Neon branches and secret values for preview and production deployments. Configure the environment variables and OAuth callback for each approved origin, apply migrations separately, then deploy. Do not broadly allow arbitrary preview domains on a production browser key.

The planning handler uses the Node.js runtime with a 120-second limit. Next.js externalizes `highs` and traces its WASM asset into the function. Before release, verify small known-answer routes and 25-, 26-, and 60-stop fixtures in a Vercel preview, inspect cold-start/runtime behavior, and verify actual Maps SKU usage. Local tests use mocked Google responses with the real optimizer for those sizes. No Vercel deployment is created automatically by this repository.