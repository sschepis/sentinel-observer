/**
 * RULES AS MEMORIES — the rule store.
 *
 * A rewrite rule is the same kind of object an edge already is: storable,
 * recallable, gradeable, corroborated, contradicted. Rules carry provenance
 * (origin), confidence (strength), independent corroboration
 * (sourceClasses), evidence counts (induced), and a denied-derivation
 * record (the rule analog of the confirmed-false store).
 *
 * Priority is insertion order: first match wins, no backtracking — the
 * determinism the engine gate tests. Rules are never deleted; they are
 * stopped (two denials below the strength floor, or a world resolution)
 * and the record is kept, like negations.
 */

import { termBits, type Term } from './terms';

export type RuleOrigin = 'authored' | 'induced' | 'taught' | 'chaperone' | 'consolidated';

export type RuleSchema = 'structural' | 'measure' | 'accessor' | 'search' | 'scalar';

export interface RewriteRule {
  id: string;
  /** The symbol this rule reduces — self-reference in the RHS is recursion. */
  name: string;
  lhs: Term;
  rhs: Term;
  origin: RuleOrigin;
  /** 1 default; grade-weakened (the P8 edge convention: ±0.2, floor 0.1). */
  strength: number;
  /** P14 source classes — an induced rule starts with none and speaks
   *  hedged until the world corroborates it. */
  sourceClasses: string[];
  /** Description length in bits (MDL gate for induced rules). */
  bits: number;
  /** Distinct demonstrations behind an induced rule. */
  evidence?: number;
  /** Induced rules carry the recursion schema they were synthesized under. */
  schema?: RuleSchema;
  /** False = stopped by the honesty layer (denied or world-resolved). */
  active: boolean;
  createdAt: number;
  lastUsedAt?: number;
  useCount: number;
}

/** The rule analog of Negation: a derivation the world contradicted. */
export interface DerivationDenial {
  ruleId: string;
  /** The redex the rule was applied to (bounded form). */
  input?: string;
  /** What the rule produced (bounded form). */
  output?: string;
  /** The world's verdict / oracle value when known. */
  expected?: string;
  evidence: 'graded-wrong' | 'verified-wrong' | 'taught';
  at: number;
}

export interface DerivationStep {
  ruleId: string;
  before: string;
  after: string;
}

export type RewriteOutcome =
  | { status: 'normal'; term: Term; steps: DerivationStep[] }
  | { status: 'stuck'; term: Term }
  | { status: 'exhausted'; steps: number; trace?: DerivationStep[] };

/** The floor below which grades never push a rule's strength. */
export const RULE_STRENGTH_FLOOR = 0.1;
/** Grade-driven strength adjustment (the edge convention, ±0.2). */
export const RULE_GRADE_DELTA = 0.2;
/** Independent denials (with strength below the floor) that stop a rule. */
export const RULE_DENIAL_STOP_COUNT = 2;

export class RuleStore {
  private readonly rules: RewriteRule[] = [];
  private readonly denials: DerivationDenial[] = [];
  private readonly byId = new Map<string, RewriteRule>();
  /** Lazy symbol index — rebuilt after any registration (rare). */
  private nameIndex: Map<string, RewriteRule[]> | null = null;

  constructor(rules: readonly RewriteRule[] = [], denials: readonly DerivationDenial[] = []) {
    for (const rule of rules) this.register(rule);
    this.denials.push(...denials);
  }

