# Urja Meter Ops Portal — Protocol Discovery

This document describes how the legacy Urja Meter Ops portal actually works, as found through browser DevTools network inspection. It covers authentication, the internal endpoints discovered, and notable quirks in the data.

## 1. Authentication

- **Endpoint:** `POST https://urja-ops.flockenergy.tech/login`
- **Content-Type:** `application/x-www-form-urlencoded`
- **Body:** `email={email}&password={password}`
- **Required header:** `x-sveltekit-action: true` — without it, the SvelteKit backend treats the request as a normal page navigation and responds with an HTML redirect instead of processing it as a form action.
- **CSRF check:** the portal also rejects requests that don't carry `Origin`/`Referer` headers matching its own origin (`https://urja-ops.flockenergy.tech`) — a plain request without these gets `403 Forbidden`.
- **Session:** on success, the server sets a `__Secure-better-auth.session_token` cookie (HttpOnly, Secure). This must be attached to every subsequent request; there's no separate bearer-token mechanism.

## 2. Internal endpoints discovered

The portal is a SvelteKit app — most in-app navigation fires background `fetch` calls for JSON rather than doing full page reloads, which is how these were found in the Network tab.

### A. Meter list (paginated)
- `GET /portal/meters/search?q=&page={page_number}`
- Returns: `{ total, page, pageSize, data: [...] }`
- `pageSize` is 20. The full list is 403 meters across 21 pages — a client computes `Math.ceil(total / pageSize)` and walks each page to get everything.
- `q=` accepts a search string, suggesting server-side filtering is supported — not currently used by this wrapper.

### B. Meter energy data
- `GET /portal/meters/{meter_id}/energy`
- Returns a JSON array of readings: timestamp, `kwh`, `kvah`, `voltR`.

### C. Meter location (loaded client-side, not in the SSR HTML)
- `GET /portal/meters/{meter_id}/geo`
- Returns `{ data: { latitude, longitude } }`.
- **Quirk:** this data is not present in the server-rendered meter detail page. That page ships with a "Loading location..." placeholder and fetches this endpoint client-side after the initial render. A client that only fetches the SSR HTML never sees coordinates — this endpoint has to be called separately, in parallel with the HTML request.

### D. Meter details (nameplate) — the `devalue` quirk
- The portal's own internal JSON route is `GET /meters/{meter_id}/__data.json?x-sveltekit-invalidated=001`.
- This returns SvelteKit's `devalue`-serialized format: instead of plain key/value pairs, values are flattened into an array and referenced by index — a field like `"Installation Status"` maps to an integer, and that integer is a pointer into the array, not the value itself.
- **Decision:** writing a deserializer for `devalue`'s indexing scheme was judged unnecessary and brittle — it's an internal framework format, not a stable public contract, and could shift on any SvelteKit version bump. Instead, this wrapper requests the plain server-rendered HTML at `GET /meters/{meter_id}` and scrapes the nameplate `<dt>`/`<dd>` pairs directly with cheerio. Slightly more HTML to parse, considerably more stable.

### E. Distribution transformers
- `GET /portal/dts?page={page_number}`
- Returns paginated distribution transformers (`code`, `name`, `feederCode`, `capacityKva`).
- The portal has 40 distribution transformers across 2 pages (20 per page).
- Searching or filtering query parameters are ignored by this endpoint.

### F. Inconsistent Nameplate Markup in SSR HTML
The portal's server-rendered HTML does not follow a uniform naming standard across records:
- Some meters (e.g. `J100001`) use spaced labels: `<dt>Serial No</dt>` and `<dt>Installation Status</dt>`.
- Other meters (e.g. `J100004`) use concatenated labels: `<dt>SerialNo</dt>` and `<dt>InstallationStatus</dt>`.
- **Handling:** Rather than querying exact string literals with `:contains()`, the parser strips all whitespace, colons, and casing dynamically (`replace(/\s+|:/g, '').toLowerCase()`) to produce consistent dictionary keys regardless of layout variations.

## 3. Summary — how the wrapper's endpoints map to the legacy portal

| Wrapper endpoint | Legacy source(s) |
|---|---|
| `GET /api/v1/meters` | `GET /portal/meters/search` (paginated over 21 pages) |
| `GET /api/v1/meters/:id` | `GET /meters/:id` (HTML with whitespace-normalized tags) + `GET /portal/meters/:id/geo` (JSON), in parallel |
| `GET /api/v1/meters/:id/energy` | `GET /portal/meters/:id/energy` |
| `GET /api/v1/network/hierarchy` | `GET /portal/dts` (2 pages) + `GET /portal/meters/search` (joined by `dtCode` and `feederCode`) |