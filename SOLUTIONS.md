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

> This entry was revised during the work. The original plan chose the `409`; see
> [Where the work departed from this plan](#where-the-work-departed-from-this-plan).

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

## Outcome

All fourteen defects are fixed, each as a pair of commits: the failing specs first, then
the change that makes them pass.

| Findings | Commit | What it does |
|---|---|---|
| 1 | `d2d3265` | Cache entries reach Redis; `REDIS_DB` honoured |
| 10–14 | `d03f7c1` | DTOs on the two unvalidated endpoints, plus a global exception filter |
| 5, 6 | `3554b9b` | One transaction per order; stock taken with a conditional atomic update |
| 7, 8 | `50a2402` | 3 attempts with backoff; payment idempotent via a stored `transaction_id` |
| 2, 16, 17 | `b9735c2` | Cache keyed by query, filtering in SQL, invalidation on catalogue writes |
| 3, 4 | `5f6cbc0` | Tree built from one query with unbounded depth; circular reference removed |
| 9 | `a99db1d` | Per-item outcomes reported instead of blanket success |

Supporting commits: `e5d0f3d` made the e2e harness deterministic (serial execution, real
teardown, a listening server for the concurrency specs) and `084f171` brought `pnpm lint`
from 180 problems to none.

**Verification:** 40 e2e specs across 9 suites, run against the real Postgres and Redis.

```bash
docker compose up -d
pnpm test:e2e
```

### Numbers worth quoting

| | Before | After |
|---|---|---|
| Cache entries in Redis | 0 | present, on the configured DB |
| Concurrent orders, stock 5, 5 units each | 5 orders created, 25 units sold | 1 order, 4 rejected |
| Payment against a failing provider | 202 seconds, then a 500 | 327 ms, then a 503 |
| Repeated payment on a confirmed order | charged again, new transaction id | original transaction returned |
| Rejected order | order row + item + stock consumed | nothing persisted |
| `/categories/:id/tree` on a 3-level chain | 500 on every node | full tree, both directions |
| `/orders/:id/full` | 500, always | 200 |
| `pnpm lint` | 180 problems | 0 |

## Where the work departed from this plan

Four things changed once the code was in front of us. Recording them because the
deviations are more informative than the parts that went as expected.

**Payment idempotency became real, not a 409.** The plan proposed rejecting a repeated
payment with a `409`, on the grounds that storing a transaction id meant a schema change.
That was the wrong trade: a `409` still leaves a caller who timed out unable to find out
whether they were charged. A nullable `transaction_id` column is one line, and it makes a
retry return the original transaction. The smaller diff was not the better answer.

**The stock race hid behind a wrong assumption about TypeORM.** The first implementation
of the conditional update read `.length` on the result of `manager.query`. TypeORM's
Postgres driver returns `[rows, rowCount]` for `UPDATE`, so that length was always `2`
and every order was accepted — while the SQL underneath was correct all along. The
concurrency spec caught it. It was later rewritten to use `createQueryBuilder`, whose
`UpdateResult.affected` is typed, removing the assumption entirely.

**Search is deliberately not invalidated by order-driven stock changes.** Product create
and delete bump a cache version; orders do not. Invalidating on every order would make a
60-second cache worthless in a busy catalogue, and it is not needed for correctness: the
order path takes stock with a conditional update, so a stale listing can never produce an
oversell. The listing is eventually consistent; the checkout is authoritative.

**Finding 15 was reclassified rather than fixed.** The `relations` arrays are redundant
with the `eager` flags, but removing `eager` would change the shape of every order
response. That is a contract change, not a repair, so it stays documented as an
observation.

## Out of scope

| # | Risk | Why it is not being fixed |
|---|---|---|
| 19 | `compose.yaml` isolates postgres and redis on separate networks | Causes no reported symptom — the app runs on the host and both ports are published. Would matter only if the app were containerised. |
| 20 | `synchronize: true` can silently drop columns and their data | A genuine production hazard, but replacing it with a migration system means restructuring boot wiring — the largest change in the exercise, fixing none of the five reported symptoms. Recorded as a recommendation. |

Both are documented in `PROBLEMS.md` so the reader can see they were found, not missed.
