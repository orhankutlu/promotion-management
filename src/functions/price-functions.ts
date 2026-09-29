import { PriceRecomputeMessage } from '../infra/queue/queue';
import { FunctionContext, FunctionDeps } from './runtime';

/** Queue-triggered: recompute every price in a category (flash sale created/started/ended/cancelled). */
export async function recomputeCategoryFunction(
  event: PriceRecomputeMessage,
  deps: FunctionDeps,
  _ctx: FunctionContext,
) {
  return deps.pricing.recomputeCategory(event.categoryId);
}

const RECONCILE_GRACE_MS = 30_000;

/** Timer-triggered (every minute): reconcile any price whose validity window passed,
 * and re-drive promotions whose recompute message was lost. */
export async function priceSweepFunction(_event: unknown, deps: FunctionDeps, ctx: FunctionContext) {
  const changed = await deps.pricing.sweepStale(ctx.deadline - deps.config.FUNCTION_SAFETY_MARGIN_MS);
  const reconciled = await deps.pricing.reconcileUnsynced(RECONCILE_GRACE_MS);
  return { changed, reconciled };
}
