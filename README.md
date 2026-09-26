# Multi-Courier Integration Platform

A backend service that gives internal consumers **one courier-agnostic API** for shipping, with
courier partners plugged in behind an adapter contract. UrbaneBolt is the first real integration;
a second `MockCourier` adapter ships alongside it to demonstrate that adding a courier genuinely
requires no change to shared code.

```
POST /api/v1/orders                  { "courier_partner": "urbanebolt", ... }
GET  /api/v1/orders/{order_id}/track
POST /api/v1/orders/{order_id}/cancel
POST /api/v1/orders/bulk             up to 100 orders, mixed couriers, 202 + batch_id
```

The caller sends our normalized schema and names a courier. It never sees a courier's payload,
error wording, or status vocabulary.

- Architecture, patterns and trade-offs: **[DESIGN.md](DESIGN.md)**
- Postman collection: **[postman/](postman/multi-courier-platform.postman_collection.json)**

---

## Requirements

- Node.js **20.6+** (uses `node --env-file`)
- Docker (for PostgreSQL), or any PostgreSQL 14+ instance

## Setup

```bash
git clone <repository-url>
cd multi-courier-platform

npm install
cp .env.example .env

docker compose up -d      # PostgreSQL on host port 55432
npm run migrate
npm start
```

The service listens on `http://localhost:3000`. Check it:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/api/v1/couriers -H "x-api-key: local-dev-key"
```

> **Why host port 55432?** Developer machines very often already run PostgreSQL on 5432 (and
> sometimes 5433). The container publishes to 55432 to avoid a silent collision where your
> client connects to the *local* server instead of the container's and fails authentication.
> If 5432 is free for you, change the port mapping in `docker-compose.yml` and `DATABASE_URL`.

### Using your own PostgreSQL

Skip `docker compose` and point `DATABASE_URL` at your instance, then create the database the
tests use:

```sql
CREATE DATABASE courier_platform;
CREATE DATABASE courier_platform_test;
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | |
| `PORT` | `3000` | |
| `LOG_LEVEL` | `info` | pino level (`silent` in tests) |
| `LOG_PRETTY` | `true` in development | human-readable logs |
| `API_KEY` | — **required** | shared secret consumers send as `x-api-key` |
| `DATABASE_URL` | — **required** | PostgreSQL connection string |
| `COURIER_TIMEOUT_MS` | `15000` | per-request timeout, all couriers |
| `COURIER_MAX_RETRIES` | `2` | retries after the first attempt |
| `COURIER_RETRY_BASE_MS` | `500` | exponential backoff base |
| `BULK_MAX_ORDERS` | `100` | maximum batch size |
| `BULK_CONCURRENCY` | `10` | orders processed in parallel per batch |

Per-courier settings follow the convention `<COURIER_NAME>_*`, which is how a new courier is
configured without touching any existing config file:

| Variable | Purpose |
|---|---|
| `URBANEBOLT_ENABLED` | register this adapter at boot |
| `URBANEBOLT_BASE_URL` | `https://uat.urbanebolt.in` |
| `URBANEBOLT_USERNAME` / `URBANEBOLT_PASSWORD` | API credentials |
| `URBANEBOLT_CUSTOMER_CODE` | UrbaneBolt-specific account code |
| `URBANEBOLT_TIMEOUT_MS` / `_MAX_RETRIES` / `_RETRY_BASE_MS` | override the global defaults |
| `MOCK_ENABLED` | register MockCourier |
| `MOCK_FAILURE_RATE` | `0`–`1`; probability a create fails, for demoing partial success |
| `MOCK_LATENCY_MS` | simulated courier latency |

The committed `.env.example` contains the **public UAT credentials from the UrbaneBolt
integration docs**. Replace them for any non-sandbox use. Nothing is hardcoded — every value is
read from the environment at boot, and the service refuses to start if a required one is missing.

## Running the tests

```bash
docker compose up -d
npm test
```

82 tests. `pretest` migrates the separate `courier_platform_test` database automatically, so
`npm test` is the only command you need.

