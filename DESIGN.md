# Design

## The problem

One courier today, several tomorrow. The requirement that shapes everything: adding a courier
must not change controllers, DTOs, business logic, or existing adapters.

That rules out the obvious approach — a service that branches on `courier_partner` — because
every new courier edits the same file, and the blast radius of a mistake is every other courier.

## Architecture

```
Consumer (OMS / frontend)
        │  normalized JSON + "courier_partner": "urbanebolt"
        ▼
 Routes ──► Zod validation ──► Controller ──► OrderService ───────────┐
                                                   │                  │
                                                   │                  ▼
                                                   │           CourierRegistry
                                                   │        (resolve name → adapter)
                                                   ▼                  │
                                            Repositories              ▼
                                           (Knex/Postgres)      CourierAdapter
                                                   │           (urbanebolt | mock)
                                                   ▼                  │
                                              PostgreSQL              ▼
                                                                Courier HTTP API
```

The load-bearing line: **`OrderService` only ever talks to the `CourierAdapter` contract.** There
is no `if (courier === 'urbanebolt')` anywhere in the codebase. Courier identity is data that
selects an adapter, never a branch in business logic.

## Patterns, and why these

### Adapter — one folder per courier

`src/couriers/<name>/` translates our normalized order into the courier's wire format and its
responses back. Everything courier-specific is quarantined there: UrbaneBolt's flat
`shprPincode` fields, its comma-separated `awbs` string, its IST timestamps, its habit of naming
the same concept `errorResponse` on one endpoint and `failureResponse` on another.

Chosen over a shared base class with overridable hooks. Inheritance would force couriers into a
common call shape they do not share — one is natively batched, another is not; one uses bearer
tokens, another HMAC. Composition behind a three-method contract imposes nothing.

Two rules keep adapters replaceable:

1. **Stateless, no database access.** Adapters translate and call; the service decides what to
   persist. This is why every method returns `raw` — the untouched courier response — so the
   service can store it for audit without the adapter knowing a database exists. It also makes
   adapters trivial to unit test.
2. **Throw `CourierError` with a normalized code.** The courier's own wording travels in
   `courierMessage`, which is logged but never returned.

### Registry with filesystem auto-discovery

`src/couriers/registry.js` scans its own directory at boot, validates each `index.js` against the
contract, and registers the ones enabled by config.

This is what makes requirement 3.2 literally true. A central `const ADAPTERS = { urbanebolt, ... }`
would still be a shared file edited by every onboarding. With discovery there is no list at all —
adding a courier is adding a folder and setting env vars. Per-courier configuration follows the
same principle: `courierConfig(name)` reads `<NAME>_BASE_URL` by convention, so even the config
file stays untouched.

Validation happens at **boot**, not on first use. An adapter missing `cancelShipment()` stops the
process with a message naming the gap, rather than failing on a customer's request weeks later.

### Strategy — per-request adapter selection

The adapter is resolved per order, not per process. One code path serves every courier, and a
bulk batch mixing UrbaneBolt and MockCourier needs no special handling — it falls out of the
design rather than being a feature.

### Repository — SQL out of the services

Thin functions over Knex. Chosen over an ORM: the data model is four tables and the interesting
logic is one `INSERT` whose failure mode matters (see idempotency below). An ORM would hide
exactly the behaviour worth being explicit about.

## The courier API forces three decisions

These come from calling the UAT sandbox rather than from the documentation, which has no saved
response examples.

**1. HTTP 200 does not mean success.** UrbaneBolt returns `200 OK` with outcomes split across
`successResponse[]` and `errorResponse[]`. Duplicates and field errors alike arrive as `200`:

```json
{ "status": "Success", "successResponse": [],
  "errorResponse": [{ "orderNumber": "...", "message": "orderNumber already shipped!" }] }
```

An adapter that trusted status codes would record failed shipments as successful — silent data
corruption, not a visible outage. The adapter reads the verdict from the body. This is the single
most important line in the integration and has a dedicated test.

