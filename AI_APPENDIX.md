# Form 5 — AI Interaction Summary


## 1. Tools and models used

| Tool | Model | Used for |
|---|---|---|
| ChatGPT | GPT Sol 5.6 | Thinking partner: shaping my first thoughts on the case into a prompt, and critiquing Opus's plans |
| Claude (chat) | Claude Opus 5.5 | Producing the coding plan from those prompts, then the final plan that became the design brief (`AGENTS.md`) |
| Claude Code (CLI agent) | Claude Opus 5.5 | Critical review of that brief against the case, clarifying questions, implementation, tests, measurements, docs |
| Claude Code skills | `brainstorming`, `code-review` | `brainstorming` on `AGENTS.md` before any code: it questioned the brief and Claude updated it with the decisions. `code-review` on the finished code, which found the second round of bugs in §3 |

**How the design brief was made: two models checking each other.** I drafted my initial
thoughts on the case with Sol and had it turn them into a prompt. Opus turned that prompt
into a coding plan. I gave the plan back to Sol to evaluate, took its critique and revised
plan back to Opus for the final version, and that became `AGENTS.md`. Using a model from
another vendor as the reviewer meant the plan was challenged by something that doesn't
share the author's blind spots, rather than by the author re-reading its own work.

I did not edit `AGENTS.md` by hand: after two rounds between the models it read as a solid
plan, and I accepted it. Its later changes came from running the `brainstorming` skill on
it in Claude Code, which updated it with the decisions from that session. It wasn't. It contained the flaws listed in §3, including one that
would have left flash-sale prices discounted forever. None of them was visible from reading
it. They surfaced only when I had it reviewed adversarially against the case (Prompt 2).

Working mode from then on: the AI proposed, I decided. Every open business question was put to me as an
explicit choice with a recommendation before any code was written:
- overlap policy
- the meaning of "dynamic pricing rules"
- pagination style
- rounding rule
- how real the serverless runtime should be

The answers are recorded in the ADR. From the implementation onward, no behaviour claim was
accepted on the AI's word alone: each is backed by a test or a measured run (README →
"Measured locally").

I also checked the workflows from the design doc by hand, not just through the AI's tests.
I ran the test suites myself, called the API step by step (category sale, product
promotion winning over it, product added during a sale, cancel, overlap, vendor CSV with bad
rows), and checked the database rows to confirm they matched what the API returned. At the
end I had Claude write an OpenAPI spec with an interactive reference (`/docs`) and a
single-command startup (`npm run up`), so a reviewer can run and test the project the same
way without any setup.

## 2. The two most critical prompts

**Prompt 1 — architecture analysis** (the first step of the chain that produced `AGENTS.md`)

I asked Sol to help me write it:

> "I am preparing for a senior backend engineer position and received a case study. I will
> utilize LLM to create a plan for the case study and help me come up with a prompt for the
> following case study [case study]"

I then gave the resulting prompt to Opus:

<details>
<summary>The prompt given to Opus</summary>

> I received this backend case study for a Senior Software Engineer interview.
>
> I want you to act as a senior backend engineer helping me analyze it before I start coding.
>
> Please read the case study and come up with:
>
> 1. The main requirements and business rules
> 2. A proposed database/domain model
> 3. How you would handle promotions and conflicts
> 4. An architecture for the 500k+ product ingestion
> 5. An architecture for the flash-sale scenario
> 6. The main APIs
> 7. A reasonable implementation plan
> 8. The main things an interviewer is likely to challenge
>
> Keep the solution practical. I don't want unnecessary microservices or over-engineering.
>
> For the ingestion part, think about serverless limitations like timeout, memory, retries,
> and the fact that the process is stateless.
>
> For flash sales, think about the fact that a promotion can suddenly affect 50k+ products
> and that the products API will receive a lot of traffic.
>
> Don't write the actual implementation yet. I want to discuss the architecture first.
>
> Also, don't assume my initial ideas are correct. If there are ambiguities in the case
> study, point them out and make reasonable assumptions.
>
> Here is the case study: [case study]
</details>

Why it mattered: it asks for analysis before code, names the constraints that make each
scenario hard (serverless timeout/memory/retries/statelessness; 50k products under heavy
read traffic), rules out over-engineering, and asks the model to challenge my assumptions
and list what an interviewer would attack. The plan went back to Sol for critique and then
to Opus for the final version, which became `AGENTS.md`.

