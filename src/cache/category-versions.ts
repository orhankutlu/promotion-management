import type Redis from 'ioredis';
import { logger } from '../infra/logger';

/**
 * Versioned cache namespaces. Every cached listing key embeds the version of its
 * category (or the global version for unfiltered listings), and every cached
 * product-detail entry is stamped with its category's version. Bumping one integer
 * therefore invalidates every cached view of a 50k-product category in O(1); old
 * entries are never deleted, they just stop being addressed and expire via TTL.
 *
 * Rule: bump AFTER the price change has committed, never before — otherwise a
 * reader can repopulate the new version with pre-change data.
 *
 * Versions are seeded from the wall clock and bumped monotonically (Lua), so a
 * version key lost to eviction/restart never resurrects an old number that could
 * still address stale entries.
 */

export const GLOBAL_SCOPE = '*';
const key = (scope: string) => `catver:${scope}`;

const BUMP_LUA = `
local v = redis.call('INCR', KEYS[1])
local floor = tonumber(ARGV[1])
if v < floor then
  redis.call('SET', KEYS[1], floor)
  v = floor
end
return v`;

export class CategoryVersions {
  constructor(private readonly redis: Redis) {}

  /** Returns versions in the same order as `scopes`; missing keys are seeded. */
  async get(scopes: string[]): Promise<number[]> {
    try {
      const raw = await this.redis.mget(scopes.map(key));
      return await Promise.all(
        raw.map(async (v, i) => {
          if (v !== null) return Number(v);
          const seed = Date.now();
          await this.redis.set(key(scopes[i]!), seed, 'NX');
          return Number(await this.redis.get(key(scopes[i]!)));
        }),
      );
    } catch (err) {
      logger.warn({ err }, 'version read failed');
      return scopes.map(() => -1); // -1 never matches a stamped entry => forced miss
    }
  }

  async bump(categoryIds: Iterable<string>): Promise<void> {
    const scopes = [...new Set(categoryIds), GLOBAL_SCOPE];
    try {
      const pipeline = this.redis.pipeline();
      for (const s of scopes) pipeline.eval(BUMP_LUA, 1, key(s), Date.now());
      await pipeline.exec();
    } catch (err) {
      // Entries still expire on their TTL, bounding staleness even if this fails.
      logger.error({ err, scopes }, 'version bump failed');
    }
  }
}
