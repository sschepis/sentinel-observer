import { tokenizeText } from './context';

/**
 * MDL COST MODEL — the philosophy becomes the criterion.
 *
 * An operator earns its place when adopting it compresses the memory bank:
 * the bits saved by explaining stored instances must exceed the bits needed
 * to encode the operator itself. Token costs follow a Zipf-style prior over
 * the deck's frequency order — common words are cheap, rare words are
 * expensive — so a single demonstration of an expensive response can justify
 * an operator, while cheap common-word responses need more evidence. That is
 * the principled replacement for the fixed "two demonstrations" gate.
 */

const UNKNOWN_TOKEN_COST = 20;

/** Zipf-style bit cost per token, derived from deck frequency order. */
export class TokenCostModel {
  private readonly costs = new Map<string, number>();

  constructor(words: readonly string[], private readonly unknownCost = UNKNOWN_TOKEN_COST) {
    const n = words.length;
    if (n === 0) return;
    const weights = words.map((_, i) => 1 / (i + 1));
    const total = weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < n; i += 1) {
      this.costs.set(words[i], -Math.log2(weights[i] / total));
    }
  }

  costOf(token: string): number {
    return this.costs.get(token) ?? this.unknownCost;
  }

  costOfText(text: string): number {
    return tokenizeText(text).reduce((sum, token) => sum + this.costOf(token), 0);
  }
}