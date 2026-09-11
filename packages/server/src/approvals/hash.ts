import { createHash } from 'node:crypto';
import type { ApprovalPayload } from '@sqhq/shared';

/**
 * Canonical JSON: object keys sorted recursively, no incidental whitespace.
 * Two payloads that differ only in key order hash identically; two that differ
 * in any value do not. This is what makes an approval bind to content rather
 * than to a category of action.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortValue(v)]));
  }
  return value;
}

export function hashApprovalPayload(payload: ApprovalPayload): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

/** Hash of a tool request, used as the idempotency fingerprint. */
export function hashToolRequest(toolName: string, args: unknown): string {
  return createHash('sha256')
    .update(canonicalJson({ toolName, args }), 'utf8')
    .digest('hex');
}
