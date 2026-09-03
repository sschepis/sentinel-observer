/**
 * RULES FACULTY — the rewrite engine + compiled DSL rules (agent split
 * refactor).
 *
 * Rules are the observer's procedures as memories: authored decks are seeded
 * from code, drills induce new DSL programs, and the rewrite engine
 * (R0-R5) synthesizes rewrite rules that are corroborated, denied, weakened,
 * and stopped — never deleted. State (compiledRules, ruleStore,
 * compositionRules, ruleResolutions, pendingRuleQuestions, rewriteInduction)
 * lives on TeacherAgentCore.
 */
import { TeacherAgentCore, type Constructor, type CrossFacultyApi } from './base';
import {
  type SourceClass
} from '../relations';
import {
  matchArgs,
  evaluate,
  canonicalNumber,
  conversionPairOf
} from '../technical/dsl';
import {
  RuleStore,
  RULE_GRADE_DELTA,
  type DerivationDenial,
  type RewriteRule,
  type RuleOrigin
} from '../rules/types';
import {
  reduce
} from '../rules/engine';
import {
  parseRewritePrompt,
  decodeNormalForm
} from '../rules/parse';
import {
  CompositionRuleStore
} from '../rules/compositionSeeds';
import {
  induceRuleSet,
  validateHeldOut,
  type InductionInstance
} from '../rules/induction';
import {
  termBits,
  termToString
} from '../rules/terms';
import {
  generateExercises,
  chanceLevel
} from '../technical/verify';
import {
  rewriteTargetFor,
  INDUCTION_MARGIN,
  MIN_INDUCTION_HITS
} from '../technical/drill';
import {
  RULE_CORROBORATION_HORIZON_MS,
  drillForRuleName
} from '../rules/maintenance';
import {
  parseTaughtRule,
  validateTaughtRule,
  taughtRuleSpecFor
} from '../rules/instruction';
import {
  type CompiledRule
} from './support';

