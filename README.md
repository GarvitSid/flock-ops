# Flock Energy — Urja Meter Ops API Wrapper

A REST API service that wraps the legacy "Urja Meter Ops" portal and exposes its meter data as clean, structured JSON. Built with Node.js/Express, using `axios` (with a cookie jar) to talk to the legacy portal and `cheerio` to parse its server-rendered HTML.

## Contents
- [What this is](#what-this-is)
- [Setup](#setup)
- [Running it](#running-it)
- [API](#api)
- [How it works](#how-it-works)
- [Assumptions & trade-offs](#assumptions--trade-offs)
- [What's left out](#whats-left-out)
- [PROTOCOL.md and openapi.json](#protocolmd-and-openapijson)
- [Reflection](#reflection)

## What this is

Urja Meter Ops is a portal utility staff use to look up smart meters — nameplate details, location, and energy data — by clicking around in a browser. It has no API. This service sits in front of it, handles login/session management, and exposes three clean endpoints that another program can consume without ever touching the portal itself.

## Setup

**Prerequisites:** Node.js v18+

```bash
git clone https://github.com/GarvitSid/flock-ops.git
cd flock-ops
npm install
```

Create a `.env` file in the project root:

```env
URJA_EMAIL=operator@urja.local
URJA_PASSWORD=urja-ops-2026
```

## Running it

```bash
node app.js
```

The server listens on `http://localhost:3000`. Note: The API uses a lazy-loaded session cache. It authenticates on the very first request and reuses that session cookie for all subsequent calls, keeping latency low.

## API & Interactive Documentation

**Interactive Browser UI:**
Open `http://localhost:3000/docs` in any browser to explore and execute live API requests directly via Swagger UI.

**Endpoints:**

**Get all meters** (paginates through the legacy portal automatically and returns the combined list):
```bash
curl http://localhost:3000/api/v1/meters
```

**Get one meter's details** (nameplate + location):
```bash
curl http://localhost:3000/api/v1/meters/<meterId>
```

**Get one meter's energy data:**
```bash
curl http://localhost:3000/api/v1/meters/<meterId>/energy
```

**Get network distribution hierarchy** (Reconstructed Feeder → DT → Meter topology):

```bash
curl http://localhost:3000/api/v1/network/hierarchy
```

## How it works

- **Auth:** `POST /login` on the portal as a SvelteKit form action — `application/x-www-form-urlencoded` body with `email`/`password`, plus an `x-sveltekit-action: true` header. A successful login sets a `__Secure-better-auth.session_token` cookie, which is held in a cookie jar (`tough-cookie` via `axios-cookiejar-support`) and sent automatically on subsequent requests.
- **CSRF:** the portal rejects login requests that don't look like they came from a real browser — plain `axios` POSTs got a `403 Forbidden` until `Origin` and `Referer` headers matching the portal's own origin were added.
- **Meter list:** `GET /portal/meters/search?q=&page=N` returns paginated JSON (`total`, `pageSize`, `data`). The wrapper walks every page sequentially and concatenates the results.
- **Meter detail & whitespace-agnostic parsing:** The server-rendered HTML at `/meters/:id` contains nameplate fields in `<dt>`/`<dd>` pairs, but the portal's markup is inconsistent across records (e.g. `J100001` renders `Serial No` while `J100004` renders `SerialNo`). The parser iterates through each `<dt>` tag dynamically, stripping all whitespace and colons to match keys reliably. Location is loaded client-side after initial render, so the wrapper calls `/portal/meters/:id/geo` in parallel via `Promise.all`.
- **Network hierarchy reconstruction:** The wrapper queries `/portal/dts` across all known pages to build a transformer catalog, fetches the meter inventory, and joins them in memory by `dtCode` and `feederCode` to expose a complete electrical distribution tree.
- **Session handling:** The Express middleware uses a lazy-loading session strategy. An internal `loginPromise` lock ensures that even if multiple requests arrive simultaneously on startup, the server only authenticates once, safely reusing the `session_id` cookie for subsequent proxy calls.

## Assumptions & trade-offs

- Assumed `operator@urja.local` has read-only access and it's safe to paginate through the portal aggressively without mutating anything.
- Assumed the nameplate HTML structure (the `<dt>`/`<dd>` pairs) is reasonably stable. This scraper depends on that layout not changing — if the portal's UI is redesigned, `getMeterDetails` breaks. That was a deliberate trade-off: parsing the SSR HTML with cheerio is simpler and more resilient than reverse-engineering SvelteKit's own `__data.json` payload, which encodes its data in an index-compressed format not meant for external consumers.
- Meter-list pagination is sequential rather than concurrent — slower, but avoids bursting the legacy server with parallel requests.
- Named the third endpoint `/energy` rather than the `/consumption` suggested in the brief, to mirror the legacy portal's own endpoint name (`/portal/meters/:id/energy`) rather than introduce a renamed abstraction.
- Against the live portal: 403 meters across 21 pages.

## What's left out

- **No in-memory caching:** Every `GET /api/v1/meters` call re-walks all 21 pages of the legacy portal live.
- **No retry/backoff:** If a request fails mid-pagination, the entire call returns 502.
- **No persistent database:** The proxy remains entirely stateless.

## PROTOCOL.md and openapi.json

Portal reverse-engineering notes (auth flow, endpoints discovered, data quirks) live in `PROTOCOL.md`. The OpenAPI 3.0 spec for this wrapper's own endpoints lives in `openapi.json`.

## Reflection

**What assumptions did you make?**
I assumed the provided credentials had read-only access, so it was safe to fetch and paginate aggressively without worrying about mutating the legacy system's state. I also assumed the portal's nameplate HTML is reasonably stable — since I chose to scrape `<dt>`/`<dd>` pairs with cheerio rather than parse SvelteKit's `__data.json`, the scraper depends on that markup not changing. If the utility redesigns the UI, that piece breaks first.

**Which part was most difficult, and how did you get unstuck?**
Getting the meter's GPS coordinates. The server-rendered HTML for a meter's detail page showed a "Loading location..." placeholder instead of actual coordinates — the portal fills that in client-side after the initial render. I got unstuck by watching the Network tab while loading that page in a browser and spotting a separate request to `/portal/meters/{id}/geo` firing after the page loaded. Once I found that, I just called it directly alongside the HTML fetch instead of trying to make the scraper wait for something that was never in the server response to begin with.


**What mistake did you make?**
My first login attempts failed with `403 Forbidden` because the portal rejects requests that lack `Origin` and `Referer` headers. I also initially got `null` back for coordinates because I missed that the `/geo` response nests the data an extra level (`response.data.data.latitude`, not `response.data.latitude`). Finally, my initial pass at the authentication flow submitted a full `POST /login` on every single incoming API request to avoid dealing with cookie expiration. I quickly realized this would hammer the legacy server under load, so I refactored it into a singleton `loginPromise` that caches the session securely.

**If you had another day, what would you improve?**
While session caching is now implemented via a singleton `loginPromise`, the API still relies on server restarts if the upstream session cookie expires mid-operation. With another day, I would add an Axios interceptor to catch `401 Unauthorized` or redirect responses and flip `isAuthenticated` to false for self-healing session recovery. I would also optimize `GET /api/v1/meters` either by implementing a short-lived TTL cache or by using the HMAC-authenticated `/portal/export` endpoint to pull all 403 meters in a single round-trip instead of walking 21 pages sequentially.

**If you were reviewing your own submission, what would you criticize?**
The biggest one is latency on `GET /api/v1/meters` — pulling all 403 meters means walking 21 pages sequentially, which is safe for the legacy server but slow for whoever's calling this API. Doing it sequentially was the right call to avoid hammering the portal, but a production version should cache that list (a few minutes' TTL would be plenty, since nameplates don't change often) instead of making every caller wait on 21 downstream requests.
