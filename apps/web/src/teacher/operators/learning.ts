import { isContentWord, tokenizeText } from '../context';
import type { TokenCostModel } from '../mdl';
import { inheritsEdge, edgeObjects } from '../chain';
import type { Relation } from '../relations';

/**
 * OPERATOR DISCOVERY + LEARNING — MDL INDUCTION.
 *
 * The built-in operators (definition, yes/no, count, clock, ...) are fixed.
 * This learner grows the set from the observer's own experience: every time
 * a STRONG answer (LLM-graded >= 0.7) follows an utterance the observer
 * could not previously answer, the pair is examined for a learnable pattern.
 *
 * What is learnable — and what is NOT:
 *   A pattern is learned only when the answer is an ECHO SHELL around a word
 *   from the utterance: "do you like tea" -> "Yes, I like tea." generalizes
 *   to "Yes, I like {slot}." because every content word in the answer is
 *   either the echoed slot or a function word. An answer carrying example-
 *   specific knowledge ("Tea is a warm drink.") is REJECTED — generalizing
 *   it to other slots would fabricate. Honesty is the learning constraint.
 *
 *   RELATION HOLES (P6) extend the shell: a content word beyond the slot is
 *   allowed iff it is DERIVABLE from the slot via a stored typed edge —
 *   "a robin is a bird" learns "{slot} is a {p:is-a}", where the hole is
 *   resolved from the relation graph at FIRE time (an edge that vanished
 *   since learning declines the operator). Still fabrication-proof: every
 *   content word is grounded, but the shell is vastly more expressive than
 *   pure echo.
 *
 * When an operator earns its place — the MINIMUM DESCRIPTION LENGTH
 * criterion: an operator is promoted (mature, fireable) exactly when
 * adopting it compresses the memory bank. The bits saved by explaining the
 * stored instances (their responses' token costs under a Zipf-frequency
 * prior over the deck) must exceed the bits needed to encode the shell
 * itself plus its slot annotation. Expensive answers — those built from
 * rare words — justify an operator after a SINGLE demonstration; cheap
 * common-word answers need more evidence. With a uniform token cost the
 * old rule re-emerges exactly: one demonstration is an anecdote, two is a
 * pattern. No more magic constants — the criterion IS the philosophy.
 */

export interface LearnedEvidence {
  utterance: string;
  answer: string;
  score: number;
  /** The echo shell this instance demonstrated ('' when unmatched). */
  template: string;
}

export interface LearnedPattern {
  id: string;
  /** The fixed words before the slot, e.g. ['do','you','like']. */
  lead: string[];
  /** Answer templates seen, keyed by template -> demonstration count. */
  templates: Map<string, number>;
  evidence: LearnedEvidence[];
  /** Distinct demonstrated (utterance, answer) keys — replay guard. */
  seenKeys: Set<string>;
  /** Running bit-cost savings per template (maintained at learn time). */
  savings: Map<string, number>;
}

export interface LearnedOperatorResult {
  kind: 'learned';
  patternId: string;
  slot: string;
  answer: string;
}

export interface LearnedOperatorAudit {
  id: string;
  lead: string;
  evidence: number;
  templates: Array<{ template: string; demonstrations: number; gain: number; mature: boolean }>;
}

/** Bits needed to annotate the slot (its type: "a word echoed from speech"). */
export const SLOT_COST = 15;

/** Uniform token cost when no frequency model is supplied (10 bits/token). */
export const DEFAULT_TOKEN_COST = 10;

// ── P6 RELATION HOLES ───────────────────────────────────────────────────────
// A hole marker {p:<predicate>[:<index>]} names a content word derivable from
// the slot via a stored edge; the graph fills it at fire time.

/** Matches {p:is-a} and {p:has-part:1} hole markers. */
const HOLE_RE = /\{p:([a-z-]+)(?::(\d+))?\}/g;

/** The predicates a hole may resolve through (the answerable edge kinds). */
const HOLE_PREDICATES = [
  'is-a',
  'has-part',
  'capable-of',
  'has-property',
  'used-for',
  'made-of',
  'requires',
  'causes',
  'located-in',
  'opposite-of'
] as const;

/** The predicate under which `word` is derivable from `slot`, or null.
 *  Direct edges count (inheritsEdge returns null for those by convention). */
function findHolePredicate(relations: readonly Relation[], slot: string, word: string): string | null {
  for (const predicate of HOLE_PREDICATES) {
    const direct = relations.some(
      (r) => r.subject === slot && r.predicate === predicate && r.object === word
    );
    if (direct || inheritsEdge(relations, slot, predicate, word) !== null) return predicate;
  }
  return null;
}

