import type Redis from 'ioredis';
import { logger } from '../infra/logger';

/**
 * Cache-aside helper with three properties that matter during a flash sale:
 *
 *  1. Fail-open: if Redis is down, reads go to Postgres instead of erroring.
 *  2. Single-flight: concurrent misses for the same key in this process share one
 *     loader call. When a category version is bumped, every cached page for it
 *     misses at once — without coalescing, all in-flight storefront traffic would
 *     hit Postgres simultaneously (cache stampede).
 *  3. TTL jitter so entries written together don't all expire together.
 */
export class Cache {
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly redis: Redis) {}

  async getJson<T>(key: string): Promise<T | undefined> {
    try {
      const raw = await this.redis.get(key);
      return raw === null ? undefined : (JSON.parse(raw) as T);
    } catch (err) {
      logger.warn({ err, key }, 'cache read failed; falling back to source');
      return undefined;
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const jittered = Math.max(1, Math.round(ttlSeconds * (0.9 + Math.random() * 0.2)));
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', jittered);
    } catch (err) {
      logger.warn({ err, key }, 'cache write failed');
    }
  }

  /** Coalesces concurrent calls with the same key into a single execution. */
  singleFlight<T>(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;
    const p = load().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  async getOrLoad<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
    const hit = await this.getJson<T>(key);
    if (hit !== undefined) return hit;
    return this.singleFlight(key, async () => {
      const value = await load();
      await this.setJson(key, value, ttlSeconds);
      return value;
    });
  }
}
