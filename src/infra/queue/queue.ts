/**
 * Cloud-agnostic message queue port. Locally backed by BullMQ (./bullmq.ts); in the
 * cloud this maps to SQS / Azure Storage Queues / Pub/Sub. Delivery is assumed to
 * be AT-LEAST-ONCE, so every consumer must be idempotent.
 */

export interface IngestDispatchMessage {
  jobId: string;
}
export interface IngestChunkMessage {
  jobId: string;
  chunkIndex: number;
}
export interface PriceRecomputeMessage {
  categoryId: string;
  reason: string;
}
export type PriceSweepMessage = Record<string, never>;

export interface QueueMessages {
  'ingest-dispatch': IngestDispatchMessage;
  'ingest-chunk': IngestChunkMessage;
  'price-recompute': PriceRecomputeMessage;
  'price-sweep': PriceSweepMessage;
}

export type QueueName = keyof QueueMessages;

export interface SendOptions {
  /** Deliver no earlier than this many ms from now (scheduled promotion start/end). */
  delayMs?: number;
  /** Collapses duplicate sends while a message with the same key is still pending. */
  dedupeKey?: string;
}

export interface MessageQueue {
  send<Q extends QueueName>(queue: Q, payload: QueueMessages[Q], opts?: SendOptions): Promise<void>;
  close(): Promise<void>;
}

/** Records messages instead of delivering them. Used by tests to drive functions by hand. */
export class InMemoryQueue implements MessageQueue {
  readonly sent: { queue: QueueName; payload: unknown; opts?: SendOptions }[] = [];
  /** Simulates a broker outage. */
  failSends = false;

  async send<Q extends QueueName>(queue: Q, payload: QueueMessages[Q], opts?: SendOptions): Promise<void> {
    if (this.failSends) throw new Error('queue unavailable');
    this.sent.push({ queue, payload, opts });
  }

  take<Q extends QueueName>(queue: Q): QueueMessages[Q][] {
    const out: QueueMessages[Q][] = [];
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if (this.sent[i]!.queue === queue) out.unshift(this.sent.splice(i, 1)[0]!.payload as QueueMessages[Q]);
    }
    return out;
  }

  async close(): Promise<void> {}
}
