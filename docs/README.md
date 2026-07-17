# Bulk Comment Exporter — Project Notes

This document is a record of how this app came to exist: what problem it solves, how the
underlying ExportComments.com API was reverse-engineered, and what was built. Written for
whoever picks this up next (including future-you).

## Origin story

The starting ask was simple: "export the comments off a batch of Facebook reel links." The
obvious path — go to exportcomments.com, click through the UI, paste links, click Export —
works, but doesn't scale past a handful of URLs and can't be automated or scheduled.

Getting to an API-first solution took a detour through browser automation, because the target
site's API isn't publicly documented. The rough path:

1. **Tried Selenium against a real Brave profile.** RuskMedia has a paid ExportComments.com
   account logged into a dedicated Brave profile ("RuskMedia", `Profile 18`). The first instinct
   was to clone that profile's cookies into a scratch directory and drive it with
   `selenium.webdriver.Chrome(options)` pointed at the Brave binary.
2. **Hit a wall: `Mach rendezvous failed, terminating process (parent died?)`.** This happened
   whenever ChromeDriver tried to *spawn* Brave as a child process — even from a plain
   Terminal.app window, not just the agent's sandboxed shell. Root cause was never fully
   isolated (something in this Mac's environment breaks Chromium's parent/child Mach IPC
   handoff when the parent is chromedriver), but the workaround was clean:
   **launch Brave yourself, then have Selenium *attach*** via
   `--remote-debugging-port=9222 --remote-allow-origins=*`, using
   `options.debugger_address = "127.0.0.1:9222"` instead of `options.binary_location`. Chromedriver
   never spawns anything in this mode, so the crash never triggers.
3. **Captured the real network traffic** by opening a raw WebSocket to Brave's DevTools Protocol
   (`Network.enable`, listening for `Network.requestWillBeSent` / `Network.responseReceived`)
   alongside Selenium driving the UI (fill textarea, click toggle, click submit). This is how the
   actual API calls were discovered — Selenium alone can't stream network events, only issue
   commands, so a second raw `websocket-client` connection was needed in parallel.
4. **Once the API shape was known, the browser became unnecessary.** Every subsequent step —
   submitting batches, polling status, listing jobs, downloading files — turned out to be a
   plain authenticated REST call. The Bearer JWT lifted from a captured request header is the
   only thing that came from the browser session; everything after that is `requests`/`fetch`
   calls with no browser in the loop.

## The reverse-engineered API

Base hosts: `exportcomments.com` (export submission/status) and `app.exportcomments.com`
(account/jobs dashboard — this is what the "My Exports" UI page itself calls).

All endpoints below require `Authorization: Bearer <JWT>`. The token is a standard RS256 JWT —
decode the payload (`base64` on the middle segment) to read `exp` without hitting the network at
all. It's tied to the ExportComments.com account (`dataanalytics@ruskmedia.com`, Premium plan)
and is obtained by logging into the RuskMedia Brave profile and capturing any authenticated
request's `Authorization` header (e.g. via DevTools Network tab, or the CDP-listener technique
above).

### 1. Submit a batch

```
POST https://exportcomments.com/api/v1/batch-export
Content-Type: application/json
Authorization: Bearer <JWT>

{
  "urls": ["https://www.facebook.com/reel/...", ...],   // max 25 — hard, server-enforced plan limit
  "options": { "replies": true }
}
```

- `201 Created` → `{ "batchId": "...", "submitted": 25, "errors": [], "guids": ["...", ...] }`
- `400 Bad Request` if you submit more than 25:
  `{"error":"Maximum 25 URLs per batch on your plan. You submitted 26."}`
- One `guid` is minted per URL, in submission order.

### 2. Poll batch status

```
GET https://exportcomments.com/api/v1/batch-export/{batchId}
Authorization: Bearer <JWT>
```

Returns per-URL live status plus aggregate counts:

```json
{
  "batch_id": "...",
  "total": 25,
  "done": 16,
  "error": 9,
  "in_progress": 0,
  "is_complete": true,
  "progress_pct": 100,
  "exports": [
    { "guid": "...", "url": "...", "status": "done" | "queueing" | "in_progress" | "error", "total": 1, "totalExported": 1 }
  ]
}
```

