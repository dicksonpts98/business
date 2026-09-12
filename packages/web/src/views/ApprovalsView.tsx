import { useState } from 'react';
import { type ApprovalRow, api } from '../api/client.js';

export interface ApprovalsViewProps {
  readonly approvals: readonly ApprovalRow[];
  readonly onAction: (label: string, run: () => Promise<unknown>) => void;
}

function formatAmount(payload: Record<string, unknown>): string {
  const minor = payload['amountMinor'];
  const currency = payload['currency'];
  if (typeof minor !== 'number' || typeof currency !== 'string') return '—';
  return `${(minor / 100).toFixed(2)} ${currency}`;
}

/**
 * Owner approvals.
 *
 * Two things are deliberately prominent: the EXACT content being authorised,
 * and the payload hash. Granting sends that hash back to the server, which
 * refuses the decision if the stored content has changed since it was rendered.
 * Amending the content invalidates the approval and creates a fresh pending one.
 */
export function ApprovalsView({
  approvals, onAction,
}: ApprovalsViewProps): React.JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const pending = approvals.filter((a) => a.state === 'pending');
  const visible = showAll ? approvals : pending;

  return (
    <div className="view view-approvals">
      <div className="view-toolbar">
        <h2>Owner approvals</h2>
        <label className="check">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          Show decided and invalidated
        </label>
        <span className="muted">{pending.length} pending</span>
      </div>

      <p className="notice">
        No supplier message, listing, campaign, order, refund, payment, contract
        or filing happens without a specific approval below. Approval is bound to
        the exact content shown: editing any field invalidates it, and the backend
        enforces that at the moment of execution, not merely in this screen.
      </p>

      {visible.length === 0 && <p className="muted">Nothing awaiting a decision.</p>}

      {visible.map((approval) => (
        <ApprovalCard key={approval.id} approval={approval} onAction={onAction} />
      ))}
    </div>
  );
}

function ApprovalCard({
  approval, onAction,
}: { approval: ApprovalRow; onAction: ApprovalsViewProps['onAction'] }): React.JSX.Element {
  const [note, setNote] = useState('');
  const [amending, setAmending] = useState(false);
  const [draft, setDraft] = useState(() => JSON.stringify(approval.payload, null, 2));
  const expired = new Date(approval.expires_at).getTime() <= Date.now();
  const decidable = approval.state === 'pending' && !expired;

  return (
    <article className={`approval approval-${approval.state}`}>
      <header>
        <div>
          <code className="tool">{approval.tool_name}</code>
          <span className={`pill pill-${approval.state}`}>{approval.state}</span>
          {expired && approval.state === 'pending' && <span className="pill pill-failed">expired</span>}
        </div>
        <span className="muted">
          {approval.project_name ?? 'no project'}
          {approval.task_title === null ? '' : ` · ${approval.task_title}`}
        </span>
      </header>

      <dl className="approval-facts">
        <div><dt>Action</dt><dd>{String(approval.payload['action'] ?? '—')}</dd></div>
        <div><dt>Destination</dt><dd>{String(approval.payload['destination'] ?? '—')}</dd></div>
        <div><dt>Amount</dt><dd>{formatAmount(approval.payload)}</dd></div>
        <div><dt>Quantity</dt><dd>{String(approval.payload['quantity'] ?? '—')}</dd></div>
        <div><dt>Product</dt><dd>{String(approval.payload['productRef'] ?? '—')}</dd></div>
        <div><dt>Supplier</dt><dd>{String(approval.payload['supplierRef'] ?? '—')}</dd></div>
        <div><dt>Expires</dt><dd>{new Date(approval.expires_at).toLocaleString()}</dd></div>
        <div>
          <dt>Content hash</dt>
          <dd title="The approval is bound to this hash. Editing the content changes it and withdraws consent.">
            <code>{approval.payload_hash.slice(0, 24)}…</code>
          </dd>
        </div>
      </dl>

      {approval.payload['content'] !== null && approval.payload['content'] !== undefined && (
        <blockquote className="approval-content">{String(approval.payload['content'])}</blockquote>
      )}

      {approval.invalidated_reason !== null && (
        <p className="inspector-blocker">{approval.invalidated_reason}</p>
      )}
      {approval.decision_note !== null && (
        <p className="muted">Note: {approval.decision_note}</p>
      )}

      {decidable && (
        <>
          <label className="approval-note">
            <span>Decision note (optional, recorded in the audit trail)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="approval-actions">
            <button
              type="button"
              className="primary"
              onClick={() => onAction(`Grant ${approval.tool_name}`,
                () => api.decideApproval(approval.id, 'granted', approval.payload_hash, note || undefined))}
            >
              Grant this exact action
            </button>
            <button
              type="button"
              onClick={() => onAction(`Reject ${approval.tool_name}`,
                () => api.decideApproval(approval.id, 'rejected', approval.payload_hash, note || undefined))}
            >
              Reject
            </button>
            <button type="button" onClick={() => setAmending((v) => !v)}>
              {amending ? 'Cancel amendment' : 'Amend content'}
            </button>
          </div>
        </>
      )}

      {amending && (
        <form
          className="approval-amend"
          onSubmit={(e) => {
            e.preventDefault();
            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(draft) as Record<string, unknown>;
            } catch {
              onAction('Amend approval', async () => { throw new Error('The amended payload is not valid JSON.'); });
              return;
            }
            setAmending(false);
            onAction('Amend approval', () => api.amendApproval(approval.id, parsed));
          }}
        >
          <p className="notice notice-warn">
            Amending invalidates this approval and opens a new pending one. That is
            the point: consent to the previous content does not carry over.
          </p>
          <label>
            <span className="sr-only">Amended payload</span>
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={12} spellCheck={false} />
          </label>
          <button type="submit" className="danger">Invalidate and replace</button>
        </form>
      )}
    </article>
  );
}
