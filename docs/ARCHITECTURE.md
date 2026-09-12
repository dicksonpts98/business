# Architecture

## Shape

Three packages, one database, one durable event log.

```
packages/shared ──► packages/server ──► PostgreSQL 16
       │                   │
       └───────────────────┴──► packages/web (React + R3F)
```

`shared` has no I/O. It holds the decimal and money primitives, the `Maybe`
type, provenance labels, Incoterm rules, the finance engine, the scenario
runner, the scoring model, the role catalogue, the tool catalogue and the task
and run lifecycles. Because it is pure, its 93 tests are hand-computed fixtures
rather than snapshots, and both the server and the browser share exactly one
definition of every business rule.

---

## Execution model

### Runs are attempts, tasks are work

A `task` is a unit of work. A `run` is one attempt at it. They are separate
tables on purpose: an artifact can be sent back for changes without pretending
the run that produced it never happened, and a retry is a new row rather than an
overwrite.

### Leases, not locks

A worker claims a task with `FOR UPDATE SKIP LOCKED` and opens a run holding a
lease with an expiry. It heartbeats while working. Three things follow:

- **A dead worker is recoverable.** The reaper finds runs whose lease expired
  without a heartbeat, marks them `timed_out`, and requeues the task for a
  bounded retry. Beyond the cap the task fails visibly instead of looping.
- **An archived agent stops acting.** Revoking the lease sets
  `cancel_requested`, and `enforceToolCall` refuses any further privileged call
  with `RUN_LEASE_LOST`. Work the agent had already produced is *quarantined*
  for review rather than accepted or silently discarded.
- **Reassignment cannot duplicate effects.** It opens a new run with a new
  identity; the revoked run's external effects are never replayed.

### Configuration is versioned, never mutated

`agent_config_version` and `workflow_version` are append-only. A run pins the
config version it started under. Editing an agent's instructions or permissions
creates a new version and repoints the agent — an in-flight attempt keeps
executing the instructions it began with. This is what makes "apply to future
runs" true rather than aspirational.

### Structural nodes do not call models

`join`, `parallel`, `timer` and `conditional` are control flow. Sending them
through the model path both wastes budget and fails confusingly: a join has no
agent, so its first tool call is refused for lack of permission, which reads as
a security error rather than a design mistake. They complete, park or branch
directly.

A `timer` parks with `scheduled_for` **in the database**, not a `setTimeout` in
a process, so the wait survives a restart.

### Dependency resolution is a sweep, not a hook

`promoteReadyTasks` moves tasks out of `waiting_dependency` when every
dependency has completed. It is written as an idempotent sweep rather than a
callback on task completion so that every path into a satisfied dependency set
is covered: a completion, a manual retry, a reassignment, or a dependency the
owner cancelled.

A dependency that ended in a *non-completed* terminal state fails its dependents
with the reason, rather than leaving the board silently stalled. A conclusion
drawn from missing work is worse than no conclusion.

---

## The event log

One append-only `event` table. Each row carries a `seq` that is **gap-free and
monotonic per workspace**, allocated by `UPDATE … RETURNING` on a counter row
inside the appending transaction.

Gap-free matters because the client resumes with "I have up to seq N". With
gaps it could not distinguish a missing event from a skipped number and would
have to refetch everything.

The event is appended in the **same transaction** as the state change it
describes. An event visible for a change that later rolled back would leave the
timeline permanently wrong.

Delivery is not exactly-once and is never claimed to be. Clients deduplicate by
event `id` and reconcile by `seq`; the UI displays both the resume cursor and
the count of duplicates it discarded, so the claim is checkable rather than
asserted.

SSE polls the same table the client would rebuild from, so there is no second
delivery path that could disagree with the log.

---

## The approval gate

```
validate arguments
        ↓
idempotency replay check      ← reads only; dispatches nothing
        ↓
enforceToolCall
   emergency stop → lease validity → agent permissions → content-hash match
        ↓
register idempotency key
        ↓
execute → finalise
```

The ordering is load-bearing:

- **Validation first**, so a malformed call never spends the owner's consent.
- **Replay check before enforcement.** The first call consumes the approval, so
  checking enforcement first would refuse every legitimate retry with
  `APPROVAL_ALREADY_CONSUMED`. A caller that cannot distinguish "already done"
  from "refused" will either duplicate the action by another route or abandon
  completed work.
- **Enforcement before registration**, so an unapproved call cannot claim a key.

Replay safety has two independent layers: the key short-circuits known requests,
and single-use approval consumption stops an *unknown* key from spending the
same consent twice.

A failure after dispatch records `outcome_state = 'uncertain'`, because the
action may or may not have reached the outside world and reconciliation must
look rather than assume.

