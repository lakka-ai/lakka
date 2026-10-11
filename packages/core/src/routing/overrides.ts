import { blendedPrice } from '@lakka/contracts';
import type {
  ModelPrices,
  Principal,
  RouteOverrideSummary,
  RoutingOverridesView,
} from '@lakka/contracts';
import { listOverrideCounts, listRoutes, summarizeRoutedUsage } from '@lakka/db';
import type { OverrideCount, RoutedUsage } from '@lakka/db';
import { findModelPrices } from '../models/service.ts';
import { authorizeWorkspaceAction } from '../workspaces/service.ts';
import type { RoutingContext } from './policy-service.ts';

/*
 * Overrides per route, as a suggested policy change with its cost (RT-10, E11, ADR 0048). For
 * each route users overrode: how often, which way (to a pricier or a cheaper model), the model
 * they chose most, and what the route's own kept requests would have cost on that model. The
 * estimate prices the same tokens at the other model's base prices; it ignores long-context
 * tiers and any change in how many tokens a different model would use, so it is a guide.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export async function getOverrideSummary(
  ctx: RoutingContext,
  principal: Principal,
  workspaceId: string,
  days: number,
  now: Date = new Date(),
): Promise<RoutingOverridesView> {
  await authorizeWorkspaceAction(ctx, principal, workspaceId, 'policy.read');
  const since = new Date(now.getTime() - days * DAY_MS);
  const [routes, routed, overrides] = await Promise.all([
    listRoutes(ctx.db, workspaceId),
    summarizeRoutedUsage(ctx.db, workspaceId, since),
    listOverrideCounts(ctx.db, workspaceId, since),
  ]);
  const prices = new Map<string, Promise<ModelPrices | undefined>>();
  const priceOf = (model: string) => {
    let price = prices.get(model);
    if (price === undefined) {
      price = findModelPrices(ctx, model);
      prices.set(model, price);
    }
    return price;
  };

  const byRoute = new Map<string, OverrideCount[]>();
  for (const o of overrides) byRoute.set(o.routeId, [...(byRoute.get(o.routeId) ?? []), o]);

  const summaries: RouteOverrideSummary[] = [];
  for (const [routeId, counts] of byRoute) {
    let towardsStronger = 0;
    let towardsCheaper = 0;
    const chosen = new Map<string, number>();
    for (const c of counts) {
      chosen.set(c.model, (chosen.get(c.model) ?? 0) + c.requests);
      const [to, from] = await Promise.all([priceOf(c.model), priceOf(c.overriddenModel)]);
      if (to === undefined || from === undefined) continue;
      if (blendedPrice(to) > blendedPrice(from)) towardsStronger += c.requests;
      else if (blendedPrice(to) < blendedPrice(from)) towardsCheaper += c.requests;
    }
    // Most chosen first; ties go to the name, so the suggestion is stable.
    const [top] = [...chosen].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const kept = routed.find((r) => r.routeId === routeId);
    summaries.push({
      routeId,
      route: routes.find((r) => r.id === routeId)?.name ?? null,
      routedRequests: kept?.requests ?? 0,
      overrides: counts.reduce((n, c) => n + c.requests, 0),
      towardsStronger,
      towardsCheaper,
      suggestion:
        top === undefined
          ? null
          : {
              model: top[0],
              overrides: top[1],
              costEffectMicroUsd: await costEffect(kept, await priceOf(top[0])),
            },
    });
  }
  return {
    days,
    routes: summaries.toSorted((a, b) => b.overrides - a.overrides),
  };
}

/** What the kept requests would have cost at `prices`, minus what they did cost. */
function costEffect(kept: RoutedUsage | undefined, prices: ModelPrices | undefined): string | null {
  if (prices === undefined) return null;
  if (kept === undefined) return '0';
  const input = BigInt(prices.inputMicroUsdPerMtok);
  const perMtok =
    kept.uncachedInputTokens * input +
    kept.cacheReadTokens * BigInt(prices.cacheReadMicroUsdPerMtok ?? prices.inputMicroUsdPerMtok) +
    kept.cacheWriteTokens *
      BigInt(prices.cacheWriteMicroUsdPerMtok ?? prices.inputMicroUsdPerMtok) +
    kept.outputTokens * BigInt(prices.outputMicroUsdPerMtok);
  // Rounded up, as every computed cost is (CLAUDE.md, Code conventions).
  const estimate = (perMtok + 999_999n) / 1_000_000n;
  return String(estimate - kept.costMicroUsd);
}