Its blind spot, in hindsight: it asks for *architectures*, not for *failure modes*. It
never asks "what happens when a promotion's end date passes", "what happens under
concurrent writes", or "what if a message is lost". Every major flaw in §3 is exactly one
of those, and none of them surfaced during the Sol/Opus planning loop. Next time I would add
a step that asks explicitly for the ways the design fails, per scenario.

**Prompt 2 — adversarial review + build** (Claude Code, plan mode):

> "I am preparing for interview at invent.ai and I've received the case study at
> @business-ask.txt, then Claude generated @AGENTS.md so help me crack this interview,
> ask questions to clarify if anything need clarification"

Why it mattered: it asked for **clarifying questions** instead of letting the AI fill the
gaps, and it put the AI-written brief *itself* under review rather than treating it as a
spec. The review produced the list in §3. The clarifying round turned each open question
in the brief into an explicit decision.

## 3. Error correction — the biggest mistakes, and how they were steered

### The biggest: precomputed prices with no notion of time (Scenario B)

The AI's design stored a `status` column (`SCHEDULED/ACTIVE/EXPIRED`) and a precomputed
`effectivePrice` per product. Both were recomputed **only when someone wrote a promotion**.
Nothing ever ran when a date passed.

**How it would have failed.** "50% off Accessories until Sunday 23:59" ends, and on Monday
morning 50,000 products are still at half price. Worse, they're served from Redis, because
the cache was only invalidated on writes too. A scheduled sale would likewise never start.
For a retailer this is a direct revenue loss, and it's silent: no error, no alert.

**How it was caught.** Not by reading the brief. I had read it and accepted it. It came out
of the adversarial review in Claude Code (Prompt 2): checking the brief line by line against
the case, the review asked what recomputes a price when a promotion's *date* passes rather
than when it's *written*. Nothing did. I verified that against the brief myself. Opus then
asked me a few questions about how to fix it, and I picked the approach that made the most
sense to me. It is described below and recorded in the ADR (§1 and §3).

**How it was fixed:**
1. **Status is derived, not stored.** It's computed from `starts_at/ends_at/cancelled_at`,
   so it cannot go stale.
