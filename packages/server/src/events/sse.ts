import type { FastifyReply, FastifyRequest } from 'fastify';
import { getPool } from '../db/pool.js';
import { readEventsAfter } from './append.js';

/**
 * Server-sent events with resume.
 *
 * The client reconnects with Last-Event-ID (set automatically by EventSource)
 * or an explicit ?afterSeq=. The server replays everything after that sequence
 * from the durable log, then continues polling. Because the log is the source
 * of truth and `seq` is gap-free, a refresh, a network drop and a server
 * restart all recover to exactly the same state.
 *
 * Polling rather than LISTEN/NOTIFY is a deliberate simplification: the poll
 * reads the same table the client would rebuild from, so there is no second
 * delivery path that could disagree with the log. Exactly-once delivery is not
 * promised; clients deduplicate by event id.
 */
export async function streamEvents(
  request: FastifyRequest<{ Querystring: { workspaceId?: string; afterSeq?: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const workspaceId = request.query.workspaceId;
  if (workspaceId === undefined) {
    await reply.code(400).send({ error: 'workspaceId is required' });
    return;
  }

  const lastEventIdHeader = request.headers['last-event-id'];
  const fromHeader = typeof lastEventIdHeader === 'string' ? Number(lastEventIdHeader) : Number.NaN;
  const fromQuery = request.query.afterSeq === undefined ? Number.NaN : Number(request.query.afterSeq);
  let cursor = Number.isFinite(fromHeader) ? fromHeader
    : Number.isFinite(fromQuery) ? fromQuery
    : 0;

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let closed = false;
  const onClose = (): void => { closed = true; };
  request.raw.on('close', onClose);

  // Tell the client where the replay begins so it can reconcile its own buffer.
  reply.raw.write(`event: stream.opened\ndata: ${JSON.stringify({ fromSeq: cursor })}\n\n`);

  const pool = getPool();
  const POLL_MS = 600;
  const KEEPALIVE_MS = 15_000;
  let lastKeepAlive = Date.now();

  while (!closed) {
    let wrote = false;
    try {
      const events = await readEventsAfter(pool, workspaceId, cursor, 200);
      for (const event of events) {
        if (closed) break;
        // `id:` is the resume token the browser echoes back as Last-Event-ID.
        reply.raw.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        cursor = event.seq;
        wrote = true;
      }
    } catch (error) {
      reply.raw.write(`event: stream.error\ndata: ${JSON.stringify({
        message: error instanceof Error ? error.message : 'unknown read error',
        resumeFromSeq: cursor,
      })}\n\n`);
      break;
    }

    if (!wrote && Date.now() - lastKeepAlive > KEEPALIVE_MS) {
      reply.raw.write(`: keepalive\n\n`);
      lastKeepAlive = Date.now();
    }
    if (wrote) lastKeepAlive = Date.now();

    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  request.raw.off('close', onClose);
  reply.raw.end();
}