export function RulesMixin<TBase extends Constructor<TeacherAgentCore & CrossFacultyApi>>(Base: TBase) {
  return class RulesFaculty extends Base {

    // ── Compiled rules (P2 — executable rules from drills) ───────────────────

    /** The induced rules currently compiled into operators. */
    compiledRuleCount(): number {
      return this.compiledRules.length;
    }

    /** The compiled DSL rules (read view — tests and reports). */
    compiledRulesView(): CompiledRule[] {
      return this.compiledRules.map((rule) => ({ ...rule }));
    }

    /**
     * Compile an induced DSL program into a first-class operator. The rule only
     * fires on prompts its own family's matcher fully parses — anything else
     * falls through untouched (the honesty audit).
     */
    registerCompiledRule(rule: Omit<CompiledRule, 'id'>): void {
      const id = `${rule.concept}\u0000${rule.drill}`;
      this.compiledRules = this.compiledRules.filter((existing) => existing.id !== id);
      this.compiledRules.push({ ...rule, id });
    }

    /** Apply the compiled rules to a fresh prompt (chatAnswer step 2.6). */
    protected applyCompiledRule(utterance: string): { kind: 'compiled-rule'; ruleId: string; concept: string; drill: string; answer: string } | null {
      const text = utterance.trim();
      for (const rule of this.compiledRules) {
        // H2: a convert-LENGTH rule is bound to the unit pair it was induced on
        // (length factors vary per pair, so a unit-blind multiplier must never
        // fire on another pair). The time/mass/volume matchers are already
        // unit-specific and their families share one factor across both
        // generator directions — no further check needed. A legacy length rule
        // without its recorded pair never fires (honest decline → ask).
        if (rule.drill === 'convert-length') {
          const pair = conversionPairOf(text);
          if (
            pair === null ||
            rule.conversionFrom === undefined ||
            rule.conversionTo === undefined ||
            pair.from !== rule.conversionFrom ||
            pair.to !== rule.conversionTo
          ) {
            continue;
          }
        }
        const args = matchArgs(rule.drill, text);
        if (args === null) continue;
        const value = evaluate(rule.program, args);
        if (value === undefined) continue;
        const answer = typeof value === 'number' ? canonicalNumber(value) : String(value);
        return {
          kind: 'compiled-rule',
          ruleId: rule.id,
          concept: rule.concept,
          drill: rule.drill,
          answer: `The answer is ${answer}.`
        };
      }
      return null;
    }

    // ── The rewrite engine (R0–R5): rules as memories ──────────────────────

    /** The rule store — decks + induced rules (read view for tests/CLI). */
    rewriteRuleStore(): RuleStore {
      return this.ruleStore;
    }

    /** R4: the drill loop's induction mode (default false = shipped DSL path). */
    rewriteInductionEnabled(): boolean {
      return this.rewriteInduction;
    }

    /** Register learned rewrite rules (drill induction, taught rules,
     *  chaperone-supplied) — the store keeps their provenance as-is. */
    registerLearnedRules(rules: readonly RewriteRule[]): void {
      for (const rule of rules) this.ruleStore.register(rule);
    }

    /** @deprecated use registerLearnedRules — kept for existing callers. */
    registerInducedRules(rules: readonly RewriteRule[]): void {
      this.registerLearnedRules(rules);
    }

    /**
     * R10 — TEACH A RULE: a procedure stated in English is parsed into a
     * candidate rewrite rule (the bounded grammar of `rules/instruction.ts`)
     * and must prove itself on the family's deterministic oracle BEFORE
     * adoption. A taught rule speaks hedged until the world corroborates it.
     * Returns the outcome with a counterexample on rejection — the observer
     * explains why the rule failed, it never silently refuses.
     */
    teachRewriteRule(text: string, drill: string, options: { origin?: RuleOrigin } = {}): {
      adopted: boolean;
      message: string;
      counterexample?: string;
      ruleId?: string;
    } {
      const spec = taughtRuleSpecFor(drill);
      if (spec === null) {
        return {
          adopted: false,
          message: 'I do not have a procedure slot for that family yet — I can only take rules for the families I know.'
        };
      }
      const parsed = parseTaughtRule(text, spec, options.origin ?? 'taught');
      if (parsed === null) {
        return {
          adopted: false,
          message:
            'I could not parse that as a rule. Try the shape: "to find the gcd of a and b: if b is zero the answer is a; otherwise it is the gcd of b and the remainder of a divided by b."'
        };
      }
      const validation = validateTaughtRule(this.ruleStore, parsed, drill, {
        baseline: Math.max(0.05, chanceLevel(drill))
      });
      if (!validation.ok) {
        return {
          adopted: false,
          counterexample: validation.counterexample,
          message: `I cannot trust that rule yet. ${validation.counterexample ?? ''}`
        };
      }
      this.registerLearnedRules([parsed]);
      return {
        adopted: true,
        ruleId: parsed.id,
        message: `Learned. The rule now derives the family's instances; I will say "I think" until it is confirmed.`
      };
    }

    /**
     * Apply the rewrite rules to a fresh prompt (chatAnswer step 2.7). Only
     * prompts that parse through the authored lifters reach the engine —
     * unparsed prompts return null and the dispatch falls through untouched.
     * A prompt that PARSES but cannot derive (stuck, exhausted, or an
     * undecodable normal form) returns `underivable` — the dispatch treats
     * it as a grounded computation question and routes it to ASK, never to
     * the creative layer (a memory-composed answer to a computation request
     * is a fabrication channel).
     */
    protected applyRewriteRules(utterance: string):
      | {
          kind: 'rewrite';
          ruleIds: string[];
          steps: number;
          answer: string;
          trace: Array<{ ruleId: string; before: string; after: string }>;
        }
      | { kind: 'underivable' }
      | null {
      const parsed = parseRewritePrompt(utterance);
      if (parsed === null) return null;
      const reduction = reduce(this.ruleStore, parsed.term, { fuel: parsed.fuel });
      if (reduction.outcome.status !== 'normal') return { kind: 'underivable' };
      const value = decodeNormalForm(reduction.outcome.term);
      if (value === null) return { kind: 'underivable' };
      for (const id of reduction.ruleIds) this.ruleStore.noteUse(id);
      // P14 applied to rules: an answer derived through an uncorroborated
      // INDUCED rule speaks hedged — the observer never asserts a procedure
      // it invented for itself as confidently as one the reviewed deck gave
      // it, until the world corroborates it.
      const cited = reduction.ruleIds.map((id) => this.ruleStore.get(id)).filter((r) => r !== undefined);
      const hedged = cited.some((r) => r.origin !== 'authored' && !r.sourceClasses.includes('world-feedback'));
      return {
        kind: 'rewrite',
        ruleIds: reduction.ruleIds,
        steps: reduction.steps,
        answer: hedged ? `I think the answer is ${value}.` : `The answer is ${value}.`,
        trace: reduction.outcome.status === 'normal' ? reduction.outcome.steps : []
      };
    }

    /**
     * R5 — surgical rule weakening: a wrong grade weakens exactly the cited
     * rules (the edge convention: ±0.2 scaled by the feedback weight, floored
     * at 0.1), records the denial, and stops a doubly-denied rule at the
     * floor — never deleted, the record is kept.
     */
    weakenRule(id: string, weight: number, denial?: Partial<DerivationDenial>): void {
      const rule = this.ruleStore.get(id);
      if (rule === undefined) return;
      this.ruleStore.adjustStrength(id, -RULE_GRADE_DELTA * Math.max(0, Math.min(1, weight)));
      // REVIEW FIX (Med2): P14 withdrawal symmetry — edges lose their
      // world-feedback credit on a weak grade; rules must too, or a
      // once-corroborated rule asserts flatly all the way to the floor.
      this.ruleStore.removeSourceClass(id, 'world-feedback');
      this.ruleStore.recordDenial({
        ruleId: id,
        input: denial?.input,
        output: denial?.output,
        expected: denial?.expected,
        evidence: 'graded-wrong',
        at: Date.now()
      });
      if (!rule.active) this.ruleResolutions.add(id);
      this.storeBelief(
        rule.name,
        `I thought the rule ${rule.name} derived this answer, but the world says it was wrong.`,
        'relation-conflict',
        { ruleId: id, strength: rule.strength },
        true
      );
    }

    /** The stopped-rule ledger (one-shot — never re-litigated). */
    ruleResolutionsView(): string[] {
      return [...this.ruleResolutions];
    }

    /** R11: the drill loop raises a rule question — a procedure answer is
     *  now being awaited for the family. */
    notePendingRuleQuestion(concept: string, drill: string): void {
      this.pendingRuleQuestions.set(drill, concept);
    }

    /** R11: every open rule question (drivers offer these to a teacher —
     *  the human in chat, the chaperone later — as questions, never as
     *  answers). */
    pendingRuleQuestionsView(): Array<{ concept: string; drill: string }> {
      return [...this.pendingRuleQuestions.entries()].map(([drill, concept]) => ({ concept, drill }));
    }

    /**
     * R11 — CLOSE THE LOOP: a user reply is tried as the answer to an open
     * rule question. When the reply parses as a procedure for the pending
     * family it goes through the R10 pipeline: adoption acknowledges and
     * clears the question; validation failure answers with the
     * counterexample — the observer says what the rule got wrong, it never
     * silently refuses. Returns null when no rule question is pending or the
     * reply does not parse — the normal chat dispatch handles the reply.
     */
    tryTeachReply(text: string): { handled: boolean; message: string; adopted: boolean } | null {
      const pending = this.pendingRuleQuestionsView();
      if (pending.length === 0) return null;
      // REVIEW FIX (Med1): the reply is tried against EVERY open question,
      // not just the FIFO head — a slot-less pending (place-value, lcm) at
      // the front must not starve an adoptable gcf question behind it.
      for (const question of pending) {
        const slot = taughtRuleSpecFor(question.drill);
        if (slot === null) continue;
        const parsed = parseTaughtRule(text, slot);
        if (parsed === null) continue;
        const outcome = this.teachRewriteRule(text, question.drill);
        if (outcome.adopted) {
          this.forgetPendingRuleQuestion(question.drill);
          return { handled: true, adopted: true, message: outcome.message };
        }
        return { handled: true, adopted: false, message: outcome.message };
      }
      // A question IS open, but no family's grammar accepted the reply —
      // say what the observer needs instead of letting the reply fall into
      // ordinary chat unanswered.
      const first = pending[0];
      if (taughtRuleSpecFor(first.drill) === null) {
        return {
          handled: true,
          adopted: false,
          message:
            'I am waiting on the rule for ' +
            first.concept +
            ', but I do not yet have a procedure slot for that family — I can only take rules for the families I know (gcf today).'
        };
      }
      return {
        handled: true,
        adopted: false,
        message:
          'I could not parse that as a rule. Try the shape: "to find the gcd of a and b: if b is zero the answer is a; otherwise it is the gcd of b and the remainder of a divided by b."'
      };
    }

    /** R11: the rule question was answered — the gap and the pending entry
     *  are both closed. */
    forgetPendingRuleQuestion(drill: string): void {
      const concept = this.pendingRuleQuestions.get(drill);
      this.pendingRuleQuestions.delete(drill);
      if (concept !== undefined) this.forgetGap(`what is the rule for ${concept}?`);
    }

    /**
     * R16 — DECAY = weaken-toward-hedged, never forget. A learned rule
     * unused past the horizon loses its world credit: it keeps working but
     * speaks hedged again until the world re-corroborates it. Authored
     * decks never decay (architectural values). Never deletes, never stops
     * — only the denial machinery stops.
     */
    decayRuleCorroboration(now = Date.now(), horizonMs = RULE_CORROBORATION_HORIZON_MS): { decayed: string[] } {
      const decayed: string[] = [];
      for (const rule of this.ruleStore.all()) {
        if (rule.origin === 'authored') continue;
        if (!rule.sourceClasses.includes('world-feedback')) continue;
        const lastUsed = rule.lastUsedAt ?? rule.createdAt;
        if (now - lastUsed >= horizonMs) {
          this.ruleStore.removeSourceClass(rule.id, 'world-feedback');
          decayed.push(rule.id);
        }
      }
      return { decayed };
    }

    /**
     * R16 — CONSOLIDATION (idle maintenance, behavior-preserving): the
     * learner cleans its own rule shelf.
     *
     *  1. STRUCTURAL DEDUPE: learned rules with identical bodies and the
     *     same head collapse to the cheapest record — use counts and world
     *     credit transfer to the survivor; the redundant records are
     *     deactivated (never deleted; the record is the record).
     *  2. MDL RE-SIMPLIFICATION: for a learned rule whose family has a
     *     drill slot, re-run induction over fresh instances; a strictly
     *     cheaper rule set that clears the same held-out bar replaces the
     *     original under the reserved origin 'consolidated'.
     *  3. DENIAL COMPACTION: identical denials collapse to their earliest.
     */
    consolidateLearnedRules(): {
      deduped: string[];
      consolidated: string[];
      compactedDenials: number;
    } {
      const learned = this.ruleStore.all().filter((rule) => rule.origin !== 'authored' && rule.active);
      const report = { deduped: [] as string[], consolidated: [] as string[], compactedDenials: 0 };

      // 1. Structural dedupe by (name, canonical body).
      const byBody = new Map<string, RewriteRule[]>();
      for (const rule of learned) {
        const key = `${rule.name}\u0000${termToString(rule.rhs)}`;
        const bucket = byBody.get(key);
        if (bucket === undefined) byBody.set(key, [rule]);
        else bucket.push(rule);
      }
      for (const bucket of byBody.values()) {
        if (bucket.length < 2) continue;
        bucket.sort((a, b) => a.bits - b.bits);
        const keeper = bucket[0];
        for (const redundant of bucket.slice(1)) {
          keeper.useCount += redundant.useCount;
          if (redundant.lastUsedAt !== undefined && (keeper.lastUsedAt === undefined || redundant.lastUsedAt > keeper.lastUsedAt)) {
            keeper.lastUsedAt = redundant.lastUsedAt;
          }
          for (const sourceClass of redundant.sourceClasses) this.ruleStore.addSourceClass(keeper.id, sourceClass);
          this.ruleStore.setActive(redundant.id, false);
          report.deduped.push(redundant.id);
        }
      }

      // 2. MDL re-simplification for drill-backed families.
      for (const rule of this.ruleStore.all()) {
        if (rule.origin === 'authored' || !rule.active || rule.schema === undefined) continue;
        const family = drillForRuleName(rule.name);
        if (family === null) continue;
        const target = rewriteTargetFor(family);
        if (target === null || target.schema !== rule.schema) continue;
        const fresh = generateExercises(family, 'concept', { count: 44, seed: 0x50c11 });
        const train: InductionInstance[] = [];
        const test: InductionInstance[] = [];
        for (const exercise of fresh.slice(0, 22)) {
          const instance = target.lift(exercise);
          if (instance !== null) train.push(instance);
        }
        for (const exercise of fresh.slice(22)) {
          const instance = target.lift(exercise);
          if (instance !== null) test.push(instance);
        }
        if (train.length < 6 || test.length < 6) continue;
        const instanceBits = train.reduce((sum, instance) => sum + termBits(instance.answer), 0);
        const cheaper = induceRuleSet(this.ruleStore, rule.name, train, {
          instanceBits,
          baseline: 0.05,
          margin: INDUCTION_MARGIN,
          minHits: MIN_INDUCTION_HITS,
          schema: rule.schema,
          fuel: 60_000
        });
        if (cheaper === null) continue;
        const cheaperBits = cheaper.reduce((sum, candidate) => sum + candidate.bits, 0);
        if (cheaperBits >= rule.bits) continue;
        if (!validateHeldOut(this.ruleStore, cheaper, test, 0.05, INDUCTION_MARGIN, MIN_INDUCTION_HITS, 60_000)) continue;
        // REVIEW FIX (M4): fresh ids under the reserved origin — the old
        // deterministic induced ids would collide in register() and the
        // origin/bits/body would silently never land.
        const freshId = (() => {
          let seq = 0;
          return (name: string): string => `consolidated-${name}-${seq++}`;
        })();
        const consolidated: RewriteRule[] = cheaper.map((candidate) => ({
          ...candidate,
          id: freshId(rule.name),
          origin: 'consolidated' as const,
          createdAt: Date.now(),
          useCount: 0,
          lastUsedAt: undefined
        }));
        // REVIEW FIX: the consolidated replacement inherits the old rule's
        // corroboration and usage — a world-confirmed rule must not flip
        // back to "I think…" just because its body got cheaper.
        if (consolidated[0] !== undefined) {
          for (const sourceClass of rule.sourceClasses) this.ruleStore.addSourceClass(consolidated[0].id, sourceClass);
          consolidated[0].useCount = rule.useCount;
          consolidated[0].lastUsedAt = rule.lastUsedAt;
        }
        this.ruleStore.setActive(rule.id, false);
        this.registerLearnedRules(consolidated);
        report.consolidated.push(rule.id);
      }

      // 3. Denial compaction.
      report.compactedDenials = this.ruleStore.compactDenials();
      return report;
    }

    /** The composition-rule store (seeds + admitted) for the composer. */
    compositionRuleStore(): CompositionRuleStore {
      return this.compositionRules;
    }
  };
}