2. **Every price row carries `valid_until`**: the earliest moment its answer could change
   (the winning promotion's end, or the next applicable start).
3. **Delayed recompute messages** fire at each category promotion's exact start/end, and a
   **minute sweeper** recomputes any row with `valid_until <= now()`. It's index-backed and
   acts as a safety net.
4. **Read-side guard.** `GET /products/:id` recomputes a single row past its `valid_until`
   before answering, so the busiest endpoint is correct even in the sweeper's window.
5. **Tests with a controllable clock** cover the full lifecycle: a sale ends and prices
   revert, a scheduled sale activates on time, a product promotion ends and the product
   falls back to the category sale.

### Other flaws found in the AI's design brief

| AI proposal | Failure mode | Correction |
|---|---|---|
| `GET /products/:id` cached per product, "invalidated when that product's row changes" | A category flash sale reprices 50k products without touching those keys. The **highest-traffic endpoint** keeps serving pre-sale prices for the full TTL. | The detail entry is stamped with its category's cache version + `valid_until`. A mismatch is a miss. Tested. |
| Bump the category cache version when the promotion is marked ACTIVE (before the recompute) | Readers refill the new version with **old** prices, and the bug looks like "cache didn't work". | Bump strictly after the recompute commits. Readers read the version *before* querying the DB. |
| Index `(categoryId, effectivePrice)` on a table with no `categoryId` column | The central index of the design could not exist as specified. | Denormalized `category_id` into `product_prices`. |
| Upload endpoint "streams the file" through the function | Serverless request-size limits (Lambda: 6 MB) and timeouts on a 28 MB+ body. | Presigned upload straight to object storage. The storage event triggers the dispatcher. |
| Chunk "completion recorded" for idempotency | Written separately from the upserts, a crash between the two double-applies or loses a chunk. | Claim + upserts + counters in **one transaction**. A test fires 3 concurrent deliveries; exactly one commits. |
| Dispatcher "checkpoints its offset" | Raw byte offsets split CSV records containing quoted newlines or multibyte characters. | Checkpoint `csv-parse`'s record-boundary byte count, verified empirically. The header is persisted for resumed reads. |
| "Product created during an active sale picks it up automatically" | True only without concurrency: a product inserted while the sale is being created can miss it permanently. | Per-category advisory locks (shared for writers, exclusive barrier for recompute). |
| Promotion-create enqueues a recompute after commit | A lost message means a sale committed but never applied, with nothing to detect it. | `pricing_rev` / `pricing_synced_rev` + sweeper reconciliation (lightweight outbox). Tested with a failing queue. |
| Resolver called per row during ingestion | 1,000 promotion queries per chunk. | Load live promotions once per chunk, resolve in memory. |

### Mistakes caught during implementation (AI-written code, caught by verification)

- **A test that couldn't fail.** The first concurrency test for the race above ran 40
  product creates alongside a sale and passed. A **mutation check** (remove the locks,
  re-run) showed it still passed 5/5, because a trailing recompute healed the race
  and the timing window was too narrow to hit. It was replaced with a deterministic test
  that holds a product transaction open across the sale's creation. That test fails
  without the barrier (`Expected 500, Received 1000`) and passes with it.
- **Null-typed bulk parameters.** Bulk `unnest` upserts failed with `cannot cast type
  integer[] to uuid[]` when every row in a batch had no promotion: the driver can't infer
  a type for an all-`null` array. The fix transports nullable columns as text with
  `NULLIF`, which also fixed a latent copy of the same bug in row-error recording.
- **Two clocks.** A default of `now()` in the database, compared against the injected
  application clock, made the reconciliation grace period meaningless in tests. It would
  also have been wrong under clock skew. All timestamps that feed decisions now come from
  one clock.
- **A lock that only covered half the race.** The advisory-lock barrier above protected
  *new* products, and its test passed. A later code review of the finished system asked
  what happens to *updates*. The weekly vendor sync mostly updates existing SKUs. The
  category recompute is a single `INSERT … SELECT … ON CONFLICT DO UPDATE` that prices
  from its start-of-statement snapshot. When an ingestion chunk updated the same product
  concurrently, the recompute waited on the chunk's price row, then overwrote it with the
  **old** base price. Product-scoped promotions took no lock at all, so a concurrent
  write could silently drop one. The promotion was already marked synced, so reconcile
  would never repair it. Both cases were reproduced with deterministic tests first:
  `Expected 2000, Received 1000` and `Expected 700, Received 1000`. The fix is a
  `FOR SHARE` row lock on the products in the recompute. Lesson: a lock is scoped to the
  interleavings its test exercises, and "insert" and "update" are different
  interleavings.
- **The fix for that race created a deadlock.** Running the `code-review` skill on the
  finished code found that the new `FOR SHARE` locks were taken in product-id order, while ingestion
  chunks lock the same rows in SKU order. A flash-sale recompute running alongside a
  vendor sync could deadlock: Postgres aborts one side, and the chunk burns its retries
  and lands in the dead-letter queue during exactly the busiest moment. The fix locks the
  chunk's existing rows in id order before the upsert. A deterministic test makes SKU
  order the reverse of id order and interleaves the two. With the lock removed, it fails
  with Postgres `40P01 deadlock detected`. Lesson: every new lock needs a
  check of lock *order* against every other writer of the same rows, not just a test of
  the race it was added for.
- **Failure handling that could itself fail silently.** The same review found three
  places where the safety nets from §3 had holes:
  - the reconcile pass re-enqueued with a constant job id, which BullMQ drops for as long
    as a failed job with that id is retained, so after one recompute exhausted its
    retries (e.g. a DB outage), its sale could never be re-driven;
  - only chunk workers had a dead-letter handler, so a malformed CSV left the job in
    `DISPATCHING` forever with no error shown;
  - one row with `stock=99999999999` passed validation, overflowed the `int` column, and
    rolled back its whole 1,000-row chunk, when bad rows are supposed to be rejected one
    by one.

  Each got a regression test. The upload URL was also made create-only, because
  replacing the file mid-ingestion would invalidate the dispatcher's byte-offset
  checkpoints.

### What I take from it

The most instructive part wasn't any single bug. It was that a plan reviewed by two models,
and by me, still read as correct while missing a whole dimension: time. Reviewing for
plausibility doesn't find failure modes. Next time I'd ask directly, per scenario, "what
happens when a date passes, when two writers collide, when a message is lost", and I'd only
trust a fix after seeing its test fail without it.
