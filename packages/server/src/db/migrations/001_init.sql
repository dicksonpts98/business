-- ---------------------------------------------------------------------------
-- SupplyQuest HQ initial schema.
--
-- Design commitments encoded here rather than in application code:
--   * Every row is workspace-scoped, created_at/created_by stamped, and where
--     it carries a business claim, provenance-labelled.
--   * Artifact versions, workflow versions and agent config versions are
--     append-only. An in-flight run therefore cannot have its instructions or
--     its inputs rewritten underneath it.
--   * Events carry a gap-free per-workspace sequence so a client can resume
--     after reconnect and deduplicate.
--   * Runs hold a lease. Losing the lease is how an archived agent is stopped
--     mid-flight without discarding whatever it had already produced.
-- ---------------------------------------------------------------------------

CREATE TABLE workspace (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  reporting_currency text NOT NULL DEFAULT 'CAD',
  execution_mode text NOT NULL CHECK (execution_mode IN ('demo','live')),
  emergency_stop_engaged boolean NOT NULL DEFAULT false,
  emergency_stop_reason text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  email         text NOT NULL,
  display_name  text NOT NULL,
  is_owner      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, email)
);

-- Gap-free per-workspace event counter. Incremented with UPDATE ... RETURNING
-- inside the appending transaction, so sequence and row commit together.
CREATE TABLE workspace_event_seq (
  workspace_id  uuid PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
  last_seq      bigint NOT NULL DEFAULT 0
);