/**
 * Fill a template's relation holes against the graph. Null when any hole
 * cannot be filled (the edge vanished, or a repeated hole ran past the
 * object list) — the operator declines rather than echo a stale object.
 */
function resolveHoles(template: string, slot: string, relations: () => readonly Relation[]): string | null {
  const objects = relations();
  const resolved = template.replace(HOLE_RE, (marker, predicate: string, index?: string) => {
    const candidates = edgeObjects(objects, slot, predicate);
    const i = index === undefined ? 0 : Number(index);
    if (i >= candidates.length) return marker; // unresolved — decline below
    return candidates[i];
  });
  return HOLE_RE.test(resolved) ? null : resolved;
}

function escapeRegex(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class OperatorLearner {
  private readonly patterns = new Map<string, LearnedPattern>();

  /**
   * @param cost  Frequency-prior bit-cost model over the deck. When omitted,
   *              tokens cost a uniform DEFAULT_TOKEN_COST bits — under which
   *              the classic "two demonstrations" rule falls out exactly.
   */
  constructor(
    private readonly cost: TokenCostModel | null = null,
    private readonly relations?: () => readonly Relation[]
  ) {}

  private tokenCost(token: string): number {
    return this.cost !== null ? this.cost.costOf(token) : DEFAULT_TOKEN_COST;
  }

  /** Bit cost of an answer's tokens (the bits adopting the operator saves). */
  private costOfAnswer(answer: string): number {
    return tokenizeText(answer).reduce((sum, token) => sum + this.tokenCost(token), 0);
  }

  /** Bit cost of the shell itself: its fixed tokens plus the slot annotation
   *  and one annotation per relation hole (P6). */
  private costOfTemplate(template: string): number {
    const fixed = template.replace(/\{slot\}/g, '').replace(HOLE_RE, '');
    const tokens = tokenizeText(fixed).reduce((sum, token) => sum + this.tokenCost(token), 0);
    const holes = (template.match(HOLE_RE) ?? []).length;
    return tokens + SLOT_COST * (1 + holes);
  }

  /**
   * Examine an (utterance, answer) pair for a learnable echo pattern.
   * Returns the pattern id when a new demonstration was recorded.
   */
  learn(utterance: string, answer: string, score: number): string | null {
    const ut = tokenizeText(utterance);
    const answerTokens = tokenizeText(answer);
    if (ut.length === 0 || answerTokens.length === 0) return null;

    // The slot: the LAST content word of the utterance that also appears in
    // the answer (echo evidence). Lead = everything before it.
    const answerSet = new Set(answerTokens);
    let slotIndex = -1;
    for (let i = ut.length - 1; i >= 0; i -= 1) {
      if (isContentWord(ut[i]) && answerSet.has(ut[i])) {
        slotIndex = i;
        break;
      }
    }
    if (slotIndex === -1) return null;
    const slot = ut[slotIndex];
    const lead = ut.slice(0, slotIndex);
    if (lead.length === 0) return null;

    // HONESTY GUARD (extended, P6): every content word in the answer must be
    // the echoed slot, a function word, or DERIVABLE from the slot via a
    // stored typed edge (a relation hole). Example-specific knowledge that
    // the graph cannot back ("Tea is a warm drink.") is still rejected —
    // the guard is what makes the learner incapable of fabrication.
    const holeWords: Array<{ word: string; predicate: string }> = [];
    if (this.relations !== undefined) {
      const relations = this.relations();
      for (const word of answerTokens) {
        if (word === slot) continue;
        if (!isContentWord(word)) continue;
        const predicate = findHolePredicate(relations, slot, word);
        if (predicate === null) return null;
        holeWords.push({ word, predicate });
      }
    } else {
      for (const word of answerTokens) {
        if (word === slot) continue;
        if (isContentWord(word)) return null;
      }
    }

    // The answer as a shell: replace the slot with the {slot} marker and each
    // derivable hole word with its predicate marker ({p:is-a}, {p:is-a:1}
    // for DISTINCT derivations). The `g` flag matters — a slot word repeated
    // in the answer must ALL become slots, or the leftover literal would be
    // echoed to unrelated slots on fire (fabrication). Hole markers are
    // assigned PER DISTINCT WORD: a word repeated in the answer ("bird"
    // twice) keeps ONE marker, so both occurrences resolve to the same
    // graph object — the old per-entry counter stamped every occurrence
    // with a fresh index and the later markers ran past the object list.
    let template = answer.replace(new RegExp(`\\b${escapeRegex(slot)}\\b`, 'gi'), '{slot}');
    const kindCounts = new Map<string, number>();
    const markerByHoleWord = new Map<string, string>();
    for (const hole of holeWords) {
      let marker = markerByHoleWord.get(hole.word);
      if (marker === undefined) {
        const count = kindCounts.get(hole.predicate) ?? 0;
        kindCounts.set(hole.predicate, count + 1);
        marker = count === 0 ? `{p:${hole.predicate}}` : `{p:${hole.predicate}:${count}}`;
        markerByHoleWord.set(hole.word, marker);
      }
      template = template.replace(new RegExp(`\\b${escapeRegex(hole.word)}\\b`, 'gi'), marker);
    }
    if (!template.includes('{slot}') || template === '{slot}') return null;

    const id = lead.join(' ');
    let pattern = this.patterns.get(id);
    if (pattern === undefined) {
      pattern = { id, lead, templates: new Map(), evidence: [], seenKeys: new Set(), savings: new Map() };
      this.patterns.set(id, pattern);
    }
    // REPLAY GUARD: the same (utterance, answer) demonstrated twice — a
    // re-grade, a persistence restore replaying its own creative traces —
    // is ONE demonstration. Counting it twice would double the MDL savings
    // and promote operators that never had real evidence.
    const key = `${tokenizeText(utterance).join(' ')}|${answer.trim().toLowerCase()}`;
    if (pattern.seenKeys.has(key)) return null;
    pattern.seenKeys.add(key);
    pattern.templates.set(template, (pattern.templates.get(template) ?? 0) + 1);
    pattern.savings.set(template, (pattern.savings.get(template) ?? 0) + this.costOfAnswer(answer));
    pattern.evidence.push({ utterance, answer, score, template });
    return id;
  }

  /**
   * MDL gain of a template: the bits its demonstrations saved, minus the
   * bits the operator itself costs to encode. Positive gain = the operator
   * compresses memory = it may fire. Savings are maintained incrementally
   * at learn time (distinct demonstrations only), so this is O(1).
   */
  gainOf(pattern: LearnedPattern, template: string): number {
    const savings = pattern.savings.get(template) ?? 0;
    return savings - this.costOfTemplate(template);
  }

  /** The highest-gain mature template of a pattern (null when none). */
  private bestMatureTemplate(pattern: LearnedPattern): string | null {
    let best: string | null = null;
    let bestGain = 0;
    for (const template of pattern.templates.keys()) {
      const gain = this.gainOf(pattern, template);
      if (gain > 0 && gain > bestGain) {
        best = template;
        bestGain = gain;
      }
    }
    return best;
  }

  /**
   * Try a learned pattern against a NEW utterance: the lead must match the
   * utterance's start, the next word is the slot, and the shell must have
   * cleared the MDL bar (positive gain — adopting it compresses memory).
   * Echoes the heard word into the validated shell — nothing more.
   */
  apply(utterance: string): LearnedOperatorResult | null {
    const ut = tokenizeText(utterance);
    for (const pattern of this.patterns.values()) {
      if (ut.length <= pattern.lead.length) continue;
      const leadMatches = pattern.lead.every((word, i) => ut[i] === word);
      if (!leadMatches) continue;
      const slot = ut[pattern.lead.length];
      if (!isContentWord(slot)) continue;

      const template = this.bestMatureTemplate(pattern);
      if (template === null) continue;

      // P6: relation holes are filled at FIRE time from the graph. An edge
      // that vanished since learning declines the operator — grounding is a
      // fire-time invariant, never a learn-time promise.
      const resolved = this.relations !== undefined ? resolveHoles(template, slot, this.relations) : template;
      if (resolved === null) continue;
      const answer = resolved.replace(/\{slot\}/g, slot);
      if (answer === template) continue;
      return { kind: 'learned', patternId: pattern.id, slot, answer };
    }
    return null;
  }

  /** Number of patterns that have cleared the MDL bar (may fire). */
  fireableCount(): number {
    let count = 0;
    for (const pattern of this.patterns.values()) {
      if (this.bestMatureTemplate(pattern) !== null) count += 1;
    }
    return count;
  }

  /** The learned templates for a lead (test/introspection view). */
  templatesOf(lead: string): string[] {
    return [...(this.patterns.get(lead)?.templates.keys() ?? [])];
  }

  /** Full audit view: per-template gains and maturity — for the bench/UI. */
  audit(): LearnedOperatorAudit[] {
    const audits: LearnedOperatorAudit[] = [];
    for (const pattern of this.patterns.values()) {
      audits.push({
        id: pattern.id,
        lead: pattern.lead.join(' '),
        evidence: pattern.evidence.length,
        templates: [...pattern.templates.entries()].map(([template, demonstrations]) => {
          const gain = this.gainOf(pattern, template);
          return {
            template,
            demonstrations,
            gain: Number(gain.toFixed(2)),
            mature: gain > 0
          };
        })
      });
    }
    return audits;
  }
}
