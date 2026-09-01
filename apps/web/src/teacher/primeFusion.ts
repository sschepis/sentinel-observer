export interface FusionRoute {
  inputs: readonly [number, number, number];
  target: number;
  twist: number;
  closureDelta: number;
}

export const FUSION_SEEDS = [3, 5, 7, 11, 13, 17] as const;

function routeOf(inputs: readonly [number, number, number], target: number): FusionRoute {
  const twist = inputs.reduce((sum, prime) => sum + 360 / prime, 0);
  const nearestClosure = Math.round(twist / 108) * 108;
  return { inputs, target, twist, closureDelta: Math.abs(twist - nearestClosure) };
}

/** All distinct odd-prime triads from `available` that sum to `target`. */
export function fusionRoutes(target: number, available: readonly number[]): FusionRoute[] {
  const primes = [...new Set(available)]
    .filter((prime) => prime > 2 && prime < target)
    .sort((a, b) => a - b);
  const routes: FusionRoute[] = [];
  for (let first = 0; first < primes.length - 2; first += 1) {
    for (let second = first + 1; second < primes.length - 1; second += 1) {
      const thirdPrime = target - primes[first] - primes[second];
      if (thirdPrime <= primes[second]) continue;
      if (primes.includes(thirdPrime)) {
        routes.push(routeOf([primes[first], primes[second], thirdPrime], target));
      }
    }
  }
  return routes;
}

/** Lowest 108° closure delta, with lexicographic route tie-breaking. */
export function canonicalFusionRoute(routes: readonly FusionRoute[]): FusionRoute | null {
  return [...routes].sort((a, b) => {
    if (a.closureDelta !== b.closureDelta) return a.closureDelta - b.closureDelta;
    for (let i = 0; i < 3; i += 1) {
      if (a.inputs[i] !== b.inputs[i]) return a.inputs[i] - b.inputs[i];
    }
    return 0;
  })[0] ?? null;
}

/**
 * Recursively close a seed basis under valid triadic sums, restricted to the
 * observer's prime space. Returns each generated prime's canonical route.
 */
export function generateFusionClosure(
  primeSpace: readonly number[],
  seeds: readonly number[] = FUSION_SEEDS
): Map<number, FusionRoute> {
  const allowed = [...new Set(primeSpace)].sort((a, b) => a - b);
  const available = new Set(seeds.filter((prime) => allowed.includes(prime)));
  const generated = new Map<number, FusionRoute>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const target of allowed) {
      if (available.has(target)) continue;
      const canonical = canonicalFusionRoute(fusionRoutes(target, [...available]));
      if (canonical === null) continue;
      available.add(target);
      generated.set(target, canonical);
      changed = true;
    }
  }
  return generated;
}