# SupplyQuest HQ

A live, explorable 3D company workspace where specialised agents research, plan,
coordinate and operate a small Canadian import business under the owner's
control.

The office is real WebGL — rooms, desks, lighting, shadows and animated avatars
that walk between departments. But the 3D view is a *window* onto a durable
backend, not the product itself: every business action is equally available from
a table, a Kanban board, a workflow graph and a JSON API.

> **Read this first.** This repository contains a working application and a
> deliberately labelled demo dataset. It contains **no validated business
> opportunity.** The seeded products are hypotheses; the seeded suppliers,
> quotes and findings are fabrications marked `SYNTHETIC_DEMO`; and the research
> URLs supplied by the owner are marked `UNVERIFIED_LEAD` because this
> application has not fetched them. Nothing here establishes that anyone wants
> any of these products.

---

## What actually works

| Area | Status |
| --- | --- |
| 3D office (WebGL, 11 zones, walking avatars, click-to-inspect) | Working |
| Table / Kanban / workflow-graph parity views | Working |
| Durable orchestrator: leases, heartbeats, timeout reaping, cancellation | Working |
| Workflow engine: parallel, join, conditional, review, timer, owner approval | Working |
| Bounded rework loops with explicit `maxTraversals` | Working |
| Event log with gap-free per-workspace sequence; SSE resume and dedup | Working |
| Backend-enforced, content-hashed owner approvals | Working |
| Idempotent external actions with replay safety | Working |
| Deterministic finance engine (landed cost, contribution, break-even, cash) | Working |
| Evidence records with provenance labels and separated fetch/publish dates | Working |
| Agent builder: add, clone, edit, pause, archive with three dispositions | Working |
| Deterministic demo executor | Working |
| Anthropic model adapter | Implemented, untested without a key — see below |
| OpenAI-compatible model adapter | **Not implemented.** Declared in config, refused at startup |
| Web search provider | **Not configured.** `web.search` reports itself unavailable rather than inventing results |
| Shopify / accounting / email / supplier connectors | **Not implemented.** Privileged actions reach a recording test adapter only |

`GET /api/health` returns this same list at runtime, so the application never
claims a capability it does not have.

### What is NOT done

This is increment 1–4 of the five-increment delivery sequence, plus parts of 5.
Specifically **not** built:

- Quality, logistics, CRM, marketing-experiment and bookkeeping **dashboards**
  are routed and empty. The underlying tables exist and the API serves them;
  the screens show an explicit "no records" notice rather than placeholder
  figures.
- **CSV and Markdown export** of decision packets.
- **File upload** for owner-supplied documents (the schema and evidence linkage
  exist; there is no upload endpoint).
- A **live-mode integration test**. Without an API key the Anthropic adapter is
  verified only for its disconnected behaviour: that it throws rather than
  returning demo output. The credentialed path is untested.

---

## Running it

Requirements: Node 22+, PostgreSQL 16+.

```bash
npm install

# 1. A database. Either use Docker...
docker compose up -d db
# ...or point DATABASE_URL at your own PostgreSQL 16.

cp .env.example .env      # then edit DATABASE_URL

npm run migrate           # forward-only migrations
npm run seed              # the demo company
npm run dev               # API on :8787, web on :5173
```

Open <http://localhost:5173>.

Other commands:

```bash
npm test          # 93 shared + 95 server tests
npm run typecheck # strict TypeScript across all three packages
npm run build     # production build of all packages
npm run reset     # DROP and recreate the schema (dev databases only)
```

### Browser smoke check

`npm test` does not prove the application *runs*. This does:

```bash
npm install -D playwright      # already a devDependency here
npm run dev                    # in another terminal
node scripts/smoke.mjs
```

It drives a real Chromium against the real API and database, asserts the canvas
holds a live WebGL context whose framebuffer is genuinely painted, walks every
view, and fails on any console error or failed request. Screenshots land in
`artifacts/smoke/`.

---

## The honesty mechanisms

These are the parts worth reviewing closely, because they are what make the rest
trustworthy.

### 1. Data provenance labels

Every claim, figure and record carries one of six labels:

`SYNTHETIC_DEMO` → `UNVERIFIED_LEAD` → `SUPPLIER_CLAIM` →
`SOURCE_BACKED_OBSERVATION` → `CUSTOMER_VALIDATED` → `OWNER_CONFIRMED_ACTUAL`

A derived value is never stronger than its weakest input (`weakestLabel`). An
agent's recommendation cannot upgrade a label; only new evidence or an owner
confirmation can.

The seeded research URLs are the clearest demonstration. They were supplied by
the owner, so they are recorded — but as `UNVERIFIED_LEAD` with **no excerpt**
and a rationale saying the application has not retrieved them. Labelling them
`SOURCE_BACKED_OBSERVATION` would have been the exact fabrication the product
forbids.