| Suite | What it covers |
|---|---|
| `tests/unit/mapper.test.js` | payload translation, the courier's non-ISO IST timestamps |
| `tests/unit/status-map.test.js` | status mapping and the unknown-code fallback |
| `tests/unit/retry.test.js` | backoff, what is retried and what deliberately is not |
| `tests/unit/registry.test.js` | adapter auto-discovery and boot-time contract validation |
| `tests/unit/concurrency.test.js` | the bounded pool, including failure isolation |
| `tests/integration/urbanebolt-adapter.test.js` | the adapter against `nock`, including the 200-with-`errorResponse` trap and re-authentication |
| `tests/integration/orders.test.js` | the real routes, services and database end to end |
| `tests/integration/bulk.test.js` | 100-order batches, partial success, idempotency |

No test touches the network: the UrbaneBolt adapter runs against `nock`, and everything else
runs against `MockCourier`. Run only the fast ones with `npm run test:unit`.

Integration tests share one database, so `npm test` runs test files serially
(`--test-concurrency=1`).

---

## Using the API

Every request needs `x-api-key`. Every response uses one envelope — success:

```json
{ "success": true, "data": { }, "request_id": "req_...", "timestamp": "..." }
```

…and failure, identically shaped on every endpoint:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [{ "field": "delivery.pincode", "message": "must be a 6-digit pincode" }]
  },
  "request_id": "req_01HW...",
  "timestamp": "2026-09-26T10:00:00.000Z"
}
```

`request_id` is on every response and every log line the request produced — quote it and the
whole request is recoverable from the logs.

### Create an order

```bash
curl -X POST http://localhost:3000/api/v1/orders \
  -H "x-api-key: local-dev-key" \
  -H "Content-Type: application/json" \
  -d '{
    "courier_partner": "urbanebolt",
    "order_id": "ORD-2026-0001",
    "service_type": "SDD",
    "payment_mode": "COD",
    "shipment": {
      "weight_kg": 1.1,
      "dimensions_cm": { "length": 12, "breadth": 10, "height": 10 },
      "pieces": 1,
      "declared_value": 100,
      "collectable_value": 500,
      "item_description": "BOOKS",
      "item_quantity": 1
    },
    "invoice": { "number": "INV-0002", "date": "2026-09-20", "value": 500 },
    "pickup": {
      "name": "Rohit Athaley", "phone": "9425018023", "email": "seller@example.com",
      "address_line": "Plot 137-138, Sector-I, Govindpura", "address_type": "Seller",
      "city": "Bhopal", "state": "Madhya Pradesh", "pincode": "122017", "country": "INDIA"
    },
    "delivery": {
      "name": "Satyam Convent School", "phone": "8320226438", "email": "buyer@example.com",
      "address_line": "Plot 26-27, Om Nagar Society, Sumbhal", "address_type": "Home",
      "city": "Surat", "state": "Gujarat", "pincode": "122001", "country": "INDIA"
    }
  }'
