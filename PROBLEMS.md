# Problems Found

Investigation of the reported symptoms in `INSTRUCTIONS.md`. Every finding below was
**reproduced against the running service** — the evidence shown is real output, not
inference from reading code.

## Method

1. Read all 21 source files and the relevant `node_modules` internals.
2. Formed one hypothesis per reported symptom.
3. Wrote a probe per hypothesis and ran it against `docker compose up` + `pnpm start:dev`.
4. Kept only what the probe confirmed. Two predictions were wrong and are recorded as
   such in [Corrections](#corrections) — the mechanism mattered more than the guess.

## Symptom → cause map

`INSTRUCTIONS.md` reports five symptoms. They are not five bugs; they are five
*surfaces* of fourteen defects.

| Reported symptom | Findings |
|---|---|
| Some requests are extremely slow or never complete | 7, 3, 15, 16 |
| Intermittent errors occur in certain flows | 6, 3 |
| Data is sometimes inconsistent or missing | 5, 6, 8, 1, 9 |
| Cache behavior does not match expectations | 1, 2, 17 |
| Some failures produce vague or misleading error messages | 4, 9, 10, 11, 12, 13, 14 |

Note that findings 3 and 6 are the only genuinely *intermittent* ones — same input,
different outcome. Everything under "vague error messages" is perfectly deterministic;
it is the *message* that is wrong, not the behaviour.

---

## 1. The cache never reaches Redis

**`src/app.module.ts:30-40`** · symptom: cache · data inconsistency

```ts
CacheModule.registerAsync({
  isGlobal: true,
  useFactory: async () => ({
    store: await redisStore({ ... db: 0, ttl: 60000 }),   // "store", singular
  }),
}),
```

`@nestjs/cache-manager@3` reads **`stores`** (plural). From
`node_modules/@nestjs/cache-manager/dist/cache.providers.js`:

```js
const stores = Array.isArray(options.stores) ? ... : options.stores ? [...] : undefined;
const cacheManager = stores
  ? createCache({ ...options, stores })
  : createCache({ ttl, refreshThreshold, nonBlocking });   // ← no stores
```

and `cache-manager@7` (`dist/index.cjs:101`):

```js
const stores = options?.stores?.length ? options.stores : [keyv];   // in-memory default
```

`options.stores` is `undefined`, so the app silently falls back to a **per-process
in-memory map**. Redis is connected but never written to.

**Evidence**

```console
$ docker exec challenge-redis redis-cli -n 0 KEYS '*'      # (empty)
$ docker exec challenge-redis redis-cli -n 1 KEYS '*'      # (empty)
$ docker exec challenge-redis redis-cli INFO clients | grep connected_clients
connected_clients:2                                         # 1 redis-cli + 1 idle app client
```

Three compounding faults:

- The `redisStore()` client is constructed, connects, is never used, and is never
  disposed — one leaked connection per boot.
- `db: 0` is hardcoded, so the documented `REDIS_DB` variable is ignored.
- `cache-manager-ioredis-yet@2` implements the **cache-manager v5** `Store` interface,
  which v7 cannot accept at all. pnpm says so out loud:

  ```
  WARN deprecated cache-manager-ioredis-yet@2.1.2: With cache-manager v6 we now are using Keyv
  ```

  So correcting `store` → `stores` alone would **not** fix this.

**Why it is not merely wasteful.** With two instances behind a load balancer, instance A
serves `POST /users` and clears `users:all` *from its own memory only*. Instance B still
holds a copy cached before that user existed, and answers the next `GET /users` from
**its own cache — fast and stale**, for up to the full 60s TTL. The user sees their new
account or not depending on which instance the balancer picks. This wiring bug *directly
produces* the reported "data is sometimes inconsistent".

## 2. Product search caches every query under one key

**`src/products/products.service.ts:52-67`** · symptom: cache

```ts
const cacheKey = 'product-search';    // constant — `query` is never part of the key
```

Whoever searches first pins the result for every other query for 60 seconds.

**Evidence**

| Request | Response |
|---|---|
| `/products/search?q=laptop` | `[{id:2, name:"Phone"}]` ✗ |
| `/products/search?q=laptop` | `[{id:1, name:"Laptop"}]` ✓ |
| `/products/search?q=phone` | `[{id:1, name:"Laptop"}]` ✗ |

Also: the query does a full table scan and filters in JavaScript (finding 16), and
nothing invalidates the key on product writes (finding 17).

## 3. Category tree guards on a column and dereferences a relation

**`src/products/products.service.ts:101-102`** · symptom: never completes · intermittent

```ts
if (category.parentId) {                                  // a NUMBER — always present
  tree.parent = this.buildCategoryTree(category.parent);  // an OBJECT — loaded only on request
}
```

`parentId` is a plain column, so it is populated on **every** row returned. `parent` is a
relation, populated **only** when asked for. `findCategory` requests relations exactly
one level deep, so every node at depth ≥ 1 has the number but not the object.

Reading the number and concluding the object is loaded is an invalid inference — that is
the entire bug.

**Evidence**

```console
$ curl -si $BASE/categories/1/tree | head -1
HTTP/1.1 500 Internal Server Error
```
```
ERROR [ExceptionsHandler] TypeError: Cannot read properties of undefined (reading 'id')
    at ProductsService.buildCategoryTree (products.service.ts:96:20)
    at ProductsService.buildCategoryTree (products.service.ts:102:26)
    at <anonymous> (products.service.ts:106:59)
```

**This is one of the two genuinely intermittent findings.** Before a third category
existed, `/categories/2/tree` returned `200`. After adding `Accessories (parentId: 2)`,
all three endpoints return `500` — with **no code change**, only new data:

```console
--- /categories/1/tree   500
--- /categories/2/tree   500      # was 200 before Accessories existed
--- /categories/3/tree   500
```

The `200` it used to return was wrong anyway — it reported `Electronics` as having no
children, because grandchildren were never loaded either.

## 4. `GET /orders/:id/full` builds a circular object, then stringifies it

**`src/orders/orders.service.ts:152-156`** · symptom: vague errors

```ts
const enriched: any = { ...order };
enriched.user = { ...order.user };
enriched.user.latestOrder = enriched;          // order → user → order
return JSON.parse(JSON.stringify(enriched));   // throws, always
```

Not intermittent — those lines run unconditionally, so this endpoint has never worked.
`JSON.stringify` detects the cycle and throws immediately (hence a fast 500, not a hang).

**Evidence**

```
ERROR [ExceptionsHandler] TypeError: Converting circular structure to JSON
    --> starting at object with constructor 'Object'
    |     property 'user' -> object with constructor 'Object'
    --- property 'latestOrder' closes the circle
    at OrdersService.getOrderWithFullDetails (orders.service.ts:156:28)
```

## 5. Order creation is not atomic

**`src/orders/orders.service.ts:63-96`** · symptom: data missing

The order row is committed at line 70, *before* the item loop that can throw at line 77.
A mid-loop failure leaves the order, any already-saved items, and any already-applied
stock decrements permanently in place — while the client is told the request failed.

**Evidence**

```console
$ curl -s -X POST $BASE/orders -d '{"userId":1,"items":[{"productId":1,"quantity":2},
                                                        {"productId":2,"quantity":999}]}'
{"message":"Not enough stock for Phone","error":"Bad Request","statusCode":400}

$ curl -s $BASE/orders | jq -c '[.[]|{id,status,total,items:(.items|length)}]'
[..., {"id":3,"status":"pending","total":"0.00","items":1}]     # ← order that "failed"

$ curl -s $BASE/products/1 | jq -c '{name,stock}'
{"name":"Laptop","stock":5}                                     # ← was 7; 2 units gone
```

The caller received a `400` and has no way to learn that order 3 exists, so the two
consumed Laptops are never recovered.

## 6. Stock check-then-act, with an absolute write that hides the damage

**`src/orders/orders.service.ts:74-89`** · symptom: intermittent · data inconsistency

```ts
const product = await this.productsService.findOne(itemDto.productId);   // READ
if (product.stock < itemDto.quantity) throw ...                          // DECIDE
this.productsService.updateStock(product.id, product.stock - itemDto.quantity);  // WRITE
```

Three separate defects in three lines:

- **No transaction and no lock.** Concurrent requests all read the same stock and all
  pass the check.
- **The write is absolute, not relative.** `updateStock` assigns `product.stock = quantity`
  from a value read earlier, so concurrent writes overwrite rather than accumulate.
- **The call is not awaited** — a floating promise. An unhandled rejection here
  terminates the Node process under Node 20 defaults.

**Evidence** — stock at 5, five concurrent orders of 5 each:

```console
$ for i in 1 2 3 4 5; do curl -s -X POST $BASE/orders \
    -d '{"userId":1,"items":[{"productId":1,"quantity":5}]}' & done; wait

# 5 orders created (ids 4-8), each total "5000.00"  →  25 units sold
$ curl -s $BASE/products/1 | jq -c '{name,stock}'
{"name":"Laptop","stock":0}                          # only 5 units removed
```

Twenty units sold that did not exist.

The absolute write is what makes this dangerous in production. An atomic
`SET stock = stock - 5` would have left `-20` — oversold, but **visibly** so. Writing
the absolute `0` produces a number that looks entirely normal on any dashboard.

## 7. Payment retries 1000 times around a call with side effects

**`src/orders/orders.service.ts:26, 104-124`** · symptom: never completes

```ts
private maxRetries = 1000;
...
const result = await paymentService.processPayment(orderId, ...);  // charges the customer
if (result.success) {
  order.status = OrderStatus.CONFIRMED;
  await this.ordersRepository.save(order);      // ← inside the same try
  return result;
}
} catch (error) { lastError = error; await sleep(100); }   // fixed backoff, no jitter, no cap
```

**Evidence** — with the payment stub forced to fail deterministically:

```console
$ time curl -si -X POST $BASE/orders/2/pay
HTTP/1.1 500 Internal Server Error
{"statusCode":500,"message":"Internal server error"}
curl ...  3:22.32 total
```

**202 seconds.** Matches `1000 × (100ms stub + 100ms backoff) = 200s` to within 1%. The
client waited three and a half minutes for a generic 500 with no hint that anything was
retried.

Two further problems in the same loop:

- **The DB write is inside the retry block.** If `save()` fails *after* the charge
  succeeded, control reaches `catch` and calls `processPayment` again — **charging the
  customer a second time**. There is no idempotency key.
- **`throw lastError!`** with `let lastError: Error` — if the loop ever exits without a
  catch firing, this throws `undefined`.

Against a real gateway, failures are correlated rather than independent: during an
outage every request spends 3½ minutes hammering a dead dependency while holding a
connection open.

## 8. `POST /orders/:id/pay` has no status guard and no idempotency

**`src/orders/orders.service.ts:104`** · symptom: data inconsistency

`processPayment` never inspects `order.status`. An already-confirmed order can be paid
again — minting a fresh `transactionId` each time — and a **cancelled** order can be paid.

**Evidence**

```console
$ curl -si -X POST $BASE/orders/1/pay      # order 1 was already confirmed
HTTP/1.1 201 Created
{"success":true,"transactionId":"TXN-1787787090825"}
```

## 9. Batch reports success while silently dropping items

**`src/products/products.service.ts:112-131`** · symptom: vague errors · data missing

```ts
} catch (error) {
  console.log('Error processing product');   // no id, no message, no stack
}
...
return { success: true, processed };          // `success: true` even when processed === 0
```

**Evidence**

```console
$ curl -si -X POST $BASE/products/batch -d '{"productIds":[1,2,99999]}'
HTTP/1.1 201 Created
{"success":true,"processed":2}
# log:  Error processing product
```

Three requested, two processed, `success: true`, and the log identifies neither the
product nor the reason. A nightly sync would lose a record per run with no signal.

## 10. The batch body has no DTO, so it is never validated

**`src/products/products.controller.ts:30`** · symptom: vague errors

```ts
processBatch(@Body() body: { productIds: number[] })   // a TS type — erased at runtime
```

There is no class, so `ValidationPipe` has nothing to validate against. A malformed body
reaches the service, `for...of undefined` throws, and the outer catch reports a *batch
processing* failure for what is actually a *request validation* failure.

**Evidence**

```console
$ curl -si -X POST $BASE/products/batch -d '{}'
HTTP/1.1 400 Bad Request
{"message":"Batch processing failed","error":"Bad Request","statusCode":400}
```

## 11. `@Body('status')` bypasses validation entirely

**`src/orders/orders.controller.ts:41`** · symptom: vague errors

`ValidationPipe` only runs against a class metatype carrying `class-validator` metadata.
`@Body('status')` extracts a bare scalar, so validation is skipped by design and the raw
string travels into the UPDATE.

**Evidence**

```console
$ curl -si -X PATCH $BASE/orders/1/status -d '{"status":"banana"}'
HTTP/1.1 500 Internal Server Error
{"statusCode":500,"message":"Internal server error"}
```
```
ERROR QueryFailedError: invalid input value for enum orders_status_enum: "banana"
  query: 'UPDATE "orders" SET "status" = $1 WHERE "id" IN ($2)'
  parameters: [ 'banana', 1 ]
```

Also unguarded: status *transitions*. Nothing prevents `delivered` → `pending` or
`cancelled` → `shipped`.

**The codebase already contains the correct pattern.** `CreateOrderDto` produces exactly
the error quality we want:

```console
$ curl -si -X POST $BASE/orders -d '{"userId":1,"items":[{"productId":"abc","quantity":-5}]}'
{"message":["items.0.productId must be a number conforming to the specified constraints",
            "items.0.quantity must not be less than 1"],"error":"Bad Request","statusCode":400}
```

Findings 10 and 11 are not "Nest cannot report errors well" — they are two endpoints that
opted out of a mechanism already working in this repo.

## 12. No global exception filter

**`src/main.ts`** · symptom: vague errors

Any non-`HttpException` becomes a bare `{"statusCode":500,"message":"Internal server
error"}`, while the log receives the full driver dump. Findings 3, 4, 11, 13 and 14 all
reach the client through this hole. There is also no `Logger` — finding 9 uses
`console.log`.

## 13. `?userId=abc` produces `NaN` and a 500

**`src/orders/orders.controller.ts:13`** · symptom: vague errors

```ts
return this.ordersService.findByUser(parseInt(userId, 10));   // "abc" → NaN
```

`GET /orders?userId=abc` → `500`. The `:id` path params use `ParseIntPipe` and correctly
return `400`; this query param was left unguarded.

## 14. Deleting a referenced product returns a raw 500

**`src/products/products.service.ts:47`** · symptom: vague errors

**Evidence**

```console
product 1 (has order_items): 500      # foreign key violation, surfaced raw
product 2 (no order_items):  200
```

Another data-dependent failure on a single endpoint. The correct answer is `409 Conflict`
explaining that the product is referenced by existing orders.

---

## Secondary observations

| # | Observation | Location |
|---|---|---|
| 15 | Every order query drags user + items + products + categories via `eager`, which cannot be disabled in `find`/`findOne`. The explicit `relations` arrays are entirely redundant with the eager flags. Left alone: removing `eager` would change every order response's shape, which is a contract change rather than a repair. | `orders.service.ts:48,59,145` |
| 16 | Search loads the whole `products` table and filters in JS — no SQL `WHERE`, no pagination, no index. | `products.service.ts:59` |
| 17 | No cache invalidation on product create/update/delete, so finding 2's key stays stale for its full TTL. | `products.service.ts` |
| 18 | `decimal` columns return **strings** from `pg`. `total += product.price * qty` works only because `*` coerces; `+` would concatenate. | `orders.service.ts:88` |
| 19 | `compose.yaml` puts postgres on `backend` and redis on `cache-network` with no shared network. Harmless while the app runs on the host; breaks the moment it is containerised. | `compose.yaml:20,34` |
| 20 | `synchronize: true` derives schema from entities on every boot. Renaming a property drops the old column and its data, silently. | `app.module.ts:28` |
| 21 | `compose.yaml` declares no volume for postgres, so the database lives in the container's writable layer and is destroyed whenever the container is recreated. | `compose.yaml:3-19` |

Findings 19, 20 and 21 are **not addressed** — none causes a reported symptom. Finding 20
is expanded under [Recommendation: migrations](#recommendation-replace-synchronize-true-with-migrations)
below.

Finding 21 was discovered mid-investigation, and it explains something that looked at
first like a bug in the test fixtures. A `docker compose up -d` recreated the containers,
which silently destroyed every product and order from the earlier session. `synchronize:
true` then rebuilt the schema on boot, so the service came back up looking perfectly
healthy against an empty database — with primary key sequences restarted at 1. The two
compound: no persistence means data loss is possible, and automatic schema creation means
nothing announces that it happened.

---

## Security observations

Raised by an automated security review of the baseline commit. None of these causes a
symptom listed in `INSTRUCTIONS.md`, and none is fixed here. They are recorded because
they were found — and because two of them are sharper readings of defects already listed
above.

### 21. No authentication or authorization on any endpoint

**all controllers** · not fixed — out of scope

Every route is open:

- `GET /users` returns every registered email address.
- `DELETE /users/:id` lets anyone delete any account.
- `POST /orders` accepts an arbitrary `userId`, so anyone can place orders as anyone.
- `PATCH /orders/:id/status` lets anyone mark any order `delivered`.

Fixing this means introducing identity, guards and a session or token mechanism — a new
subsystem, not a repair. `INSTRUCTIONS.md` states *"Do not add new features"*, so it is
recorded here rather than built.

### 2 (recast). The search cache is a poisoning vector, not just a correctness bug

**`src/products/products.service.ts:53`** · fixed as finding 2

Because the key is a constant, any caller controls what every other caller sees. One
request for a nonsense term seeds an empty array under `product-search`, and every
subsequent search — for any term, by any user — returns nothing for the full 60s TTL.

That is an unauthenticated denial-of-content costing a single request. Keying the cache
by query removes the vector as a side effect of fixing the correctness bug.

### 7 (recast). The retry loop is a remote resource-exhaustion vector

**`src/orders/orders.service.ts:26`** · fixed as finding 7

A single `POST /orders/:id/pay` can occupy a connection for 202 seconds, unauthenticated.
A few dozen concurrent requests exhaust the connection pool and the service stops
answering — no special tooling required.

Bounding retries to 3 attempts cuts the worst case from 202 seconds to under one, which
closes the vector along with the latency problem.

---

## Recommendation: replace `synchronize: true` with migrations

**`src/app.module.ts:28`** · not fixed — out of scope

`synchronize: true` compares the entity classes against the live schema on every boot and
issues whatever DDL is needed to reconcile them. Convenient in development, genuinely
dangerous anywhere else:

- **Silent data loss on rename.** Rename `Product.name` to `Product.title` and TypeORM
  drops the `name` column — with every value in it — then adds an empty `title`. No
  prompt, no backup, no error.
- **Truncation on narrowing.** Reducing a column's length or precision rewrites the data
  to fit.
- **Races on boot.** Two instances starting together can issue conflicting DDL against
  the same database.
- **No history.** There is no record of what shape the schema is in, how it got there, or
  how to roll back.

The replacement is standard TypeORM:

```ts
synchronize: false,
migrations: ['dist/migrations/*.js'],
```

plus a `DataSource` definition, `migration:generate` / `migration:run` scripts, and an
initial migration capturing the current schema.

**Why it is not done here.** It restructures the application's boot wiring and adds a
tooling layer, while fixing none of the five reported symptoms — precisely the
*"redesign the system"* that `INSTRUCTIONS.md` rules out. It is also load-bearing for
this submission: fix 8 adds a nullable `transactionId` column to `Order` and relies on
`synchronize` to create it. Switching to migrations would mean authoring that migration
as well, expanding the change further.

The recommendation stands for any real deployment: turn `synchronize` off, generate a
baseline migration, and gate schema changes behind review.

---

## Corrections

Two predictions made during investigation turned out to be wrong. Recording them because
the correction is more informative than the guess.

**Repeating a product within one order does not lose the update.** Ordering the same
product twice in a single request was expected to drop one decrement (stock 9 → 8).
Observed 9 → 7: both landed. The awaited `orderItemsRepository.save` between iterations
gives the floating promise time to complete its read-modify-write. The race in finding 6
is real but *timing-dependent*, not guaranteed — which is why it had to be demonstrated
with concurrent requests rather than sequential items.

**Stopping Postgres does not exercise the retry loop.** `processPayment` calls
`findOne(orderId)` at line 105, *outside* the loop. With the database already down it
throws before the loop is ever entered, returning in 35ms. Proving finding 7 required
making the payment stub itself fail deterministically.
