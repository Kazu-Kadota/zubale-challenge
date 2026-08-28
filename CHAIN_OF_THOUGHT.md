# Chain of Thought

How this challenge was actually worked, including the parts that went wrong.

I used Claude Code throughout. This document exists because *how* I used it is more
informative than the diff: an AI that is allowed to assert things produces plausible
findings, and plausible is not the same as true. Most of my effort went into refusing to
accept a claim until something outside the model had confirmed it.

## The rule I worked by

**Nothing counts as a finding until it has been reproduced.**

Reading code produces hypotheses. Only running the service produces evidence. I kept
those two categories separate for the whole investigation, and every entry in
[PROBLEMS.md](./PROBLEMS.md) carries the command that reproduced it and the output it
produced.

For the first half of the work I ran every command myself rather than letting the model
run them. Two reasons: I wanted to see the raw output before it was summarised for me,
and I have to be able to defend every one of these findings without the transcript in
front of me.

## How it went

### 1. Read everything, assume nothing

Claude read all 21 source files first and produced a set of hypotheses mapped to the five
symptoms in `INSTRUCTIONS.md`. It also read into `node_modules`, which is where the
largest finding came from: `@nestjs/cache-manager` v3 reads a `stores` option, the app
passes `store`, and the mismatch is silent. The app falls back to an in-process map and
Redis is never written to.

That one could be argued from source alone. I still made it the first thing we tested,
because "I read the library source" is not evidence.

### 2. Probe by probe

I ran each probe and pasted the raw output back. Several predictions were confirmed
exactly — the empty Redis keyspace, the search cache serving one query's results to
another, the circular-reference 500, the orphaned order left behind by a rejected
request.

Others were not, which mattered more.

### 3. Where I pushed back

At one point Claude described the stock race as though it were established. I asked
directly: *"Where have you proven that it can be happening?"*

The honest answer was that it hadn't been. What had been shown was that the code contains
a read-modify-write with no transaction and no lock — a race is *possible by
construction*. Whether it fires depends on timing. The distinction matters, and I wanted
it made explicit before we designed a fix around it.

We then proved it properly: five concurrent orders for five units each, against a stock
of five. All five succeeded. **Twenty-five units sold out of a stock of five.**

The same instinct applied later. When Claude reported a set of conclusions I asked it to
explain four of them in simpler terms, and then to **quiz me on them** so I could check my
own understanding rather than assume it. I got two wrong:

- I predicted `/categories/2/tree` would still return `200` after adding a third category.
  It returns `500`. My model was "it breaks when the chain runs out at the top"; the real
  rule is that relations load exactly one level deep, so recursion breaks the moment it
  steps *one hop away* from the node you asked for. Adding a grandchild breaks endpoints
  that worked yesterday, with no code change.
- I explained the unvalidated `status` field with the reasoning that actually applies to
  the batch endpoint. They fail for two different reasons: one has no DTO class at all,
  the other extracts a bare scalar that `ValidationPipe` skips by design.

I would rather find those gaps against a quiz than against an interviewer.

### 4. Deciding what not to do

`INSTRUCTIONS.md` says *"Do not add new features or redesign the system."* I treated that
as a real constraint rather than a formality, and it cut three things:

- **Migrations.** I raised replacing `synchronize: true` with a migration system and then
  withdrew it myself: it restructures boot wiring and fixes none of the five reported
  symptoms. It is recorded as a recommendation instead.
- **Authentication.** A security review flagged that every endpoint is open. It is real —
  `DELETE /users/:id` is unauthenticated — but building an auth layer is a new subsystem,
  not a repair.
- **Eager relations.** Removing them would change the shape of every order response. That
  is a contract change dressed up as a cleanup.

Each is documented as found-and-scoped-out rather than quietly dropped.

### 5. Tests that state what the business wants

Once the diagnosis was settled I changed how we worked: full test-implement-validate
loops rather than one finding at a time. I set one condition — **the tests describe what
the endpoint should return, not what the code currently does.** The code already exists,
so this is specification testing rather than TDD; the risk is writing tests that
faithfully encode the bug.

Every fix is two commits: the failing specs, then the change that makes them pass. The
history shows the red before the green.

I also pushed for end-to-end tests against the real Postgres and Redis rather than mocks.
Most of these defects — transaction rollback, a concurrency race, a foreign key
violation, whether cache entries actually reach Redis — **do not exist against a mocked
repository.** A mocked suite would have passed on the broken code and proved nothing.

## Where the AI was wrong

Recording these because a document that only lists successes is not describing a real
process.

| What was claimed | What happened |
|---|---|
| Ordering a product twice in one request would lose a stock decrement | It did not — the awaited write between iterations let the floating promise finish. The race is timing-dependent, and needed concurrent requests to demonstrate |
| Stopping Postgres would expose the 1000-attempt retry loop | It returned in 35 ms. `findOne` sits *outside* the loop, so it threw before the loop was entered. Proving it needed the payment stub itself forced to fail — it then took **202 seconds** |
| The 409 test fixture was pointing at the wrong product | The fixture was correct. The database had emptied itself, because `compose.yaml` declares no volume — which turned out to be a genuine finding of its own |
| The atomic stock update was working | It was accepting every order. `manager.query` returns `[rows, rowCount]` for `UPDATE`, so reading `.length` was always `2`. The SQL was right; the success check was not |

The last one is the argument for writing the test first. That bug was invisible to
inspection — the SQL was correct, the code read correctly — and only the concurrency spec
caught it. It was later rewritten to use TypeORM's typed `UpdateResult.affected`, which
removes the assumption rather than documenting it.

## What I asked for and what I decided

Decisions were mine; the model argued its case and I took or rejected it.

| Decision | Outcome |
|---|---|
| Redis adapter | `@keyv/redis`. The installed `cache-manager-ioredis-yet` implements a v5 interface that cache-manager v7 cannot accept — pnpm itself flags it as deprecated for this reason. Correcting `store` → `stores` alone would not have worked |
| Migrations | Dropped by me, as a redesign |
| Test strategy | Specification tests, business-expected returns, no change to business logic |
| Payment idempotency | I chose to add the `transaction_id` column. The plan had proposed a `409` to avoid a schema change; a `409` still leaves a timed-out caller unable to learn whether they were charged |
| Repository history | Baseline commit first, then problems, then solutions, then paired test/fix commits |

## Result

Fourteen defects, each reproduced before being fixed and verified after. 40 end-to-end
specs across 9 suites. `pnpm lint` went from 180 problems to none.

| | Before | After |
|---|---|---|
| Concurrent orders, stock 5, 5 units each | 25 units sold | 1 order, 4 correctly rejected |
| Payment against a failing provider | 202 s, then a 500 | 327 ms, then a 503 |
| Repeated payment | charged again | original transaction returned |
| Rejected order | order + item + stock consumed | nothing persisted |
| Cache entries in Redis | none | present, on the configured database |

## What I would do next

Out of scope here, but the honest list:

- **Authentication.** Every endpoint is open.
- **Migrations**, replacing `synchronize: true`.
- **A volume for Postgres**, and a separate database for the test suite — the specs
  currently leave fixture rows behind in the development database.
- **Reconciliation for payments.** If the confirmation write fails after a successful
  charge, the customer is charged and the order stays pending. Closing that properly needs
  an outbox, which is more than a bug fix.