```

```json
{
  "success": true,
  "data": {
    "order_id": "ORD-2026-0001",
    "courier_partner": "urbanebolt",
    "awb_number": "200000007934",
    "status": "CREATED",
    "label_url": "https://api.uat.urbanebolt.in/api/v1/services/print-label/?key=..."
  },
  "request_id": "req_...",
  "timestamp": "..."
}
```

Change `"courier_partner": "urbanebolt"` to `"mock"` and the identical payload routes to a
different carrier. That is the whole point of the design — and `mock` needs no network, so it is
the easiest way to try the API.

`return_to` is optional and defaults to `pickup`.

### Track, cancel, fetch

```bash
curl http://localhost:3000/api/v1/orders/ORD-2026-0001/track  -H "x-api-key: local-dev-key"
curl -X POST http://localhost:3000/api/v1/orders/ORD-2026-0001/cancel -H "x-api-key: local-dev-key"
curl http://localhost:3000/api/v1/orders/ORD-2026-0001        -H "x-api-key: local-dev-key"
```

`track` returns the current status plus the full append-only history:

```json
{
  "success": true,
  "data": {
    "order_id": "ORD-2026-0001",
    "status": "IN_TRANSIT",
    "current_location": "Gurgaon",
    "tracking_history": [
      { "status": "IN_TRANSIT", "courier_status_code": "INT", "description": "In transit",
        "location": "Gurgaon", "occurred_at": "2026-09-26T10:14:00.000Z" },
      { "status": "CREATED", "courier_status_code": "MAN", "description": "Shipment Manifested",
        "location": "Gurgaon", "occurred_at": "2026-09-26T09:44:00.000Z" }
    ]
  }
}
```

Cancelling is safe to repeat: an already-cancelled shipment returns `200`, not an error.

### Bulk create

```bash
curl -X POST http://localhost:3000/api/v1/orders/bulk \
  -H "x-api-key: local-dev-key" -H "Content-Type: application/json" \
  -d '{ "orders": [ { "courier_partner": "mock", "order_id": "BULK-1", ... }, ... ] }'
