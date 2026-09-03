/**
 * RULE MAINTENANCE (R16) — shared decay policy and the rule → drill family
 * mapping the consolidation pass re-inducts over.
 */
import { STABILITY_PRESETS } from '../retention';

/** How long a learned rule may go unused before its world credit decays
 *  (weaken-toward-hedged, never forget). L3 (19.4): expressed as the
 *  rule-corroboration stability preset of the one retention law — the
 *  mechanism stays the discrete R16 withdrawal, the HORIZON is the law's. */
export const RULE_CORROBORATION_HORIZON_MS = STABILITY_PRESETS.ruleCorroborationDays * 24 * 60 * 60 * 1000;

/** The drill a learned rule family re-inducts over during consolidation. */
export function drillForRuleName(name: string): string | null {
  if (name === 'nat.gcd') return 'gcf';
  if (name === 'dig.placeVal') return 'place-value';
  if (name === 'nat.sqrt') return 'square-root';
  if (name.startsWith('conv.')) return name.slice('conv.'.length);
  return null;
}