CREATE TABLE project (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  name          text NOT NULL,
  owner_objective text NOT NULL,
  geography     text[] NOT NULL DEFAULT '{}',
  status        text NOT NULL CHECK (status IN ('active','paused','rejected','completed')),
  paused_reason  text,
  data_label    text NOT NULL,
  created_by    uuid REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_workspace_idx ON project (workspace_id, status);

-- Role templates live in code but are mirrored here so custom roles can be
-- added without a code change.
CREATE TABLE agent_template (
  id            text PRIMARY KEY,
  workspace_id  uuid REFERENCES workspace(id) ON DELETE CASCADE,
  title         text NOT NULL,
  responsibilities text NOT NULL,
  home_zone     text NOT NULL,
  visual        jsonb NOT NULL,
  default_tools text[] NOT NULL,
  reviews       text[] NOT NULL DEFAULT '{}',
  authority_limits text NOT NULL,
  is_builtin    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_instance (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  template_id   text NOT NULL REFERENCES agent_template(id),
  name          text NOT NULL,
  status        text NOT NULL CHECK (status IN ('active','paused','archived')),
  -- Points at the config version future runs will use. Never rewritten in place.
  current_config_version_id uuid,
  created_by    uuid REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz
);
CREATE INDEX agent_instance_workspace_idx ON agent_instance (workspace_id, status);

-- Append-only. Editing an agent creates a new version; active runs keep theirs.
CREATE TABLE agent_config_version (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      uuid NOT NULL REFERENCES agent_instance(id) ON DELETE CASCADE,
  version       integer NOT NULL,
  instructions  text NOT NULL,
  appearance    jsonb NOT NULL,
  model         text,
  provider      text,
  allowed_tools text[] NOT NULL,
  max_run_seconds integer NOT NULL DEFAULT 300,
  max_tool_calls integer NOT NULL DEFAULT 25,
  department    text,
  review_of_role_ids text[] NOT NULL DEFAULT '{}',
  assigned_project_ids uuid[] NOT NULL DEFAULT '{}',
  created_by    uuid REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, version)
);
ALTER TABLE agent_instance
  ADD CONSTRAINT agent_current_config_fk
  FOREIGN KEY (current_config_version_id) REFERENCES agent_config_version(id);

-- Append-only workflow snapshots. A running task references the exact version
-- it started under, so editing the graph cannot retarget work in flight.
CREATE TABLE workflow_version (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  project_id    uuid REFERENCES project(id) ON DELETE CASCADE,
  name          text NOT NULL,
  version       integer NOT NULL,
  graph         jsonb NOT NULL,
  validation    jsonb NOT NULL,
  created_by    uuid REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_version_project_idx ON workflow_version (project_id, version DESC);

CREATE TABLE task (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  project_id    uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  workflow_version_id uuid REFERENCES workflow_version(id),
  node_key      text,
  title         text NOT NULL,
  instruction   text NOT NULL,
  node_kind     text NOT NULL DEFAULT 'task'
                  CHECK (node_kind IN ('task','parallel','join','conditional',
                                       'review','owner_approval','timer','connector_action')),
  state         text NOT NULL CHECK (state IN ('draft','queued','running',
                  'waiting_dependency','waiting_input','waiting_approval',
                  'completed','failed','cancelled')),
  assigned_agent_id uuid REFERENCES agent_instance(id),
  -- Bounded rework: a task may be reopened at most this many times, and each
  -- reopen creates a new run rather than erasing the previous one.
  rework_count  integer NOT NULL DEFAULT 0,
  max_rework    integer NOT NULL DEFAULT 2,
  waiting_reason text,
  priority      integer NOT NULL DEFAULT 100,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_ready_idx ON task (workspace_id, state, priority, created_at);
CREATE INDEX task_project_idx ON task (project_id, state);

CREATE TABLE task_dependency (
  task_id       uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  depends_on_task_id uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);

-- A run is an attempt. Separate from the task so an artifact can be sent back
-- for changes without pretending the producing run never happened.
CREATE TABLE run (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  task_id       uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  agent_id      uuid REFERENCES agent_instance(id),
  agent_config_version_id uuid REFERENCES agent_config_version(id),
  attempt       integer NOT NULL,
  state         text NOT NULL CHECK (state IN ('leased','succeeded','failed',
                  'timed_out','cancelled','quarantined')),
  quarantine_reason text,
  -- Lease and cancellation. A worker may only write results while it still
  -- holds the lease and cancel_requested is false.
  lease_token   uuid NOT NULL DEFAULT gen_random_uuid(),
  lease_expires_at timestamptz NOT NULL,
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  cancel_requested boolean NOT NULL DEFAULT false,
  checkpoint    jsonb,
  model         text,
  provider      text,
  execution_mode text NOT NULL CHECK (execution_mode IN ('demo','live')),
  -- Estimated unless the provider reported usage, which is recorded verbatim.
  cost_usd      numeric(12,6),
  cost_measured boolean NOT NULL DEFAULT false,
  input_tokens  integer,
  output_tokens integer,
  error_code    text,
  error_message text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  UNIQUE (task_id, attempt)
);
CREATE INDEX run_lease_idx ON run (state, lease_expires_at);
CREATE INDEX run_task_idx ON run (task_id, attempt DESC);

CREATE TABLE tool_call (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  run_id        uuid NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  tool_name     text NOT NULL,
  privileged    boolean NOT NULL,
  arguments     jsonb NOT NULL,
  outcome       text NOT NULL CHECK (outcome IN ('succeeded','failed','refused')),
  refusal_code  text,
  refusal_reason text,
  approval_id   uuid,
  idempotency_key text,
  duration_ms   integer,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tool_call_run_idx ON tool_call (run_id, created_at);

-- Append-only event log. seq is gap-free per workspace.
CREATE TABLE event (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  seq           bigint NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  project_id    uuid REFERENCES project(id) ON DELETE CASCADE,
  task_id       uuid REFERENCES task(id) ON DELETE CASCADE,
  run_id        uuid REFERENCES run(id) ON DELETE CASCADE,
  actor_kind    text NOT NULL CHECK (actor_kind IN ('owner','agent','system')),
  actor_id      uuid,
  actor_label   text NOT NULL,
  type          text NOT NULL,
  summary       text NOT NULL,
  artifact_id   uuid,
  data_label    text NOT NULL,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (workspace_id, seq)
);
CREATE INDEX event_stream_idx ON event (workspace_id, seq);

-- Append-only artifact versions.
CREATE TABLE artifact_version (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  artifact_key  uuid NOT NULL,
  version       integer NOT NULL,
  project_id    uuid REFERENCES project(id) ON DELETE CASCADE,
  task_id       uuid REFERENCES task(id) ON DELETE CASCADE,
  run_id        uuid REFERENCES run(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  title         text NOT NULL,
  body          jsonb NOT NULL,
  data_label    text NOT NULL,
  review_state  text NOT NULL DEFAULT 'draft'
                  CHECK (review_state IN ('draft','submitted','changes_requested',
                                          'accepted','quarantined','superseded')),
  quarantine_reason text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (artifact_key, version)
);
CREATE INDEX artifact_project_idx ON artifact_version (project_id, kind, version DESC);

CREATE TABLE evidence (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  project_id    uuid REFERENCES project(id) ON DELETE CASCADE,
  claim         text NOT NULL,
  url           text,
  uploaded_document_id uuid,
  title         text NOT NULL,
  publisher     text NOT NULL,
  published_at  timestamptz,
  fetched_at    timestamptz NOT NULL,
  source_type   text NOT NULL,
  excerpt       text NOT NULL,
  geographic_relevance text[] NOT NULL DEFAULT '{}',
  confidence_rationale text NOT NULL,
  data_label    text NOT NULL,
  contradicts   uuid[] NOT NULL DEFAULT '{}',
  duplicate_of  uuid REFERENCES evidence(id),
  recorded_by_run_id uuid REFERENCES run(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (url IS NOT NULL OR uploaded_document_id IS NOT NULL)
);
CREATE INDEX evidence_project_idx ON evidence (project_id, source_type);

CREATE TABLE opportunity (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  project_id    uuid REFERENCES project(id) ON DELETE CASCADE,
  name          text NOT NULL,
  hypothesis    text NOT NULL,
  gap_to_investigate text NOT NULL,
  china_supply_fit text,
  key_reason_to_reject text NOT NULL,
  precise_customer text,
  job_to_be_done text,
  locations     text[] NOT NULL DEFAULT '{}',
  cheapest_next_experiment text,
  rejection_criterion text,
  accountable_owner text,
  decision       text NOT NULL DEFAULT 'investigating'
                  CHECK (decision IN ('investigating','samples_proposed','rejected',
                                      'paused','launch_proposed','launched')),
  decision_rationale text,
  score          jsonb,
  data_label     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE product_spec (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  opportunity_id uuid REFERENCES opportunity(id) ON DELETE CASCADE,
  name          text NOT NULL,
  version       integer NOT NULL DEFAULT 1,
  use_case      text NOT NULL,
  requirements  jsonb NOT NULL DEFAULT '[]'::jsonb,
  materials     jsonb NOT NULL DEFAULT '[]'::jsonb,
  dimensions    jsonb,
  hs_code       text,
  hs_code_confirmed boolean NOT NULL DEFAULT false,
  data_label    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE supplier (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  name          text NOT NULL,
  country       text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('factory','trader','wholesaler','unknown')),
  source_url    text,
  contact_status text NOT NULL DEFAULT 'not_contacted'
                  CHECK (contact_status IN ('not_contacted','approval_pending','contacted')),
  -- A certificate is an unverified document until issuer, scope, product match
  -- and validity have each been checked.
  documents     jsonb NOT NULL DEFAULT '[]'::jsonb,
  data_label    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quote (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  supplier_id   uuid NOT NULL REFERENCES supplier(id) ON DELETE CASCADE,
  product_spec_id uuid REFERENCES product_spec(id) ON DELETE SET NULL,
  unit_price_minor bigint,
  currency      text,
  moq           integer,
  lead_time_days integer,
  incoterm      text,
  valid_until   date,
  -- 'quote' is an offer, 'assumption' is the analyst's guess, 'actual' is
  -- settled. These must never be displayed interchangeably.
  figure_kind   text NOT NULL CHECK (figure_kind IN ('quote','assumption','forecast','committed','actual')),
  data_label    text NOT NULL,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cost_scenario (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  opportunity_id uuid REFERENCES opportunity(id) ON DELETE CASCADE,
  name          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('base','downside','upside')),
  rationale     text NOT NULL,
  inputs        jsonb NOT NULL,
  results       jsonb NOT NULL,
  data_label    text NOT NULL,
  computed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE experiment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  opportunity_id uuid REFERENCES opportunity(id) ON DELETE CASCADE,
  name          text NOT NULL,
  hypothesis    text NOT NULL,
  channel       text,
  cac_threshold_minor bigint,
  currency      text,
  status        text NOT NULL CHECK (status IN ('proposed','approved','running','concluded','abandoned')),
  quality_assessment text,
  result        jsonb,
  data_label    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inventory_lot (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  product_spec_id uuid REFERENCES product_spec(id) ON DELETE SET NULL,
  quantity_received integer NOT NULL DEFAULT 0,
  quantity_on_hand integer NOT NULL DEFAULT 0,
  landed_unit_cost_minor bigint,
  currency      text,
  data_label    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shipment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  supplier_id   uuid REFERENCES supplier(id) ON DELETE SET NULL,
  reference     text,
  mode          text CHECK (mode IN ('sea_lcl','sea_fcl','air','courier','unknown')),
  milestones    jsonb NOT NULL DEFAULT '[]'::jsonb,
  estimated_sellable_from date,
  data_label    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE customer_issue (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  category      text NOT NULL,
  summary       text NOT NULL,
  product_spec_id uuid REFERENCES product_spec(id) ON DELETE SET NULL,
  severity      text NOT NULL CHECK (severity IN ('low','medium','high')),
  status        text NOT NULL CHECK (status IN ('open','awaiting_owner','resolved')),
  data_label    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE compliance_issue (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  product_spec_id uuid REFERENCES product_spec(id) ON DELETE SET NULL,
  jurisdiction  text NOT NULL,
  topic         text NOT NULL,
  authoritative_source_url text,
  effective_date date,
  accessed_at   timestamptz,
  apparent_applicability text NOT NULL,
  unresolved_questions text[] NOT NULL DEFAULT '{}',
  required_documents_or_testing text[] NOT NULL DEFAULT '{}',
  reviewer      text,
  status        text NOT NULL CHECK (status IN ('not_assessed','research_incomplete',
                  'professional_review_needed','evidence_recorded','owner_decision_recorded')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Approvals are content-bound. payload_hash covers the canonical serialisation
-- of the exact act; editing any field produces a different hash and the
-- approval no longer authorises the new content.
CREATE TABLE approval (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  project_id    uuid REFERENCES project(id) ON DELETE CASCADE,
  task_id       uuid REFERENCES task(id) ON DELETE CASCADE,
  requested_by_run_id uuid REFERENCES run(id) ON DELETE SET NULL,
  tool_name     text NOT NULL,
  payload       jsonb NOT NULL,
  payload_hash  text NOT NULL,
  state         text NOT NULL CHECK (state IN ('pending','granted','rejected',
                  'expired','invalidated','consumed')),
  expires_at    timestamptz NOT NULL,
  decided_by    uuid REFERENCES app_user(id),
  decided_at    timestamptz,
  decision_note text,
  invalidated_reason text,
  consumed_by_tool_call_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approval_pending_idx ON approval (workspace_id, state, expires_at);
CREATE INDEX approval_hash_idx ON approval (workspace_id, payload_hash, state);

-- Idempotency for external side effects. An identical replay returns the
-- recorded outcome instead of acting twice. Exactly-once delivery is never
-- promised; this plus reconciliation is what makes replay safe.
CREATE TABLE idempotency_key (
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  key           text NOT NULL,
  tool_name     text NOT NULL,
  request_hash  text NOT NULL,
  outcome_state text NOT NULL CHECK (outcome_state IN ('in_flight','succeeded','failed','uncertain')),
  response      jsonb,
  external_ref  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, key)
);

CREATE TABLE connector (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  display_name  text NOT NULL,
  -- Capabilities the adapter genuinely implements in this build.
  capabilities  jsonb NOT NULL DEFAULT '{"read":[],"write":[]}'::jsonb,
  health        text NOT NULL CHECK (health IN ('not_configured','disconnected','degraded','healthy')),
  health_detail text,
  last_checked_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE budget_ledger (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  project_id    uuid REFERENCES project(id) ON DELETE CASCADE,
  run_id        uuid REFERENCES run(id) ON DELETE SET NULL,
  kind          text NOT NULL CHECK (kind IN ('compute','business')),
  amount_usd    numeric(12,6) NOT NULL,
  measured      boolean NOT NULL DEFAULT false,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX budget_ledger_workspace_idx ON budget_ledger (workspace_id, kind, created_at);

CREATE TABLE audit_entry (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  actor_kind    text NOT NULL,
  actor_id      uuid,
  actor_label   text NOT NULL,
  action        text NOT NULL,
  subject_kind  text NOT NULL,
  subject_id    text,
  before        jsonb,
  after         jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_entry_workspace_idx ON audit_entry (workspace_id, created_at DESC);

CREATE TABLE document (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  project_id    uuid REFERENCES project(id) ON DELETE CASCADE,
  filename      text NOT NULL,
  media_type    text NOT NULL,
  byte_size     integer NOT NULL,
  sha256        text NOT NULL,
  storage_path  text NOT NULL,
  uploaded_by   uuid REFERENCES app_user(id),
  data_label    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