```

Returns immediately:

```json
{
  "success": true,
  "data": {
    "batch_id": "4ddbd188-f046-4132-b7c6-47710335e246",
    "status": "QUEUED",
    "total_count": 100,
    "accepted_count": 99,
    "rejected_count": 1,
    "status_url": "/api/v1/orders/bulk/4ddbd188-..."
  }
}
```

Then poll for progress and per-order results:

```bash
curl http://localhost:3000/api/v1/orders/bulk/<batch_id> -H "x-api-key: local-dev-key"
```

```json
{
  "data": {
    "status": "COMPLETED",
    "total_count": 100, "success_count": 97, "failure_count": 3, "pending_count": 0,
    "results": [
      { "index": 0, "order_id": "BULK-1", "status": "SUCCESS", "awb_number": "MOCK...", "error": null },
      { "index": 97, "order_id": "BULK-1", "status": "FAILED",
        "error": { "code": "DUPLICATE_ORDER", "message": "Order \"BULK-1\" already exists" } },
      { "index": 98, "order_id": "BULK-BAD-1", "status": "FAILED",
        "error": { "code": "VALIDATION_ERROR", "message": "delivery.pincode: must be a 6-digit pincode" } },
      { "index": 99, "order_id": "BULK-BAD-2", "status": "FAILED",
        "error": { "code": "UNSUPPORTED_COURIER", "message": "Unsupported courier_partner: \"delhivery\"" } }
    ]
  }
}
```

Orders in one batch may use different couriers. Submitting the same `order_id` twice — within a
batch, across batches, or concurrently — creates exactly one shipment.

### Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | bad input; `details` lists each offending field |
| `UNSUPPORTED_COURIER` | 400 | unknown `courier_partner`; `details` lists supported ones |
| `UNAUTHORIZED` | 401 | missing or wrong `x-api-key` |
| `ORDER_NOT_FOUND` / `BATCH_NOT_FOUND` | 404 | |
| `DUPLICATE_ORDER` | 409 | `order_id` already has a shipment |
| `ORDER_NOT_CANCELLABLE` | 409 | shipment is delivered, or has no AWB yet |
| `COURIER_VALIDATION_ERROR` | 422 | the courier rejected the shipment |
| `COURIER_AUTH_ERROR` | 502 | re-authentication failed |
| `COURIER_UNAVAILABLE` | 503 | courier 5xx or network failure, after retries |
| `COURIER_TIMEOUT` | 504 | courier timed out, after retries |
| `INTERNAL_ERROR` | 500 | our bug; details are logged, never returned |

The courier's own error text is **never** returned to a consumer. It is recorded in the log line
and in the order's `response_payload` for debugging.

---

## How to add a new courier

Adding a courier touches **no existing file**. There is no registry list to append to, no
`switch` to extend, no DTO to change.

**1. Create the folder.**

```
src/couriers/delhivery/
├── index.js        # the adapter
├── client.js       # HTTP + auth
├── mapper.js       # our schema <-> theirs
└── status-map.js   # their codes -> our statuses
```

**2. Export the contract from `index.js`** (see `src/couriers/base-courier.js` for the full
typed contract, and `src/couriers/mock/index.js` for the shortest working example):

```js
export default {
  name: 'delhivery',            // this is the courier_partner value; lowercase
  displayName: 'Delhivery',

  init(settings) {              // optional; receives DELHIVERY_* config at boot
    client = createClient(settings);
  },

  async createShipment(order) {
    // → { awbNumber, courierOrderId, labelUrl, status, request, raw }
  },
  async trackShipment(awbNumber) {
    // → { status, currentLocation, history: [...], raw }
  },
  async cancelShipment(awbNumber) {
    // → { cancelled, message, raw }
  },
};
```

Two rules make the adapter interchangeable:

- **Stay stateless and never touch the database.** Translate and call; the service decides what
  to persist. That is why each method returns `raw` — the untouched courier response, which the
  service stores for audit.
- **Throw `CourierError` with a normalized `ErrorCode`**, putting the courier's own wording in
  `courierMessage` so it is logged but never returned to a consumer.

**3. Add its environment variables:**

```ini
DELHIVERY_ENABLED=true
DELHIVERY_BASE_URL=https://api.delhivery.com
DELHIVERY_API_KEY=...
```

**4. Restart.** The registry scans `src/couriers/` at boot, validates each adapter against the
contract, and registers the enabled ones. Confirm with:

```bash
curl http://localhost:3000/api/v1/couriers -H "x-api-key: local-dev-key"
```

Consumers can now send `"courier_partner": "delhivery"`. A partly-built adapter fails at
**startup** with a message naming the missing method, rather than at 2am on a customer request.

---

## Assumptions

1. **Credentials.** `.env.example` uses the public UAT credentials from the UrbaneBolt
   integration docs. Production credentials come from the environment.
2. **`customerCode` is courier-specific.** It is UrbaneBolt configuration, not part of our
   normalized order schema — a deliberate example of keeping a courier's concepts out of the
   unified contract.
3. **Tracking is pull-based.** The UrbaneBolt docs expose no webhook, so status is refreshed when
   `/track` is called. A courier that supports webhooks would add a route inside its own adapter
   folder without disturbing anything else. A scheduled poller for in-flight shipments is the
   natural next step.
4. **`service_type` and `payment_mode` pass through** as courier-recognised strings (`SDD`,
   `NDD`, `COD`, `PPD`). A normalized enum with per-courier translation is the obvious next step
   once a second real courier disagrees about the vocabulary.
5. **Units are explicit in field names** — `weight_kg`, `dimensions_cm`. Currency is INR, which
   the courier API assumes.
6. **Courier timestamps are IST.** UrbaneBolt returns `"03 May 2025, 15:47"` with no timezone;
   it is parsed as IST and stored as UTC.
7. **Only `MAN` and `CAN` status codes were observable** in the UAT sandbox. The rest of the
   status map is provisional, and unknown codes fall back to `IN_TRANSIT` with a warning rather
   than failing.
8. **Bulk processing assumes a single instance.** In-flight batches do not survive a restart —
   see the trade-off in [DESIGN.md](DESIGN.md).
9. **A `FAILED` order may be resubmitted.** A creation that never reached the courier produced no
   shipment, so reusing that `order_id` is treated as a retry rather than a duplicate.

## Project layout

```
src/
├── app.js, server.js        express wiring and boot
├── config/                  env loading; per-courier config by convention
├── routes/ controllers/     thin HTTP layer, courier-agnostic
├── services/                business logic (order, bulk)
├── couriers/                the adapter contract, registry, and one folder per courier
├── db/                      knex, migrations, repositories
├── middleware/              request id, api key, validation, error handler
├── schemas/                 Zod contracts for the normalized API
├── errors/                  AppError hierarchy and the error code catalogue
└── utils/                   logger, retry, concurrency, status enum, presenters
```