**2. Field errors are unmappable.** The courier reports validation failures as one flat string:
`"'shprName' is a required property, 'shprAddress' is a required property, ..."`. There is no way
to map that back to our nested fields, so our own Zod schema is strict enough that we
essentially never provoke it. Validation is a first-class responsibility here, not a formality.

**3. The status vocabulary is unknown.** Only `MAN` and `CAN` were reachable in the sandbox. The
status map is an explicit dictionary with a logged fallback to `IN_TRANSIT`, so an unrecognised
code never strands an order or breaks a tracking call. Designing for an incomplete mapping is the
honest response to an incomplete spec.

## Database schema

Four tables. PostgreSQL, `jsonb` for raw payloads.

```
batches ──< batch_items
   │
   └──< orders ──< tracking_history
```

### `orders`

`id` (uuid PK) · **`order_id` (text UNIQUE)** · `courier_partner` · `courier_order_id` ·
`awb_number` · `status` · `label_url` · `request_payload` (jsonb) · `response_payload` (jsonb) ·
`failure_reason` · `retry_count` · `batch_id` · `created_at` · `updated_at`

`request_payload` and `response_payload` hold the exact courier exchange — on failure too, which
is what makes a failed order debuggable rather than merely marked.

### `tracking_history` — append-only

`order_id` FK · `status` · `courier_status_code` · `courier_status_description` · `location` ·
`occurred_at` · `raw_payload` (jsonb)

Append-only is enforced by construction: the repository exposes only `insert` and `listByOrder`,
so no code path can rewrite history. Because tracking is polled and couriers replay their whole
scan list every time, `UNIQUE (order_id, courier_status_code, occurred_at)` lets the repository
insert-and-ignore — deduplicating without giving up append-only semantics or an extra read.

### `batches` and `batch_items`

`batch_items` is keyed by `(batch_id, item_index)` rather than `order_id`, for two reasons: the
same `order_id` can legitimately appear twice in one submission and each occurrence needs its own
reported outcome, and an item that fails *our* validation never becomes an order row but must
still appear in the result with a reason. Without this table those failures would be invisible.

Final counts are derived from the item rows in one `GROUP BY` rather than incremented as results
arrive — with ten workers writing concurrently, read-modify-write counters would drift.

## Idempotency

> "Submitting the same order_id twice must not create two shipments."

The obvious implementation is to check whether the order exists and insert if not. **That is
broken** under exactly the concurrency the bulk endpoint creates: two requests both read "not
found", both insert, two shipments.

Instead, `order_id` carries a `UNIQUE` constraint and the order row is written **before** the
courier is called:

```js
try {
  const [order] = await db('orders').insert(row).returning('*');
  return { claimed: true, order };            // we own this order_id
} catch (err) {
  if (err.code !== '23505') throw err;        // not a unique violation
  // someone else owns it — or a previous attempt failed and this is a retry
}
```

The database arbitrates. The guarantee then holds for free across every case: duplicates within
one batch, a resubmitted batch, and genuinely simultaneous requests. An integration test fires
five concurrent identical creates and asserts exactly one `201` and one row.

This is why the `PENDING` status exists — it means "claimed, not yet acknowledged by the
courier". A creation that ends in `FAILED` produced no shipment, so resubmitting that `order_id`
is a *retry*, not a duplicate; the retry path is an `UPDATE ... WHERE status = 'FAILED'`, whose
row match is itself atomic between competing retries.

## Bulk processing

**Chosen:** respond `202 Accepted` with a `batch_id` immediately; process in the background
through a bounded concurrency pool (`BULK_CONCURRENCY`, default 10).

1. Validate the envelope, then each item individually — one malformed order cannot reject 99 good
   ones.
2. Write `batches` and one `batch_items` row per item; items failing our validation are recorded
   as `FAILED` up front.
3. Respond `202`.
4. Process valid items through the pool, each calling **the same `OrderService.createOrder`** the
   single-order endpoint uses, so the two paths cannot drift and mixed couriers work for free.
5. Derive final counts and mark the batch `COMPLETED`.

Partial success is the default path, not an error path: the pool resolves failures rather than
rejecting (`allSettled` semantics), so one bad order never aborts a batch.