  /** Register a rule. Fails loudly on an invalid one — a malformed authored
   *  deck is a programmer error, not a runtime condition.
   *
   *  REVIEW FIX (M4 + review-1 findings): the rule's reducible symbol is
   *  its LHS HEAD (never a stale passed name); heads must keep the
   *  canonical-string form injective (no `(`, `)`, `,`, `?`, or literal
   *  tags — a rule named `?x` or `#n:1` would falsely equal a variable or
   *  literal in equality and cycle detection); strength is clamped to
   *  [floor, 2] on registration too; and an id collision replaces the
   *  WHOLE record — a new body is a new rule, with a fresh world record
   *  (the id's denials reset) and a refreshed index.
   */
  register(rule: RewriteRule): string {
    if (rule.lhs.t !== 'sym') throw new Error(`rule ${rule.id} lhs must be a symbol`);
    const head = rule.lhs.head;
    if (head === 'ite') throw new Error(`rule ${rule.id} may not reduce 'ite' (native special form)`);
    if (head.length === 0) throw new Error(`rule ${rule.id} has an empty name`);
    if (/[(),?]/.test(head) || /^#/.test(head)) {
      throw new Error(`rule ${rule.id} head "${head}" would break canonical-string equality — reject it`);
    }
    const rhsFree = new Set<string>();
    const walk = (term: Term): void => {
      if (term.t === 'var') rhsFree.add(term.name);
      else if (term.t === 'sym') for (const arg of term.args) walk(arg);
    };
    walk(rule.rhs);
    const lhsFree = new Set<string>();
    const walkLhs = (term: Term): void => {
      if (term.t === 'var') lhsFree.add(term.name);
      else if (term.t === 'sym') for (const arg of term.args) walkLhs(arg);
    };
    walkLhs(rule.lhs);
    for (const name of rhsFree) {
      if (!lhsFree.has(name)) throw new Error(`rule ${rule.id}: unbound variable ?${name} in rhs`);
    }
    const strength = Math.max(RULE_STRENGTH_FLOOR, Math.min(2, rule.strength));
    const existing = this.byId.get(rule.id);
    if (existing !== undefined) {
      // FULL replacement: a new body is a new rule — provenance, the
      // world record (denials), and usage all reset with it.
      existing.name = head;
      existing.lhs = rule.lhs;
      existing.rhs = rule.rhs;
      existing.origin = rule.origin;
      existing.strength = strength;
      existing.sourceClasses = rule.sourceClasses;
      existing.bits = rule.bits;
      existing.evidence = rule.evidence;
      existing.schema = rule.schema;
      existing.active = rule.active;
      existing.createdAt = rule.createdAt;
      existing.useCount = 0;
      existing.lastUsedAt = undefined;
      for (let i = this.denials.length - 1; i >= 0; i -= 1) {
        if (this.denials[i].ruleId === rule.id) this.denials.splice(i, 1);
      }
      this.nameIndex = null;
      return existing.id;
    }
    const complete = { ...rule, name: head, strength };
    this.rules.push(complete);
    this.byId.set(complete.id, complete);
    this.nameIndex = null;
    return complete.id;
  }

  /** Every rule, in insertion order (the engine's priority order). */
  all(): RewriteRule[] {
    return [...this.rules];
  }

  get(id: string): RewriteRule | undefined {
    return this.byId.get(id);
  }

  /** The rules that may reduce `name`, in priority order, stopped rules
   *  excluded. Indexed lazily — this is the engine's hot path. */
  bySymbol(name: string): RewriteRule[] {
    if (this.nameIndex === null) {
      const index = new Map<string, RewriteRule[]>();
      for (const rule of this.rules) {
        const bucket = index.get(rule.name);
        if (bucket === undefined) index.set(rule.name, [rule]);
        else bucket.push(rule);
      }
      this.nameIndex = index;
    }
    const active = this.nameIndex.get(name);
    if (active === undefined) return [];
    const stopped = active.filter((rule) => this.isStopped(rule.id));
    return stopped.length === 0 ? active : active.filter((rule) => !this.isStopped(rule.id));
  }

  /** True when the honesty layer has stopped the rule: two independent
   *  denials AND strength weakened to the floor — or an explicit world
   *  resolution. Never deleted; the record is kept. */
  isStopped(id: string): boolean {
    const rule = this.byId.get(id);
    if (rule === undefined || !rule.active) return true;
    if (rule.strength <= RULE_STRENGTH_FLOOR && this.independentDenials(id) >= RULE_DENIAL_STOP_COUNT) return true;
    return false;
  }