### 2. Unknown never becomes zero

`Maybe<T>` carries either a value or the reasons it is unknown, and unknown-ness
propagates through every aggregation. There is deliberately **no
`valueOrZero` helper**. If the parcel rate for Calgary has not been quoted,
contribution comes back unknown with that sentence attached — not a number that
silently assumed free shipping.

### 3. No floating point in money

Every monetary value is an integer count of minor units plus an explicit
currency. Decimals are parsed from strings by string manipulation; `parseFloat`
never touches a price. Rounding is half-away-from-zero, chosen because it is
symmetric about zero and auditable by hand, and it is documented at the point of
use rather than left implicit.

Cross-currency arithmetic throws. FX rates carry the pair, the effective date,
the source and a provenance label, because a converted figure inherits the
trustworthiness of its rate.

### 4. Approvals bind to content, and the backend enforces them

A disabled button is a courtesy. The control is `enforceToolCall`, which runs at
the moment of execution and checks, in order: emergency stop, run lease validity,
the agent's stored permission list, and a granted, unexpired approval whose
SHA-256 hash matches the canonical serialisation of this exact payload.

Change the amount from 420.00 to 42,000.00 after approval and the call fails
closed with `APPROVAL_CONTENT_MISMATCH`. Amending content in the UI invalidates
the approval and opens a fresh pending one. A granted approval is consumed
atomically, so one consent authorises exactly one act.

### 5. Live mode cannot quietly become demo mode

There is no fallback path. A live run with a missing credential fails with
`PROVIDER_DISCONNECTED` naming the missing environment variable. Configuring
`EXECUTION_MODE=live` with `MODEL_PROVIDER=demo` is refused at startup. A
whitespace-only API key is treated as absent, not as a credential.

### 6. Deterministic arithmetic, non-deterministic models

Models supply *inputs*. The finance engine does the arithmetic. No figure that
reaches a decision packet was computed by a language model, and the same inputs
always produce the same outputs — there is no sampling anywhere in that path.

### 7. Prompt injection cannot escalate

The architectural guarantee is not the pattern matcher. It is that an agent can
*request* an approval but never *grant* one. A fully hijacked model that emits
`order.place` is refused for want of an approval that does not exist. Retrieved
text is enveloped and rendered inside hard delimiters that it cannot close, and
is never concatenated into instructions. The detector exists as defence in depth
and as an audit signal, and is deliberately not load-bearing.

---

## Architecture

```
packages/shared   Pure, dependency-light domain core. Decimal arithmetic, Money,
                  Maybe, provenance, Incoterms, the finance engine, scenarios,
                  scoring, 21 role templates, zones, tool catalogue, lifecycles.
                  93 tests, all driven by hand-computed fixtures.

packages/server   Fastify + PostgreSQL. Migrations, durable lease-based queue,
                  workflow engine, event log, approval enforcement, tool
                  registry, provider adapters. 95 tests against a real database.

packages/web      React 19 + React Three Fiber + @xyflow/react. The 3D office,
                  the parity views, the inspector and the live timeline.
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the data model, the
execution model and the reasoning behind the load-bearing decisions.

### Dependency versions

Versions were resolved against the registry and pinned, not guessed. One
notable constraint: `@react-three/fiber@9.7.0` declares `react: ">=19 <19.3"`,
so React is pinned to **19.2.8** rather than the newest 19.3.0. An `overrides`
entry pins `vitest` to 4.1.11 because npm 10.9.x crashes resolving vitest 5's
optional-peer graph, which Vite's devtools peer pulls in transitively.

---

## Security notes

- Secrets stay server-side. `.env.example` contains no values.
- Outbound fetches pass an SSRF guard that resolves DNS and refuses private,
  loopback, link-local, CGNAT, unique-local and multicast addresses, embedded
  credentials, non-HTTP schemes and unfollowed redirects. IPv4-mapped IPv6 is
  handled in both dotted and hex serialisations.
- Conditional workflow nodes use a restricted comparison parser, never `eval`
  or `new Function`. Workflow graphs are editable through the API, so an
  expression evaluator there would be remote code execution.
- There is no agent-generated shell execution anywhere.
- **There is no authentication yet.** The API assumes a single trusted local
  owner. Do not expose this to a network without adding authentication and
  per-workspace authorisation first.

## Licence and scope

This application is a research and operations tool. Its compliance register is
produced by a *research assistant*, not counsel: it cites sources and raises
questions for a professional, and it never displays anything as legally
approved. Its bookkeeping output is draft material for a human accountant, never
a filed return.
