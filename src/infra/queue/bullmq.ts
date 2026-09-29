import { Queue } from 'bullmq';
import { MessageQueue, QueueMessages, QueueName, SendOptions } from './queue';

export const QUEUE_NAMES: QueueName[] = ['ingest-dispatch', 'ingest-chunk', 'price-recompute', 'price-sweep'];

export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: true,
  removeOnFail: 1000,
} as const;

export class BullMqQueue implements MessageQueue {
  private readonly queues = new Map<QueueName, Queue>();

  constructor(private readonly redisUrl: string) {}

  private queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: { url: this.redisUrl }, defaultJobOptions: DEFAULT_JOB_OPTIONS });
      this.queues.set(name, q);
    }
    return q;
  }

  async send<Q extends QueueName>(name: Q, payload: QueueMessages[Q], opts: SendOptions = {}): Promise<void> {
    await this.queue(name).add(name, payload, {
      delay: opts.delayMs && opts.delayMs > 0 ? opts.delayMs : undefined,
      // BullMQ ignores an add whose jobId already exists (pending or retained).
      jobId: opts.dedupeKey?.replace(/:/g, '_'),
    });
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}