  adjustStrength(id: string, delta: number): void {
    const rule = this.byId.get(id);
    if (rule === undefined) return;
    rule.strength = Math.max(RULE_STRENGTH_FLOOR, Math.min(2, rule.strength + delta));
  }

  setActive(id: string, active: boolean): void {
    const rule = this.byId.get(id);
    if (rule !== undefined) rule.active = active;
  }

  /** Corroboration: an independent source class now supports the rule. */
  addSourceClass(id: string, sourceClass: string): void {
    const rule = this.byId.get(id);
    if (rule === undefined || rule.sourceClasses.includes(sourceClass)) return;
    rule.sourceClasses.push(sourceClass);
  }

  /** Corroboration can decay (R16): an unused rule loses its world credit
   *  and speaks hedged again — it keeps working, never forgotten. */
  removeSourceClass(id: string, sourceClass: string): void {
    const rule = this.byId.get(id);
    if (rule === undefined) return;
    rule.sourceClasses = rule.sourceClasses.filter((entry) => entry !== sourceClass);
  }

  /** R16: structurally identical DENIED DERIVATIONS (same input + output)
   *  collapse to their earliest record. Grade-driven denials without term
   *  information are NOT merged — each is a distinct world rejection and
   *  the two-denial stop counts them (merging them would let a wrongly
   *  graded rule never stop). */
  compactDenials(): number {
    const seen = new Set<string>();
    const compacted: DerivationDenial[] = [];
    for (const denial of this.denials) {
      if (denial.input !== undefined && denial.output !== undefined) {
        const key = `${denial.evidence}\u0000${denial.input}\u0000${denial.output}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      compacted.push(denial);
    }
    const removed = this.denials.length - compacted.length;
    this.denials.splice(0, this.denials.length, ...compacted);
    return removed;
  }

  noteUse(id: string): void {
    const rule = this.byId.get(id);
    if (rule === undefined) return;
    rule.useCount += 1;
    rule.lastUsedAt = Date.now();
  }

  recordDenial(denial: DerivationDenial): void {
    const rule = this.byId.get(denial.ruleId);
    if (rule === undefined) return;
    this.denials.push(denial);
    // The two-denial stop: independent denials with strength at the floor
    // stop the rule — it is never deleted, only silenced.
    if (this.independentDenials(rule.id) >= RULE_DENIAL_STOP_COUNT && rule.strength <= RULE_STRENGTH_FLOOR) {
      rule.active = false;
    }
  }

  denialsOf(id: string): DerivationDenial[] {
    return this.denials.filter((denial) => denial.ruleId === id);
  }

  allDenials(): DerivationDenial[] {
    return [...this.denials];
  }

  private independentDenials(id: string): number {
    const seen = new Set<string>();
    for (const denial of this.denials) {
      if (denial.ruleId !== id) continue;
      // A denial is independent when it names a distinct derivation
      // (input + output). A grade-driven denial without term information is
      // a distinct world rejection of a distinct answer — each counts.
      const key =
        denial.input !== undefined && denial.output !== undefined
          ? `${denial.evidence}\u0000${denial.input}\u0000${denial.output}`
          : `${denial.evidence}\u0000at:${denial.at}`;
      seen.add(key);
    }
    return seen.size;
  }

  /** Description-length cost of a rule (for the MDL gate). */
  bitsOf(rule: RewriteRule): number {
    return termBits(rule.lhs) + termBits(rule.rhs);
  }

  count(): number {
    return this.rules.length;
  }

  serialize(): { rules: RewriteRule[]; denials: DerivationDenial[] } {
    return { rules: this.rules.map((rule) => ({ ...rule })), denials: this.denials.map((d) => ({ ...d })) };
  }
}
