import { useEffect, useState } from 'react';
import type { EvidenceRow } from '../api/client.js';
import { api } from '../api/client.js';

export type DashboardKey =
  | 'decisions' | 'evidence' | 'opportunities' | 'suppliers' | 'quality'
  | 'shipments' | 'finance' | 'creative' | 'customers' | 'compliance' | 'tasks';

export interface DashboardViewProps {
  readonly workspaceId: string;
  readonly dashboard: DashboardKey;
  readonly evidence: readonly EvidenceRow[];
}

const TITLE: Record<DashboardKey, string> = {
  decisions: 'Owner decisions',
  evidence: 'Evidence and counterevidence',
  opportunities: 'Opportunity dossiers',
  suppliers: 'Supplier comparison',
  quality: 'Quality and inspection',
  shipments: 'Inventory and shipments',
  finance: 'Finance scenarios and cash',
  creative: 'Brand, creative and marketing',
  customers: 'Customers and CRM',
  compliance: 'Compliance research register',
  tasks: 'Task board',
};

export function DashboardView({
  workspaceId, dashboard, evidence,
}: DashboardViewProps): React.JSX.Element {
  return (
    <div className="view view-dashboard">
      <h2>{TITLE[dashboard]}</h2>
      {dashboard === 'evidence' && <EvidencePanel evidence={evidence} />}
      {dashboard === 'opportunities' && <OpportunitiesPanel workspaceId={workspaceId} />}
      {dashboard === 'suppliers' && <SuppliersPanel workspaceId={workspaceId} />}
      {dashboard === 'finance' && <FinancePanel workspaceId={workspaceId} />}
      {dashboard === 'compliance' && <CompliancePanel workspaceId={workspaceId} />}
      {dashboard === 'decisions' && <AgentCostPanel workspaceId={workspaceId} />}
      {['quality', 'shipments', 'creative', 'customers'].includes(dashboard) && (
        <p className="notice">
          This department has no records yet. It is shown empty rather than filled
          with placeholder figures, because a plausible-looking number here would be
          indistinguishable from a real one.
        </p>
      )}
    </div>
  );
}

