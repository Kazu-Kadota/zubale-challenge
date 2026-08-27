# Planned Solutions

Fixes for every defect in [PROBLEMS.md](./PROBLEMS.md).

## Constraints

`INSTRUCTIONS.md` states: *"Focus on identifying and fixing the root causes"* and
*"Do not add new features or redesign the system."* That shapes every decision below:

1. **Fix causes, not symptoms.** No `try/catch` wrapped around a broken call to make a
   500 go away.
2. **Preserve intended behaviour.** Retry logic stays because the README lists it as a
   feature — it gets *bounded*, not removed. Caching stays — it gets *keyed correctly*.
3. **Tests state what the business expects**, not what the code currently does. Each test
   is written first, observed failing against the current code, and only then is the fix
   applied. This is specification testing rather than TDD, since the intent already
   exists in the README.
4. **No structural rewrites.** Two known risks are deliberately left alone (see
   [Out of scope](#out-of-scope)).

## Fix table

| # | Expected behaviour | Change |
|---|---|---|
| 1 | Cache entries land in Redis, on the database named by `REDIS_DB` | Replace `cache-manager-ioredis-yet` with `@keyv/redis`; pass `stores:` (plural); read `REDIS_DB` |
| 2 | Each distinct query caches separately; product writes invalidate | Include the normalised query in the cache key; filter in SQL; clear on create/update/delete |
| 3 | Full tree returned, ancestors and descendants, no crash | Guard on the relation (`category.parent`), not the column; load the tree recursively |
| 4 | Order with user, items, products and category — no cycle | Drop the self-referential `latestOrder` assignment |
| 5 | A failed order persists **nothing** — no order, no items, stock untouched | Wrap `create()` in a single transaction |
| 6 | Concurrent orders cannot oversell; stock never goes negative | Conditional atomic decrement inside the transaction |
| 7 | Bounded retries with backoff; fails fast with a meaningful status | 3 attempts, exponential backoff, `503` on exhaustion; move the DB write out of the retry block |
| 8 | Only `pending` orders are payable; repeating a payment never charges twice | Guard on `order.status`; persist `transactionId` and return it on repeat |
| 9 | The caller can tell which items failed and why | Return `failed: [{id, reason}]`; `success = failed.length === 0`; log with context |
| 10 | Malformed batch body → `400` naming the missing field | Introduce `ProcessBatchDto` with `class-validator` decorators |
| 11 | Invalid status → `400` listing the allowed values | Introduce `UpdateOrderStatusDto` with `@IsEnum(OrderStatus)` |
| 12 | Unexpected errors reach the client as a mapped status, never a bare 500 | Global exception filter; `Logger` instead of `console.log` |
| 13 | `?userId=abc` → `400` | Validate the query param, consistent with `ParseIntPipe` on path params |
| 14 | Deleting a referenced product → `409` explaining why | Detect the FK violation and translate it |

## Decisions worth defending

Four points where more than one answer is defensible. Each is resolved in favour of the
smallest change that satisfies the documented intent.

**Category tree keeps both directions.** The existing code walks ancestors *and*
descendants. Returning descendants only would be simpler, but it changes the endpoint's
contract. Loading both properly preserves intent; the bug was the loading, not the shape.

**Retry budget: 3 attempts, exponential backoff, `503` on exhaustion.** The README lists
retry logic as a feature, so it stays. `503 Service Unavailable` rather than `500` because
the failure is a dependency being unreachable, not a fault in this service.

**Payment idempotency via a stored `transactionId`.** A `409` on re-payment would be the
smaller change, but it is not idempotent — the caller still cannot safely retry after a
timeout. Persisting the transaction and returning it on repeat is the behaviour a payment
flow actually needs. This adds one nullable column to `Order`.

**Batch response extended additively.** `{ success, processed }` cannot express a partial
failure, which is the whole defect. Adding `failed: [{id, reason}]` and defining
`success = failed.length === 0` keeps both existing fields meaningful, so current callers
do not break.

## Order of work

Ordered by dependency, then by severity.

| Step | Fixes | Rationale |
|---|---|---|
| 1 | 1 | Nothing about cache behaviour is observable until entries actually reach Redis |
| 2 | 12, 10, 11, 13, 14 | The error-handling layer, so later fixes surface failures honestly |
| 3 | 5, 6 | Order atomicity and the stock race — one transaction fixes both |
| 4 | 7, 8 | Payment: retry budget and idempotency |
| 5 | 2, 17 | Search cache key and invalidation, now verifiable against Redis |
| 6 | 3, 4 | Category tree and the circular reference |
| 7 | 9, 15, 16, 18 | Batch reporting and the remaining efficiency items |

Each step is one commit for the failing tests, one commit for the fix.

## Out of scope

| # | Risk | Why it is not being fixed |
|---|---|---|
| 19 | `compose.yaml` isolates postgres and redis on separate networks | Causes no reported symptom — the app runs on the host and both ports are published. Would matter only if the app were containerised. |
| 20 | `synchronize: true` can silently drop columns and their data | A genuine production hazard, but replacing it with a migration system means restructuring boot wiring — the largest change in the exercise, fixing none of the five reported symptoms. Recorded as a recommendation. |

Both are documented in `PROBLEMS.md` so the reader can see they were found, not missed.