### Why not BullMQ + Redis

| | In-process pool (chosen) | BullMQ + Redis |
|---|---|---|
| Infrastructure | none | Redis + a worker process |
| Durability | lost on restart mid-batch | survives restarts |
| Scaling | single instance | horizontal |
| Retries | in-request only | built-in, with dead-letter |

The in-process pool meets every stated requirement — concurrent, non-blocking, partial success,
idempotent, responsive — with no extra infrastructure, keeping attention on the courier
abstraction the assignment is actually about.

**The honest limitation:** a crash mid-batch leaves items `PENDING` and they are not resumed.
That is a deliberate trade, mitigated by the fact that every failure is already persisted with a
reason for reconciliation, and bounded by the 100-order cap.

**The upgrade path is narrow by design.** `bulk.service.js` would enqueue instead of calling the
pool, and the same per-item function becomes the job processor. Nothing else changes — the
service, adapters, and schema are untouched. Under real load, that is the change I would make
first, along with a reconciliation job for stuck `PENDING` orders.

## Error handling

A single `AppError` hierarchy with a normalized code catalogue, rendered in exactly one place
(`middleware/error-handler.js`). Controllers never build an error response, so the shape cannot
drift between endpoints.

The separation that matters:

```js
new CourierError(ErrorCode.COURIER_VALIDATION_ERROR, 'Courier rejected the shipment', {
  courierMessage: "'shprName' is a required property",  // logged, never returned
  courierResponse: body,                                 // persisted for audit
});
```

`message` is ours and safe to return; `courierMessage` is the courier's and never leaves the log
line. That is how "do not leak the courier's raw error" becomes structural rather than a habit
someone has to remember.

**Resilience**, all configurable, nothing hardcoded:

- **Timeout** on every request (`COURIER_TIMEOUT_MS`).
- **Retry with exponential backoff and full jitter** on timeouts, 5xx and 429. Deliberately *not*
  on 4xx — repeating a rejected payload cannot succeed and only burns rate limit. Jitter matters
  because a batch of ten workers would otherwise retry in lockstep and recreate the spike.
- **Re-authenticate once on 401**, then retry. This sits *outside* the retry loop on purpose: a
  genuinely bad credential produces two auth calls, not an auth-request storm. Tested explicitly.
- **Failures are persisted**, not just returned — `FAILED` plus reason plus the raw exchange, so
  the order is reconcilable rather than lost.
- **Every failure logs** `order_id`, `courier_partner`, `request_id`, `error_type` and the
  courier's message, with a stack trace for unexpected errors. Credentials and tokens are redacted
  centrally by pino.

`request_id` is generated (or taken from an inbound `x-request-id`), returned on every response,
and stamped on every log line — so a consumer's bug report maps directly to log lines.

## Testing

82 tests, none touching the network. The UrbaneBolt adapter runs against `nock` using response
bodies captured from the real sandbox; everything else runs against `MockCourier`.

`MockCourier` earns its place twice over: it is the bonus deliverable proving pluggability, and
it is what makes the integration suite fast and deterministic. The integration tests exercise the
real routes, services and database — only the courier is substituted.

The tests worth reading are the ones asserting the non-obvious: a `200` carrying `errorResponse`
is a failure; a `4xx` is not retried; a bad credential does not loop; five concurrent identical
creates yield exactly one shipment.

## Trade-offs I would revisit

| Decision | Why | What I would change under load |
|---|---|---|
| In-process bulk pool | no infrastructure, fully explainable | BullMQ + Redis; reconciliation job for stuck `PENDING` |
| Pull-based tracking | the docs expose no webhook | scheduled poller for in-flight shipments, webhooks per adapter where supported |
| Static API key | internal service-to-service | per-consumer credentials, rotation, rate limiting |
| Raw payloads in `orders` | simple and queryable | move to object storage or a partitioned audit table once rows grow |
| `service_type` passes through | only one real courier so far | normalized enum with per-courier translation |
| Single token cache per process | adequate at this scale | shared cache if instances multiply, to avoid redundant auth calls |