function EvidencePanel({ evidence }: { evidence: readonly EvidenceRow[] }): React.JSX.Element {
  const [label, setLabel] = useState('');
  const labels = [...new Set(evidence.map((e) => e.data_label))].sort();
  const rows = label === '' ? evidence : evidence.filter((e) => e.data_label === label);

  return (
    <>
      <p className="notice">
        Every record carries its own provenance label, the date it was fetched and
        the reasoning behind its confidence. A URL nobody retrieved is an
        UNVERIFIED_LEAD with no excerpt, never an observation.
      </p>
      <div className="view-toolbar">
        <label>
          <span className="sr-only">Provenance label</span>
          <select value={label} onChange={(e) => setLabel(e.target.value)}>
            <option value="">All labels</option>
            {labels.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <span className="muted">{rows.length} of {evidence.length}</span>
      </div>
      <ul className="evidence-list">
        {rows.map((item) => (
          <li key={item.id} className="evidence-item">
            <header>
              <span className={`label label-${item.data_label}`}>{item.data_label}</span>
              <strong>{item.claim}</strong>
            </header>
            <p className="muted">
              {item.url === null
                ? item.title
                : <a href={item.url} target="_blank" rel="noreferrer noopener">{item.title}</a>}
              {' · '}{item.publisher}{' · '}{item.source_type}
            </p>
            <p className="evidence-dates">
              Fetched {new Date(item.fetched_at).toLocaleDateString()}
              {' · '}
              {item.published_at === null
                ? 'publication date unknown'
                : `published ${new Date(item.published_at).toLocaleDateString()}`}
              {item.geographic_relevance.length > 0 && ` · ${item.geographic_relevance.join(', ')}`}
            </p>
            <blockquote>{item.excerpt}</blockquote>
            <p className="muted small">{item.confidence_rationale}</p>
            {item.duplicate_of !== null && (
              <p className="muted small">Marked as a syndicated duplicate of another record.</p>
            )}
            {item.contradicts.length > 0 && (
              <p className="warn-text">Contradicts {item.contradicts.length} other record(s). Disagreement stays visible.</p>
            )}
          </li>
        ))}
        {rows.length === 0 && <li className="muted">No evidence recorded.</li>}
      </ul>
    </>
  );
}

function useRemote<T>(load: () => Promise<T>, deps: readonly unknown[]): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let cancelled = false;
    void load().then((d) => { if (!cancelled) setData(d); }).catch(() => { if (!cancelled) setData(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return data;
}

function OpportunitiesPanel({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const data = useRemote(() => api.opportunities(workspaceId), [workspaceId]);
  if (data === null) return <p className="muted">Loading…</p>;
  return (
    <ul className="dossier-list">
      {data.opportunities.map((o, index) => (
        <li key={index} className="dossier">
          <header>
            <span className={`label label-${String(o['data_label'])}`}>{String(o['data_label'])}</span>
            <strong>{String(o['name'])}</strong>
            <span className={`pill pill-${String(o['decision'])}`}>{String(o['decision'])}</span>
          </header>
          <p className="hypothesis">{String(o['hypothesis'])}</p>
          <dl>
            <div><dt>Gap to investigate</dt><dd>{String(o['gap_to_investigate'])}</dd></div>
            <div><dt>China supply fit to verify</dt><dd>{String(o['china_supply_fit'] ?? '—')}</dd></div>
            <div><dt>Key reason to reject</dt><dd>{String(o['key_reason_to_reject'])}</dd></div>
            <div><dt>Cheapest next experiment</dt><dd>{String(o['cheapest_next_experiment'] ?? '—')}</dd></div>
            <div><dt>Rejection criterion</dt><dd>{String(o['rejection_criterion'] ?? '—')}</dd></div>
            <div><dt>Accountable owner</dt><dd>{String(o['accountable_owner'] ?? '—')}</dd></div>
          </dl>
          {o['decision_rationale'] !== null && o['decision_rationale'] !== undefined && (
            <p className="decision-rationale">{String(o['decision_rationale'])}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

function SuppliersPanel({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const data = useRemote(() => api.suppliers(workspaceId), [workspaceId]);
  if (data === null) return <p className="muted">Loading…</p>;
  return (
    <>
      <p className="notice">
        A supplier document is an unverified claim until its issuer, scope, product
        match and validity have each been checked. Contact status is shown so it is
        clear that no supplier here has been approached.
      </p>
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Supplier</th><th scope="col">Country</th><th scope="col">Kind</th>
            <th scope="col">Contact</th><th scope="col">Quotes</th><th scope="col">Label</th>
          </tr>
        </thead>
        <tbody>
          {data.suppliers.map((s, index) => {
            const quotes = (s['quotes'] as Record<string, unknown>[] | null) ?? [];
            return (
              <tr key={index}>
                <th scope="row">{String(s['name'])}</th>
                <td>{String(s['country'])}</td>
                <td>{String(s['kind'])}</td>
                <td>{String(s['contact_status'])}</td>
                <td>
                  {quotes.length === 0 ? <span className="muted">none</span> : quotes.map((q, qi) => (
                    <div key={qi}>
                      {((Number(q['unit_price_minor']) || 0) / 100).toFixed(2)} {String(q['currency'])}
                      {' · MOQ '}{String(q['moq'])}
                      {' · '}{String(q['lead_time_days'])}d
                      {' · '}{String(q['incoterm'])}
                      {' · '}<span className="chip">{String(q['figure_kind'])}</span>
                    </div>
                  ))}
                </td>
                <td><span className={`label label-${String(s['data_label'])}`}>{String(s['data_label'])}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

function FinancePanel({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const data = useRemote(() => api.costScenarios(workspaceId), [workspaceId]);
  if (data === null) return <p className="muted">Loading…</p>;
  return (
    <>
      <p className="notice">
        Every figure below came from the deterministic finance engine, not from a
        model. Contribution excludes fixed overhead and owner labour, so it is not
        net profit. Break-even is computed only when contribution is positive.
      </p>
      {data.scenarios.map((scenario, index) => {
        const results = scenario['results'] as Record<string, unknown> | null;
        const contribution = (results?.['contribution'] as Record<string, unknown> | undefined);
        const perOrder = contribution?.['contributionPerOrder'] as
          { known: boolean; value?: { minor: number; currency: string }; reasons?: string[] } | undefined;
        const breakEven = results?.['breakEven'] as
          { computed: boolean; reason?: string; breakEvenUnitsPerMonth?: { known: boolean; value?: number } } | undefined;
        const diagnostics = (results?.['diagnostics'] as { code: string; severity: string; message: string }[] | undefined) ?? [];
        return (
          <article key={index} className={`scenario scenario-${String(scenario['kind'])}`}>
            <header>
              <strong>{String(scenario['name'])}</strong>
              <span className={`pill pill-${String(scenario['kind'])}`}>{String(scenario['kind'])}</span>
              <span className={`label label-${String(scenario['data_label'])}`}>{String(scenario['data_label'])}</span>
            </header>
            <p className="muted">{String(scenario['rationale'])}</p>
            <dl className="scenario-figures">
              <div>
                <dt>Contribution per order</dt>
                <dd>
                  {perOrder?.known === true && perOrder.value !== undefined
                    ? `${(perOrder.value.minor / 100).toFixed(2)} ${perOrder.value.currency}`
                    : <span className="unknown">unknown — {perOrder?.reasons?.join('; ') ?? 'no reason recorded'}</span>}
                </dd>
              </div>
              <div>
                <dt>Break-even units per month</dt>
                <dd>
                  {breakEven?.computed === true && breakEven.breakEvenUnitsPerMonth?.known === true
                    ? String(breakEven.breakEvenUnitsPerMonth.value)
                    : <span className="unknown">not computed — {breakEven?.reason ?? 'contribution not positive'}</span>}
                </dd>
              </div>
            </dl>
            {diagnostics.length > 0 && (
              <ul className="diagnostics">
                {diagnostics.map((d, di) => (
                  <li key={di} className={`sev-${d.severity}`}>
                    <code>{d.code}</code> {d.message}
                  </li>
                ))}
              </ul>
            )}
          </article>
        );
      })}
      {data.scenarios.length === 0 && <p className="muted">No scenarios computed yet.</p>}
    </>
  );
}

function CompliancePanel({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const data = useRemote(() => api.compliance(workspaceId), [workspaceId]);
  if (data === null) return <p className="muted">Loading…</p>;
  return (
    <>
      <p className="notice notice-warn">{data.disclaimer}</p>
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Topic</th><th scope="col">Jurisdiction</th>
            <th scope="col">Apparent applicability</th><th scope="col">Open questions</th>
            <th scope="col">Status</th><th scope="col">Source</th>
          </tr>
        </thead>
        <tbody>
          {data.issues.map((issue, index) => (
            <tr key={index}>
              <th scope="row">{String(issue['topic'])}</th>
              <td>{String(issue['jurisdiction'])}</td>
              <td>{String(issue['apparent_applicability'])}</td>
              <td>
                <ul>
                  {((issue['unresolved_questions'] as string[] | null) ?? []).map((q, qi) => (
                    <li key={qi}>{q}</li>
                  ))}
                </ul>
              </td>
              <td><span className={`pill pill-${String(issue['status'])}`}>{String(issue['status']).replace(/_/g, ' ')}</span></td>
              <td>
                {issue['authoritative_source_url'] === null
                  ? <span className="muted">none recorded</span>
                  : <a href={String(issue['authoritative_source_url'])} target="_blank" rel="noreferrer noopener">source</a>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function AgentCostPanel({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const data = useRemote(() => api.agentCosts(workspaceId), [workspaceId]);
  if (data === null) return <p className="muted">Loading…</p>;
  return (
    <>
      <p className="notice">{data.note}</p>
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Agent</th><th scope="col">Role</th><th scope="col">Runs</th>
            <th scope="col">Input tokens</th><th scope="col">Output tokens</th><th scope="col">Cost</th>
          </tr>
        </thead>
        <tbody>
          {data.costs.map((row, index) => (
            <tr key={index}>
              <th scope="row">{String(row['name'])}</th>
              <td>{String(row['template_id'])}</td>
              <td>{String(row['runs'])}</td>
              <td>{String(row['input_tokens'] ?? 0)}</td>
              <td>{String(row['output_tokens'] ?? 0)}</td>
              <td>
                {Number(row['cost_usd'] ?? 0) === 0
                  ? <span className="muted">not reported by provider</span>
                  : `${Number(row['cost_usd']).toFixed(4)} USD`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