---

## Data model notes

32 tables. The ones with non-obvious shapes:

| Table | Why it is shaped this way |
| --- | --- |
| `artifact_version` | Append-only, keyed by `(artifact_key, version)`. A revision is a new row; nothing is overwritten. |
| `idempotency_key` | Primary key `(workspace_id, key)`, so a concurrent duplicate loses the insert rather than both dispatching. |
| `approval` | Stores both the payload and its hash. Matching is by hash, so consent binds to content, not to a category of action. |
| `quote` | Carries `figure_kind` ∈ quote / assumption / forecast / committed / actual. These must never render interchangeably. |
| `evidence` | `published_at` and `fetched_at` are separate columns. Conflating them is how a stale claim looks current. |
| `run` | `cost_measured` is a boolean beside `cost_usd`, so an estimate can never be displayed as a measurement. |

---

## Finance

The engine is the only thing that computes a figure. Models supply inputs.

**Landed cost** = goods (FX-converted at a dated rate) + origin transport +
export clearance + international freight + insurance + duty + brokerage +
Canadian inbound freight + allocated inspection and packaging.

Incoterm-aware double-count detection is the subtle part. Under CIF the
supplier's price already includes freight and insurance; adding them again
overstates landed cost and can kill a viable product on paper. When a component
the supplier bears is supplied anyway, the engine **excludes it from the total**
and says so in both a blocker diagnostic and the trace line. The Incoterm is the
contractual fact; a stray amount is a data-entry error, and publishing a
knowingly inflated total that only a diagnostic contradicts would be worse than
either.

**Recoverable import tax** affects cash timing only. It is never netted against
economic cost, and when eligibility is unconfirmed it is reported as an
unrecovered outlay.

**Contribution** reverses refunded revenue, charges COGS, credits the
recoverable share of returned goods, writes off defects, and subtracts handling,
fulfillment, shipping, channel and payment fees and acquisition cost. Fee bases
are explicit: payment processors charge on the tax-inclusive total while
marketplace commissions usually do not, and getting that wrong is a silent 1–2%
error on every order.

**Break-even** is refused on non-positive contribution, because no volume
reaches profitability. Owner labour is excluded by default and the exclusion is
stated, since a business that only clears fixed cost by paying its owner nothing
has hidden a wage rather than broken even.

`auditScenarioSet` flags a "downside" case that is not actually adverse — the
most common way a scenario table flatters a bad product.

---

## Trust boundaries

| Boundary | Treatment |
| --- | --- |
| Retrieved web pages, supplier PDFs, uploaded documents | Data, never instructions. Enveloped in delimiters they cannot close, never concatenated into a system prompt or a task instruction. |
| Model output | Validated against a schema with bounded repair, then acted on only through the tool registry. |
| Workflow graph fields | Parsed by a restricted comparison grammar. Never `eval`: graphs are editable through the API. |
| Outbound URLs | DNS-resolved and checked against private, loopback, link-local, CGNAT, unique-local and multicast ranges, in both IPv4 and IPv6 including mapped forms. |
| Tool arguments | Zod-validated before enforcement, so injected text cannot smuggle a different destination into a call. |

The escalation guarantee is structural, not heuristic: **an agent can request an
approval but cannot grant one.** Everything else is defence in depth.

---

## Client

The browser holds an event-sourced projection. On load it fetches a snapshot and
the recent event history, then streams from the highest sequence it has applied.
A burst of events coalesces into one snapshot refetch rather than twenty.

The 3D scene subscribes to the same events as every other view. There is no
separate activity engine generating motion the backend does not know about.
Walking is how a handoff is *drawn*; it never gates, delays or orders execution.
If a result arrives mid-corridor the inspector and timeline show it immediately
and the walk simply finishes.

Idle, waiting and errored avatars are all visibly **still**, and errors use a
different indicator *shape*, not merely a different hue. An avatar that keeps
typing while its task is blocked is a lie the scene must not tell.

Labels are DOM overlays rather than 3D text: selectable, screen-reader readable,
scaling with browser font settings, and needing no font file at runtime. Only
the selected or hovered agent gets a full nameplate — labelling everyone at once
buried the avatars behind a wall of text and made the office unreadable.

three.js and the graph editor are separate lazily-loaded chunks, so the app shell
is ~24 KB gzipped and a viewer who never opens the 3D view never downloads the
renderer.

### Measured performance

On this development container (4 vCPU, 16 GB RAM, Chromium 1194 running
**software** rendering via SwiftShader, 1600×1000 viewport) the seeded office
with 13 avatars renders and remains interactive. No frame-rate figure is quoted
because none was measured on representative hardware with a GPU; the target of
20 visible avatars on a typical laptop is **untested**.
