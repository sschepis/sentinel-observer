export interface TwistClosure {
  totalDegrees: number;
  distanceDegrees: number;
  score: number;
  primeCount: number;
}

/** Closeness to the nearest full 360-degree turn, normalized to [0, 1]. */
export function twistClosure(
  tokens: readonly string[],
  vocabulary: Readonly<Record<string, readonly number[]>>
): TwistClosure {
  const primes = tokens.flatMap((token) => vocabulary[token.toLowerCase()] ?? []);
  if (primes.length === 0) {
    return { totalDegrees: 0, distanceDegrees: 180, score: 0, primeCount: 0 };
  }
  const totalDegrees = primes.reduce((sum, prime) => sum + 360 / prime, 0);
  const remainder = ((totalDegrees % 360) + 360) % 360;
  const distanceDegrees = Math.min(remainder, 360 - remainder);
  return {
    totalDegrees,
    distanceDegrees,
    score: 1 - distanceDegrees / 180,
    primeCount: primes.length
  };
}