Poll on an interval (this project uses 3s) until `is_complete: true`. In testing, roughly a
third of URLs in a 25-URL batch came back `error` with `total: 0` — this appears to correlate
with reels that genuinely have zero comments or are otherwise inaccessible (deleted, private,
comments disabled), not a systemic API flakiness. No retry logic was added for this reason —
see "Decisions" below.

### 3. Get download links

There is **no per-batch or per-guid download endpoint.** The only way to get a `download_url` is
the account-wide jobs listing (this is the same endpoint that powers the "My Exports" table in
the app.exportcomments.com dashboard):

```
GET https://app.exportcomments.com/api/v1/jobs?page=1&limit=25
Authorization: Bearer <JWT>
```

```json
{
  "metadata": { "total_items": 1190, "items_per_page": 25, "current_page": 1, "last_page": 48 },
  "items": [
    {
      "comment": {
        "url": "...",
        "guid": "...",
        "status": "done",
        "file_name": "fb-comments_<postId>_<hash>.xlsx",
        "total_exported": 1,
        "batch_id": "...",
        "download_url": "https://exportcomments.com/exports/fb-comments_<postId>_<hash>.xlsx",
        "error": null
      }
    }
  ]
}
```

Items are ordered newest-first across the *entire account history* (1000+ jobs on this
account), not scoped to a single batch — filter client-side by matching `comment.batch_id`
against the batch you just submitted. This is safe as long as nothing else on the account is
submitting exports concurrently (a 25-URL batch always fits entirely on page 1 right after it
completes, since it's the 25 most recent items).

`download_url` itself needs **no authentication** — it's a Cloudflare-fronted static file at an
unguessable hash, directly `fetch`-able or open-able in a new tab.

### 4. Cheap auth-check endpoint

```
GET https://exportcomments.com/api/v1/me
Authorization: Bearer <JWT>
```

`200` = token still valid server-side (not just unexpired by clock). Lighter than hitting
batch-export just to test a token. **Caveat:** this endpoint's response body includes the
account's Argon2 password hash (`"password":"$argon2i$..."`) — almost certainly a bug on
ExportComments.com's end, not something this project relies on, but worth knowing before piping
that response anywhere it might get logged.

### Endpoints that do *not* exist (tried and got 404)

`/api/v1/user`, `/api/v1/profile`, `/api/v1/export/{guid}`, `/api/v1/export/{guid}/download`,
`/api/v1/batch-export/{batchId}/download`, `/api/v1/comments/{guid}`. Worth remembering so
nobody re-guesses these.

### CORS

The API only sends `Access-Control-Allow-Origin` for `exportcomments.com` /
`app.exportcomments.com` themselves. A browser `fetch()` from any other origin (including
`localhost`) is blocked by the browser — this is why the Next.js app proxies through its own API
routes (server-to-server calls aren't subject to CORS) instead of calling the API directly from
client-side JS.

## What was built

A Next.js 16 (App Router, Turbopack) app, `export-comments/`, currently a **single page**
(`app/BatchExporter.tsx`, rendered by `app/page.tsx`). It started as two pages — a bulk exporter
and a separate `/csv-strip` cleaning tool — but the CSV tool was folded into the main page since
its whole purpose was feeding URLs into the exporter anyway; keeping them separate just added a
navigation hop and a `sessionStorage` handoff for no benefit.

### CSV ingestion (top of the page)

- Drag-and-drop or click-to-upload a CSV. Parsing is client-side via `app/csvUtils.ts` (a
  hand-rolled RFC-4180 parser, index-based string slicing rather than per-character
  concatenation — the latter is O(n²) and was observed crashing the tab on the real-world files
  here, which run into the hundreds of MB).
- Accepts either the **raw** Facebook post-metrics export (`Post ID`, `Title`, `Description`,
  `Permalink`, `Publish time`, `Comments` — one row per metric-period per post) or an
  already-cleaned CSV; dedupes by `Permalink`, summing `Comments` across every duplicate row
  for that link (each row is a per-day count, not cumulative, so summing is correct).
- Shows **total rows / unique links / unique links with comments** immediately after upload —
  useful because on real exports the majority of "posts" have zero comments (observed: ~74% on
  a 1,977-post sample) and there's no point submitting those to the exporter.
- **"Only process links with comments" checkbox** — filters the URL list down to the nonzero
  subset.
- **Search box + scope selector** (Title only / Description only / both) — free-text filter
  against the parsed Title/Description, applied on top of the comments checkbox, updates the URL
  textarea to just the matches. A "Clear search" button resets it.
- **"Download cleaned CSV" button** — exports whatever the current filter shows (Title,
  Description, Permalink, Publish time, Comments), sorted by comments descending.

### Token handling

- Bearer token input, persisted to `localStorage` (`bulkExporter.token`) once it passes a
  **"Check token" button** that hits `/api/me` (a thin proxy to ExportComments.com's
  `GET /api/v1/me`, see below) — so a non-technical user doesn't have to re-paste it every visit
  within its ~24h life.
- A collapsible "How do I get my token?" panel walks through pulling the JWT out of DevTools'
  Network tab against `app.exportcomments.com/user/exports` (that page fires a `/me` request on
  load, the easiest one to spot).
- The same validation call also runs as a **pre-flight check before every batch** during a run —
  if the token has died mid-run, the whole queue aborts with a clear message instead of burning a
  submit call that would just 401.

### Running a batch

- URLs are chunked into batches of 25 (`BATCH_SIZE`) and processed **sequentially, not in
  parallel** — a deliberate choice (see Decisions).
- Each batch: validate token → submit → poll every 3s → once `is_complete`, fetch `/api/v1/jobs`
  and filter by `batch_id` → move to next batch.
- **Live per-URL status cards** during polling: the `exports` array from the status endpoint is
  rendered directly as it updates (`queueing` → `in_progress` → `done`/`error`).
- Failed URLs (no comments / inaccessible) are shown inline as "No comments found" and don't
  halt the run — only a hard API error (bad token, network failure, timeout) stops the whole
  queue, reporting which batch number it died on.
- **Persistence**: URL list, "include replies" checkbox, and results all auto-save to
  `localStorage` and reload on refresh — a run's progress survives an accidental tab reload.

### Bulk downloading results

- **"Download all N as ZIP"** button once results are in. Built on `client-zip`, not `jszip`,
  specifically to avoid buffering: fetched file `Response` bodies are handed to `client-zip`
  *unread* and streamed straight into the ZIP output as they're compressed, bounded to
  `ZIP_CONCURRENCY` (6) in-flight fetches at a time — not the sum of every file's size, which is
  what an in-memory-Blob-per-file approach (the first version, using `jszip`) would do and which
  risks the same tab-crash class of bug as the CSV parser above on a run of ~1800 files.
- On Chrome/Edge, uses the File System Access API (`showSaveFilePicker` +
  `createWritable().pipeTo()`) to stream directly to disk — memory stays roughly constant
  regardless of archive size. Safari/Firefox fall back to buffering the finished (already
  streamed-and-compressed) zip as one `Blob`, still only one copy in memory rather than every
  file plus the archive.
- Individual per-file fetch failures are skipped and counted, not fatal to the whole ZIP.

### Reset session

- Pinned in a sticky bar at the top of the page (not buried at the bottom under everything else).
- Confirms via a SweetAlert2 dialog before clearing (it's destructive: URLs, results, the loaded
  CSV, and all filters). **Deliberately does not clear the saved token** — re-entering it is the
  single most annoying step in the whole flow for a non-technical user, and "reset" here means
  "start a new batch of work," not "log out."

### API routes (`app/api/*/route.ts`)

Thin server-side proxies, nothing more:
- `app/api/batch-export/route.ts` — `POST` forwards to `.../api/v1/batch-export`; `GET
  ?batchId=` forwards to `.../api/v1/batch-export/{batchId}`.
- `app/api/jobs/route.ts` — `GET ?page=&limit=` forwards to
  `https://app.exportcomments.com/api/v1/jobs`.
- `app/api/me/route.ts` — `GET` forwards to `.../api/v1/me`, and **strips the `password` field**
  from the response before it reaches the browser (that endpoint leaks an Argon2 hash server-side
  — see section 4 above; this proxy exists specifically so that leak never reaches client-side
  code, network tabs, or logs beyond this one server hop).

All three require an `Authorization` header on the incoming request and just relay it upstream —
**the token is never stored server-side**, only in the browser's `localStorage`/React state.

## Decisions worth knowing the reasoning behind

- **Sequential batches, not parallel.** Firing all N batches concurrently would finish faster,
  but (a) a single 25-URL batch already showed ~36% error rate under normal conditions, so
  there's reason to suspect the account/worker pool has limited concurrency and parallel batches
  could compound failures or trigger rate-limiting, and (b) it keeps the UI state trivial — one
  batch, one progress bar, one set of live cards at a time.
- **No auto-retry on errored URLs.** Confirmed with the requester that errors are expected to be
  mostly "genuinely has no comments," not transient failures — so retrying would just waste
  quota re-submitting URLs that will fail again.
- **Zero-dependency proxy, not a separate Express/Node server.** An earlier throwaway prototype
  used a hand-written `http`/`https` Node proxy server (see git history if curious) built to
  route around an `npm install` failure in the sandboxed dev shell (large `@next/swc-*` binaries
  wouldn't fetch). That failure turned out to be sandbox-specific — installing from a normal
  terminal worked fine — so the project was redone as a proper Next.js app once that was
  confirmed, and the standalone proxy was discarded.
- **Client-side CSV parsing over a library.** `csvUtils.ts` is ~50 lines and handles quoted
  fields correctly; pulling in `papaparse` or similar for this was judged unnecessary.
- **One merged page, not two.** The original two-page split (exporter + CSV stripper) only
  existed because the CSV tool was bolted on mid-project; once it became clear its sole consumer
  was the exporter's URL box, keeping a second route/nav/`sessionStorage` handoff around was
  pure overhead. Merged into one page, one component.
- **`client-zip` over `jszip` for bulk downloads.** `jszip` buffers every input file plus the
  final archive fully in memory — fine for a handful of files, but a real liability at the
  ~1800-file scale this tool is actually used at (see CSV parser note above for the same class
  of bug). `client-zip` streams compression from `Response` bodies directly, so memory use
  doesn't scale with archive size.
- **SweetAlert2 only for the one destructive action.** Added specifically to confirm "Reset
  session" (irreversible, clears in-progress work) and to give a lightweight success toast after
  CSV parsing — not used as a general notification system elsewhere, to avoid it creeping into
  every button click.

## Known limitations / things to revisit

- **Token expiry still has no automatic re-auth.** The token is now validated before every batch
  and via a manual "Check token" button, and it persists across sessions in `localStorage` — but
  if it expires mid-run there's still no way to refresh it without the user manually
  re-extracting a new one from DevTools. `/api/me`'s clean-error response at least makes the
  failure legible instead of a raw 401.
- **Batch-to-jobs matching is a page-1 heuristic**, not a guaranteed-correct filter — it *will*
  break if something else hits the ExportComments.com account concurrently while a batch is
  mid-flight (e.g. someone manually using the web UI at the same time).
- **Persistence is `localStorage`, not a database.** Token, URL list, "include replies", and
  results all survive a refresh now, but it's still all client-side and per-browser — clearing
  site data or switching machines loses it, and there's no way to resume a run from a different
  device.
- **No environment-based token/secrets handling.** The token still lives in browser storage, not
  a `.env`/server-side credential store — the natural next step if this needs to run unattended
  (e.g. a cron-triggered export with no human pasting a token in).
- **The whole batch-chaining loop is driven by the open tab.** If the browser tab is closed
  mid-run, already-submitted batches keep processing on ExportComments.com's servers, but any
  batches not yet submitted never will be, and results/download links for the ones that did
  finish won't get auto-fetched. Moving orchestration server-side (e.g. a cron job or queue) would
  be the fix if unattended, multi-hour runs become common.
