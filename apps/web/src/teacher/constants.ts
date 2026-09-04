/**
 * CONSTANTS TAXONOMY (§5 / Phase D) — the registry that keeps self-tuning
 * from dissolving the benchmark reference.
 *
 * The system carries several dozen numeric constants, but they are not the
 * same kind of thing. Exactly three kinds exist, and only one may self-tune:
 *
 *   · `values`  — a judgment the AUTHOR is entitled to make and the data
 *     cannot: the retention target (0.9), the relative cost of a wrong answer
 *     versus an abstention, the honesty contract, the trust prior, the lapse
 *     floor/cap. These stay explicit and fixed.
 *   · `safety`  — bounds that make failure IMPOSSIBLE rather than unlikely:
 *     fuel budgets, walk depth, visited-set guards, the ≤16 Hebbian partners
 *     per oscillator, the bounded ledgers (caps), record-size ceilings. A
 *     self-tuning fuel budget is a fabrication channel, so these must never
 *     self-tune.
 *   · `tuning`  — a judgment the data COULD make and today does not: blend
 *     weights, thresholds, decay presets, settle depth, MDL token costs,
 *     agreement thresholds. These are the target of self-tuning.
 *
 * Every entry records the constant's NAME, class, CURRENT value, and the
 * file:line it lives in. Tuning entries additionally carry `evidence` — the
 * sources that set (or, today, SHOULD set) the value plus the evidence mass.
 *
 * THE CIRCULARITY GUARD (§5.4 / D.10): thresholds tuned on graded outcomes,
 * where grades come partly from an LLM whose trust is itself measured against
 * those outcomes, form a loop. The programmatic benches — fuzz, chain,
 * adversarial, math — are the only anchor. `assertProgrammaticAnchor` refuses
 * any self-tuning gate whose evidence holds no programmatic bench, and
 * `assertAllAnchored` applies the same check to the whole registry.
 *
 * This module is documentation + a registry + a guard. It records constants;
 * it never changes a value and never re-routes behavior.
 */

export type ConstantClass = 'values' | 'safety' | 'tuning';

/** The programmatic benches that anchor the circularity loop (§5.4). */
export type ProgrammaticBench = 'fuzz' | 'chain' | 'adversarial' | 'math';

/** Every evidence source a tuning gate may carry. The first four are the
 *  programmatic anchors; the rest cannot, on their own, anchor a gate. */
export type EvidenceSource = ProgrammaticBench | 'llm-grade' | 'world-outcome' | 'calibration';

export const PROGRAMMATIC_BENCHES: ReadonlySet<EvidenceSource> = new Set<EvidenceSource>([
  'fuzz',
  'chain',
  'adversarial',
  'math'
]);

/** The evidence that sets a tuning constant: which sources contribute, and
 *  the mass (sample count) of that evidence. `mass === null` means the gate
 *  is still on its hand constant and has not yet been measured. */
export interface TuningEvidence {
  sources: readonly EvidenceSource[];
  /** Evidence mass that set the value (sample count); null when unmeasured. */
  mass: number | null;
  /** One-line pointer to the data source / §5.2 row. */
  note: string;
}

export interface ConstantEntry {
  name: string;
  class: ConstantClass;
  /** Current value (recorded literal, kept in sync with the file:line). */
  value: number;
  /** Repo-relative path of the source file. */
  file: string;
  line: number;
  note: string;
  /** Present only for `tuning` constants. */
  evidence?: TuningEvidence;
}

// ────────────────────────────────────────────────────────────────────────────
// The registry
// ────────────────────────────────────────────────────────────────────────────

export const CONSTANTS: readonly ConstantEntry[] = [
  // ── VALUES — judgments the data cannot make ────────────────────────────────
  {
    name: 'FSRS_TARGET_RETENTION',
    class: 'values',
    value: 0.9,
    file: 'apps/web/src/teacher/retention.ts',
    line: 18,
    note: 'The retention target: the due interval solves R(interval) = 0.9.'
  },
  {
    name: 'FSRS_FORGETTING_FACTOR',
    class: 'values',
    value: 19 / 81,
    file: 'apps/web/src/teacher/retention.ts',
    line: 21,
    note: 'The FSRS v4 forgetting-curve constant (19/81) — the one retention law.'
  },
  {
    name: 'TRUST_PRIOR',
    class: 'values',
    value: 0.65,
    file: 'apps/web/src/teacher/trust.ts',
    line: 40,
    note: 'Uninformative prior for an incumbent judge — slightly better than chance.'
  },
  {
    name: 'TRUST_MIN_WEIGHT',
    class: 'values',
    value: 0.1,
    file: 'apps/web/src/teacher/trust.ts',
    line: 44,
    note: 'Floor of the feedback weight — damp, never erase (the honesty floor).'
  },
  {
    name: 'TRUST_Z',
    class: 'values',
    value: 1.96,
    file: 'apps/web/src/teacher/trust.ts',
    line: 46,
    note: 'z of the Wilson lower bound (~95% one-sided confidence).'
  },
  {
    name: 'FUSION_TEACHER_FLOOR',
    class: 'values',
    value: 0.05,
    file: 'apps/web/src/teacher/trust.ts',
    line: 49,
    note: 'Defensive floor on the incumbent trust in fusion — λ never reaches 1.'
  },
  {
    name: 'LAPSE_KEEP_FLOOR',
    class: 'values',
    value: 0.05,
    file: 'apps/web/src/teacher/agent/wordloop.ts',
    line: 560,
    note: 'Lapse floor (clamp(1 − R, 0.05, 0.5)) — how much a lapse should ever cost.'
  },
  {
    name: 'LAPSE_KEEP_CAP',
    class: 'values',
    value: 0.5,
    file: 'apps/web/src/teacher/agent/wordloop.ts',
    line: 560,
    note: 'Lapse cap (clamp(1 − R, 0.05, 0.5)) — how much a lapse should ever cost.'
  },
  {
    name: 'CORROBORATION_CLASSES',
    class: 'values',
    value: 2,
    file: 'apps/web/src/teacher/corroboration.ts',
    line: 33,
    note: 'Minimum number of independent source classes that corroborate an edge.'
  },
  {
    name: 'STRENGTH_CONFIDENT',
    class: 'values',
    value: 1,
    file: 'apps/web/src/teacher/corroboration.ts',
    line: 35,
    note: 'Effective strength above which an edge reads as confident.'
  },
  {
    name: 'WRONG_ANSWER_COST',
    class: 'values',
    value: 1,
    file: 'apps/web/src/teacher/calibration.ts',
    line: 40,
    note: '§5.2 row 3: the cost of a wrong answer — the decision threshold τ = 1/(1+0.25) = 0.8 encodes the honesty contract.'
  },
  {
    name: 'ABSTAIN_COST',
    class: 'values',
    value: 0.25,
    file: 'apps/web/src/teacher/calibration.ts',
    line: 43,
    note: '§5.2 row 3: the cost of abstaining (asking honestly) — a wrong answer costs 4× an abstention; the data cannot set this.'
  },

  // ── SAFETY — bounds that make failure impossible ───────────────────────────
  {
    name: 'MAX_DEPTH',
    class: 'safety',
    value: 4,
    file: 'apps/web/src/teacher/chain.ts',
    line: 21,
    note: 'Is-a walk depth bound — chain walks terminate after 4 hops.'
  },
  {
    name: 'ANCESTOR_DEPTH',
    class: 'safety',
    value: 4,
    file: 'apps/web/src/teacher/contradictions.ts',
    line: 29,
    note: 'The contradiction sweep is-a walk depth, mirroring chain.ts MAX_DEPTH.'
  },
  {
    name: 'READING_WORD_BUDGET',
    class: 'safety',
    value: 64,
    file: 'apps/web/src/teacher/agent/support.ts',
    line: 383,
    note: 'Fuel budget — words one passage may teach (a book must not flood the bank).'
  },
  {
    name: 'ANSWER_GRADES_CAP',
    class: 'safety',
    value: 200,
    file: 'apps/web/src/teacher/agent/support.ts',
    line: 169,
    note: 'Bounded ledger — the per-answer grade record is capped.'
  },
  {
    name: 'SWEEP_RESOLVED_CAP',
    class: 'safety',
    value: 500,
    file: 'apps/web/src/teacher/agent/support.ts',
    line: 171,
    note: 'Bounded ledger — the resolved-sweep-conflict ledger is capped.'
  },
  {
    name: 'PENDING_REGRADE_CAP',
    class: 'safety',
    value: 100,
    file: 'apps/web/src/teacher/reliability.ts',
    line: 90,
    note: 'Bounded ledger — the pending re-grade queue is capped.'
  },
  {
    name: 'REGRADE_HISTORY_CAP',
    class: 'safety',
    value: 200,
    file: 'apps/web/src/teacher/reliability.ts',
    line: 91,
    note: 'Bounded ledger — the re-grade history is capped.'
  },
  {
    name: 'REVIEW_HISTORY_CAP',
    class: 'safety',
    value: 24,
    file: 'apps/web/src/teacher/curriculum.ts',
    line: 96,
    note: 'Bounded ledger — persisted per-word review history is capped.'
  },
  {
    name: 'GATE_SAMPLE_CAP',
    class: 'safety',
    value: 500,
    file: 'apps/web/src/teacher/calibration.ts',
    line: 36,
    note: 'Bounded ledger — the calibration sample FIFO is capped per gate.'
  },
  {
    name: 'SETTLE_PEAK_FUEL',
    class: 'safety',
    value: 16,
    file: 'apps/web/src/teacher/agent/support.ts',
    line: 476,
    note: 'Fuel budget — the coherence-peak settle may tick at most this many times before the fixed depth is the fallback (a self-tuning fuel budget is a fabrication channel).'
  },
  {
    name: 'MAX_RECORD_BYTES',
    class: 'safety',
    value: 256 * 1024 * 1024,
    file: 'apps/web/src/teacher/bootstrapLoader.ts',
    line: 13,
    note: 'Record-size ceiling — a deployed record larger than this is rejected.'
  },
  {
    name: 'HEBBIAN_PARTNER_CAP',
    class: 'safety',
    value: 16,
    file: 'packages/sentient-core/src/semantic/HebbianCoupling.ts',
    line: 62,
    note: '≤16 Hebbian learned partners per oscillator, weakest-evict.'
  },
  {
    name: 'INDUCTION_FUEL',
    class: 'safety',
    value: 5_000,
    file: 'apps/web/src/teacher/rules/induction.ts',
    line: 48,
    note: 'Fuel budget for rule-induction candidate simulations.'
  },
  {
    name: 'RULE_DEFAULT_FUEL',
    class: 'safety',
    value: 10_000,
    file: 'apps/web/src/teacher/rules/engine.ts',
    line: 26,
    note: 'Hard rewrite-step budget per query — a missed cycle burns fuel, never wrong.'
  },
  {
    name: 'MAX_GOAL_ATTEMPTS',
    class: 'safety',
    value: 5,
    file: 'apps/web/src/teacher/plan.ts',
    line: 65,
    note: 'A goal abandons after this many attempts — bounded planning.'
  },
  {
    name: 'MAX_STALLED_STEPS',
    class: 'safety',
    value: 3,
    file: 'apps/web/src/teacher/plan.ts',
    line: 66,
    note: 'A goal stalls out after this many no-progress steps.'
  },
  {
    name: 'MAX_CONCURRENCY',
    class: 'safety',
    value: 3,
    file: 'apps/web/src/teacher/chaperone.ts',
    line: 510,
    note: 'Bounded LLM concurrency in the chaperone fill pass.'
  },
  {
    name: 'RELATIONS_PER_WORD_MAX',
    class: 'safety',
    value: 6,
    file: 'apps/web/src/teacher/chaperone.ts',
    line: 557,
    note: 'Bounded ledger — relations extracted per word are capped.'
  },
  {
    name: 'BEHAVIOR_WEIGHT_FLOOR',
    class: 'safety',
    value: 0.05,
    file: 'apps/web/src/teacher/drives.ts',
    line: 58,
    note: 'Bounded ledger — no drive may be starved below this by failures.'
  },
  {
    name: 'BEHAVIOR_WEIGHT_CEILING',
    class: 'safety',
    value: 1.5,
    file: 'apps/web/src/teacher/drives.ts',
    line: 60,
    note: 'Bounded ledger — no drive may dominate above this.'
  },
  {
    name: 'BEHAVIOR_TEMPERATURE_MIN',
    class: 'safety',
    value: 0.05,
    file: 'apps/web/src/teacher/drives.ts',
    line: 65,
    note: 'T_MIN — the exploration lower bound is architectural.'
  },
  {
    name: 'BEHAVIOR_TEMPERATURE_MAX',
    class: 'safety',
    value: 1.0,
    file: 'apps/web/src/teacher/drives.ts',
    line: 66,
    note: 'T_MAX — the exploration upper bound is architectural.'
  },
  {
    name: 'COUNCIL_MAX_ROUNDS',
    class: 'safety',
    value: 3,
    file: 'apps/web/src/teacher/network.ts',
    line: 131,
    note: 'Bounded council rounds — deliberation cannot loop forever.'
  },
  {
    name: 'SHARD_SPLIT_MIN_TRACES',
    class: 'safety',
    value: 64,
    file: 'packages/sentient-core/src/semantic/ShardedMemoryBank.ts',
    line: 448,
    note: 'Floor guard — a shard below this many traces never splits (no churn).'
  },
  {
    name: 'SHARD_MERGE_FLOOR',
    class: 'safety',
    value: 24,
    file: 'packages/sentient-core/src/semantic/ShardedMemoryBank.ts',
    line: 449,
    note: 'Floor guard — a shard starved below this is folded into a neighbor.'
  },
  {
    name: 'COMPACT_INDEX_THRESHOLD',
    class: 'safety',
    value: 1e-4,
    file: 'packages/sentient-core/src/semantic/CompactMemoryBank.ts',
    line: 238,
    note: 'Amplitude below which a prime is not indexed — a numerical guard.'
  },

  // ── TUNING — judgments the data could make ─────────────────────────────────
  {
    name: 'CONVERSATION_HIGH_CONFIDENCE',
    class: 'tuning',
    value: 0.8,
    file: 'apps/web/src/teacher/agent/support.ts',
    line: 363,
    note: 'Chat routing threshold — memorized recall is authoritative above this. The CONTROL of CALIBRATED_CONVERSATION_HIGH_CONFIDENCE.',
    evidence: { sources: ['fuzz', 'calibration', 'llm-grade'], mass: null, note: '§5.2 row 3: calibrated P(correct | score) on graded outcomes; anchored by the fuzz bench (0 false positives).' }
  },
  {
    name: 'CONVERSATION_MIN_MARGIN',
    class: 'tuning',
    value: 0.05,
    file: 'apps/web/src/teacher/agent/support.ts',
    line: 379,
    note: 'Margin gate — separation a memorized answer must show over its competitor.',
    evidence: { sources: ['fuzz', 'calibration'], mass: null, note: 'Measured on 200 taught cues (mean margin +0.104); anchored by the fuzz bench.' }
  },
  {
    name: 'CONVERSATION_RECALL_FLOOR',
    class: 'tuning',
    value: 0.6,
    file: 'apps/web/src/teacher/conversation.ts',
    line: 303,
    note: 'Floor the deck must clear before creative answers unlock.',
    evidence: { sources: ['fuzz', 'calibration'], mass: null, note: 'Set from measured recall distributions (unrelated text < 0.6).' }
  },
  {
    name: 'CONVERSATION_EXACT_RECALL_FLOOR',
    class: 'tuning',
    value: 0.4,
    file: 'apps/web/src/teacher/conversation.ts',
    line: 314,
    note: 'Floor for an exact-identity match in the memorized layer.',
    evidence: { sources: ['fuzz', 'calibration'], mass: null, note: 'Above the ~0.53–0.6 phase-state drift band of short cues.' }
  },
  {
    name: 'CREATIVE_UNLOCK_THRESHOLD',
    class: 'tuning',
    value: 0.8,
    file: 'apps/web/src/teacher/conversation.ts',
    line: 316,
    note: 'Fraction of taught pairs recalled needed to unlock creative mode. The CONTROL of CALIBRATED_CREATIVE_UNLOCK.',
    evidence: { sources: ['fuzz', 'calibration'], mass: null, note: '§5.2 row 3: creative unlock 80%.' }
  },
  {
    name: 'CREATIVE_REINFORCE_SCORE',
    class: 'tuning',
    value: 0.7,
    file: 'apps/web/src/teacher/agent/support.ts',
    line: 270,
    note: 'A creative answer graded this well reinforces its seed memories. The CONTROL of CALIBRATED_CREATIVE_REINFORCE.',
    evidence: { sources: ['fuzz', 'llm-grade'], mass: null, note: '§5.2 row 3: hybrid store ≥ 0.7.' }
  },
  {
    name: 'CREATIVE_WEAKEN_SCORE',
    class: 'tuning',
    value: 0.3,
    file: 'apps/web/src/teacher/agent/support.ts',
    line: 277,
    note: 'A creative answer graded this poorly weakens its seed memories.',
    evidence: { sources: ['fuzz', 'llm-grade'], mass: null, note: '§5.2 row 3: the weaken band mirrors the reinforce band.' }
  },
  {
    name: 'REVIEW_STRENGTH_THRESHOLD',
    class: 'tuning',
    value: 0.6,
    file: 'apps/web/src/teacher/agent/support.ts',
    line: 430,
    note: 'Strength below which a trace NEEDS review (the curiosity threshold).',
    evidence: { sources: ['fuzz', 'world-outcome'], mass: null, note: 'The review gate FSRS scheduling replaced; data could set it.' }
  },
  {
    name: 'SOON_STRENGTH_THRESHOLD',
    class: 'tuning',
    value: 0.75,
    file: 'apps/web/src/teacher/agent/support.ts',
    line: 433,
    note: 'Strength below which a trace projects due within a day.',
    evidence: { sources: ['fuzz', 'world-outcome'], mass: null, note: 'A projection threshold the scheduler could fit.' }
  },
  {
    name: 'RECALL_SETTLE_STEPS',
    class: 'tuning',
    value: 4,
    file: 'apps/web/src/teacher/agent/support.ts',
    line: 441,
    note: 'Settle depth — convergence steps after a perturbation.',
    evidence: { sources: ['fuzz', 'chain'], mass: null, note: '§5.2 row 1: tick until coherence peaks (d coherence/dt crosses zero).' }
  },
  {
    name: 'SETTLE_DT',
    class: 'tuning',
    value: 0.05,
    file: 'apps/web/src/teacher/agent/support.ts',
    line: 442,
    note: 'Per-step integration dt of the settle transient.',
    evidence: { sources: ['fuzz'], mass: null, note: 'Drive-scaled settle falls out of the coherence-peak criterion.' }
  },
  {
    name: 'SETTLE_CRITERION_PEAK',
    class: 'tuning',
    value: 0,
    file: 'apps/web/src/teacher/TeacherAgent.ts',
    line: 323,
    note: '0 = fixed-depth settle is the CONTROL; 1 = tick until the coherence peak (stop when d coherence/dt crosses zero), the fixed depth remaining the fallback within the fuel budget.',
    evidence: { sources: ['fuzz', 'chain'], mass: null, note: '§5.2 row 1: the settleCriterion option; defaults to the fixed depth until the settle-criterion bench (0 fuzz FP + exact recall) shows the peak is well-defined.' }
  },
  {
    name: 'CALIBRATED_CONVERSATION_HIGH_CONFIDENCE',
    class: 'tuning',
    value: 0,
    file: 'apps/web/src/teacher/calibration.ts',
    line: 70,
    note: '0 = the 0.8 constant is the CONTROL; 1 = gate on the isotonic P(correct | recall score) crossing τ = cost(wrong)/(cost(wrong)+cost(abstain)).',
    evidence: { sources: ['fuzz', 'adversarial', 'calibration'], mass: null, note: '§5.2 row 3: calibrated on labeled recall outcomes (exact cues vs fuzz distractors); anchored by the fuzz bench — a lost probe reverts the flag.' }
  },
  {
    name: 'CALIBRATED_CREATIVE_REINFORCE',
    class: 'tuning',
    value: 0,
    file: 'apps/web/src/teacher/calibration.ts',
    line: 70,
    note: '0 = the 0.7 constant is the CONTROL; 1 = reinforce/store on the isotonic P(correct | grade) crossing τ.',
    evidence: { sources: ['fuzz', 'adversarial', 'calibration'], mass: null, note: '§5.2 row 3: calibrated on graded creative outcomes (gold set + rule-band agreement); anchored by the honesty probes.' }
  },
  {
    name: 'CALIBRATED_CREATIVE_UNLOCK',
    class: 'tuning',
    value: 0,
    file: 'apps/web/src/teacher/calibration.ts',
    line: 70,
    note: '0 = the 0.8 unlock fraction is the CONTROL; 1 = unlock when P(correct composition | competency) crosses τ.',
    evidence: { sources: ['fuzz', 'adversarial', 'calibration'], mass: null, note: '§5.2 row 3: calibrated on graded outcomes across competency levels; anchored by the honesty probes (evasion rule untouched).' }
  },
  {
    name: 'GRADE_STRONG_THRESHOLD',
    class: 'tuning',
    value: 0.7,
    file: 'apps/web/src/teacher/reliability.ts',
    line: 75,
    note: 'Upper band edge — grades at or above read as strong.',
    evidence: { sources: ['fuzz', 'llm-grade'], mass: null, note: 'The LLM grade band must agree with the rule-based band.' }
  },
  {
    name: 'GRADE_WEAK_THRESHOLD',
    class: 'tuning',
    value: 0.3,
    file: 'apps/web/src/teacher/reliability.ts',
    line: 76,
    note: 'Lower band edge — grades at or below read as weak.',
    evidence: { sources: ['fuzz', 'llm-grade'], mass: null, note: 'The LLM grade band must agree with the rule-based band.' }
  },
  {
    name: 'WORLD_FEEDBACK_WEIGHT',
    class: 'tuning',
    value: 0.25,
    file: 'apps/web/src/teacher/reliability.ts',
    line: 88,
    note: 'A world-feedback sample is weaker evidence than a rule check.',
    evidence: { sources: ['fuzz', 'world-outcome'], mass: null, note: '§5.2 row 9: world-outcome weight 0.25 vs teacher 1.0.' }
  },
  {
    name: 'RETENTION_FRACTION',
    class: 'tuning',
    value: 0.25,
    file: 'apps/web/src/teacher/agent/support.ts',
    line: 275,
    note: 'How much of the full grade delta a later recall carries.',
    evidence: { sources: ['fuzz', 'world-outcome'], mass: null, note: '§5.2 row 9: the world confirms slowly, the teacher sharply.' }
  },
  {
    name: 'VERIFY_UNLOCK_THRESHOLD',
    class: 'tuning',
    value: 3,
    file: 'apps/web/src/teacher/agent/support.ts',
    line: 272,
    note: 'Contradictions required before the verify drive unlocks.',
    evidence: { sources: ['adversarial', 'world-outcome'], mass: null, note: 'A count threshold the contradiction history could set.' }
  },
  {
    name: 'CREATIVE_GRADE_DELTA',
    class: 'tuning',
    value: 0.05,
    file: 'apps/web/src/teacher/agent/support.ts',
    line: 279,
    note: 'Strength delta per seed when a composition is graded.',
    evidence: { sources: ['fuzz', 'calibration'], mass: null, note: 'Surprise-scaled by grade margin, floored at 0.25 of the base.' }
  },
  {
    name: 'QUIZ_GRADE_DELTA',
    class: 'tuning',
    value: 0.1,
    file: 'apps/web/src/teacher/agent/support.ts',
    line: 305,
    note: 'Strength delta on a wrong quiz grade.',
    evidence: { sources: ['fuzz', 'calibration'], mass: null, note: 'A learning-rate magnitude the data could fit.' }
  },
  {
    name: 'QUIZ_WEAKEN_FLOOR',
    class: 'tuning',
    value: 0.3,
    file: 'apps/web/src/teacher/agent/support.ts',
    line: 307,
    note: 'Traces below this floor are never weakened further by a failed quiz.',
    evidence: { sources: ['fuzz'], mass: null, note: 'A threshold the calibration samples could set.' }
  },
  {
    name: 'CONTENT_RECALL_FLOOR',
    class: 'tuning',
    value: 0.4,
    file: 'apps/web/src/teacher/agent/support.ts',
    line: 315,
    note: 'Content-overlap path answers production above this coverage.',
    evidence: { sources: ['fuzz'], mass: null, note: 'The comprehension floor for production cues.' }
  },
  {
    name: 'CONTENT_RECALL_MARGIN',
    class: 'tuning',
    value: 0.1,
    file: 'apps/web/src/teacher/agent/support.ts',
    line: 316,
    note: 'Coverage margin the content-overlap path requires.',
    evidence: { sources: ['fuzz'], mass: null, note: 'A separation threshold the data could set.' }
  },
  {
    name: 'SMF_WEIGHT',
    class: 'tuning',
    value: 0.5,
    file: 'packages/sentient-core/src/semantic/CompactMemoryBank.ts',
    line: 235,
    note: 'Weight of the SMF cosine term in the recall score.',
    evidence: { sources: ['fuzz'], mass: null, note: '§5.2 row 2: each term is a judge — weight = measured AUC on the fuzz bench.' }
  },
  {
    name: 'OVERLAP_WEIGHT',
    class: 'tuning',
    value: 0.5,
    file: 'packages/sentient-core/src/semantic/CompactMemoryBank.ts',
    line: 236,
    note: 'Weight of the amplitude-overlap term in the recall score.',
    evidence: { sources: ['fuzz'], mass: null, note: '§5.2 row 2: measured discriminative power on true-match vs distractor pairs.' }
  },
  {
    name: 'PHASE_WEIGHT',
    class: 'tuning',
    value: 0.15,
    file: 'packages/sentient-core/src/semantic/CompactMemoryBank.ts',
    line: 237,
    note: 'Weight of the phase order-parameter term (deliberately small).',
    evidence: { sources: ['fuzz'], mass: null, note: '§5.2 row 2: phase term weight 0.15 → measured AUC.' }
  },
  {
    name: 'COMPACT_PRUNE_STRENGTH',
    class: 'tuning',
    value: 0.25,
    file: 'packages/sentient-core/src/semantic/CompactMemoryBank.ts',
    line: 239,
    note: 'Strength below which an unconsolidated trace is prunable.',
    evidence: { sources: ['fuzz'], mass: null, note: 'A pruning threshold the retention data could set.' }
  },
  {
    name: 'COMPACT_MIN_ACCESS_COUNT',
    class: 'tuning',
    value: 3,
    file: 'packages/sentient-core/src/semantic/CompactMemoryBank.ts',
    line: 240,
    note: 'Access count for consolidation.',
    evidence: { sources: ['fuzz'], mass: null, note: 'A consolidation threshold the retrieval data could set.' }
  },
  {
    name: 'COMPACT_MIN_LOCK_STRENGTH',
    class: 'tuning',
    value: 0.7,
    file: 'packages/sentient-core/src/semantic/CompactMemoryBank.ts',
    line: 241,
    note: 'Strength floor for consolidation.',
    evidence: { sources: ['fuzz'], mass: null, note: 'A consolidation threshold the data could set.' }
  },
  {
    name: 'COMPACT_ENTROPY_LOCK_THRESHOLD',
    class: 'tuning',
    value: 0.9,
    file: 'packages/sentient-core/src/semantic/CompactMemoryBank.ts',
    line: 242,
    note: 'SMF entropy ceiling for consolidation.',
    evidence: { sources: ['fuzz'], mass: null, note: 'An entropy threshold the data could set.' }
  },
  {
    name: 'SMF_NEIGHBOR_COSINE',
    class: 'tuning',
    value: 0.7,
    file: 'packages/sentient-core/src/semantic/ShardedMemoryBank.ts',
    line: 55,
    note: 'SMF cosine at or above which two traces count as retrieval candidates.',
    evidence: { sources: ['fuzz'], mass: null, note: 'The neighborhood threshold the shard entropy metric reads.' }
  },
  {
    name: 'SHARD_SPLIT_ENTROPY_BITS',
    class: 'tuning',
    value: 5.0,
    file: 'packages/sentient-core/src/semantic/ShardedMemoryBank.ts',
    line: 446,
    note: 'Split threshold — a shard splits when H(T|P) exceeds this.',
    evidence: { sources: ['fuzz'], mass: null, note: 'The entropy ceiling the data (candidate spread) could set.' }
  },
  {
    name: 'SHARD_MIN_SPLIT_GAIN_BITS',
    class: 'tuning',
    value: 0.3,
    file: 'packages/sentient-core/src/semantic/ShardedMemoryBank.ts',
    line: 447,
    note: 'A split is accepted only when it measurably reduces entropy by this.',
    evidence: { sources: ['fuzz'], mass: null, note: 'The acceptance threshold the data could set.' }
  },
  {
    name: 'SHARD_REORGANIZE_BUDGET',
    class: 'tuning',
    value: 1.25,
    file: 'packages/sentient-core/src/semantic/ShardedMemoryBank.ts',
    line: 450,
    note: 'Reorganization entropy budget multiplier (soft; split hard).',
    evidence: { sources: ['fuzz'], mass: null, note: 'The budget the data could set.' }
  },
  {
    name: 'SHARD_REORGANIZE_EVERY_STORES',
    class: 'tuning',
    value: 48,
    file: 'packages/sentient-core/src/semantic/ShardedMemoryBank.ts',
    line: 454,
    note: 'Amortization interval — a split/merge attempt every N stores.',
    evidence: { sources: ['fuzz'], mass: null, note: 'The cadence the data could set.' }
  },
  {
    name: 'UNKNOWN_TOKEN_COST',
    class: 'tuning',
    value: 20,
    file: 'apps/web/src/teacher/mdl.ts',
    line: 15,
    note: 'MDL cost of an unseen token (bits).',
    evidence: { sources: ['math'], mass: null, note: '§5.2 row 6: −log2 unseen-word mass under Good–Turing over the deck.' }
  },
  {
    name: 'SLOT_COST',
    class: 'tuning',
    value: 15,
    file: 'apps/web/src/teacher/operators/learning.ts',
    line: 78,
    note: 'MDL slot annotation cost (bits) — the type of a hole.',
    evidence: { sources: ['math'], mass: null, note: '§5.2 row 5: −log2 P(slot position | shell grammar) from the operator library.' }
  },
  {
    name: 'DEFAULT_TOKEN_COST',
    class: 'tuning',
    value: 10,
    file: 'apps/web/src/teacher/operators/learning.ts',
    line: 81,
    note: 'Uniform token cost when no frequency model is supplied (bits).',
    evidence: { sources: ['math'], mass: null, note: 'Replaced by the Zipf cost model over the deck frequency order.' }
  },
  {
    name: 'COUNCIL_AGREEMENT_THRESHOLD',
    class: 'tuning',
    value: 0.6,
    file: 'apps/web/src/teacher/network.ts',
    line: 132,
    note: 'Council agreement threshold for an agreeing cluster.',
    evidence: { sources: ['chain', 'math'], mass: null, note: '§5.2 row 7: stop when edge-based response entropy stops falling.' }
  },
  {
    name: 'COUNCIL_GOAL_MISS_THRESHOLD',
    class: 'tuning',
    value: 2,
    file: 'apps/web/src/teacher/network.ts',
    line: 135,
    note: 'Recurring abstention misses before a goal forms.',
    evidence: { sources: ['chain', 'math'], mass: null, note: '§5.2 row 8: promote when the recurring deficit MDL gain is positive.' }
  },
  {
    name: 'COUNCIL_TRUST_GAIN',
    class: 'tuning',
    value: 0.2,
    file: 'apps/web/src/teacher/network.ts',
    line: 133,
    note: 'Trust gain per win in the agreeing cluster.',
    evidence: { sources: ['chain'], mass: null, note: 'A trust update magnitude the outcomes could set.' }
  },
  {
    name: 'COUNCIL_TRUST_PENALTY',
    class: 'tuning',
    value: 0.1,
    file: 'apps/web/src/teacher/network.ts',
    line: 134,
    note: 'Trust loss per failed/abstained outcome.',
    evidence: { sources: ['chain'], mass: null, note: 'A trust update magnitude the outcomes could set.' }
  },
  {
    name: 'FSRS_INITIAL_STABILITY',
    class: 'tuning',
    value: 1,
    file: 'apps/web/src/teacher/fsrs.ts',
    line: 18,
    note: 'Initial stability (days) of a freshly taught word.',
    evidence: { sources: ['fuzz', 'world-outcome'], mass: null, note: '§5.2 row 4: per-store stability learned from retrieval successes.' }
  },
  {
    name: 'FSRS_INITIAL_DIFFICULTY',
    class: 'tuning',
    value: 5,
    file: 'apps/web/src/teacher/fsrs.ts',
    line: 20,
    note: 'Initial difficulty in [1,10] — mid, no evidence yet.',
    evidence: { sources: ['fuzz', 'world-outcome'], mass: null, note: 'The prior the FSRS updates learn away.' }
  },
  {
    name: 'FSRS_OVERDUE_BONUS',
    class: 'tuning',
    value: 1,
    file: 'apps/web/src/teacher/fsrs.ts',
    line: 37,
    note: 'Surprise-scaled success-gain bonus coefficient.',
    evidence: { sources: ['fuzz', 'world-outcome'], mass: null, note: 'A gain shape the data could fit.' }
  },
  {
    name: 'FSRS_DIFFICULTY_SCALE',
    class: 'tuning',
    value: 8,
    file: 'apps/web/src/teacher/fsrs.ts',
    line: 39,
    note: 'Difficulty scale of the success gain (e^(−D/scale)).',
    evidence: { sources: ['fuzz', 'world-outcome'], mass: null, note: 'A gain shape the data could fit.' }
  },
  {
    name: 'FSRS_CONSOLIDATED_STABILITY',
    class: 'tuning',
    value: 30,
    file: 'apps/web/src/teacher/fsrs.ts',
    line: 41,
    note: 'Stability (days) beyond which a word reads consolidated.',
    evidence: { sources: ['fuzz', 'world-outcome'], mass: null, note: 'A band edge the data could set.' }
  },
  {
    name: 'STABILITY_NGRAM_WEIGHT_DAYS',
    class: 'tuning',
    value: 45,
    file: 'apps/web/src/teacher/retention.ts',
    line: 60,
    note: 'Composition n-gram decay preset (days).',
    evidence: { sources: ['fuzz', 'world-outcome'], mass: null, note: '§5.2 row 4: decay presets 7/45/90 → per-store stability.' }
  },
  {
    name: 'STABILITY_DRIVE_WEIGHT_DAYS',
    class: 'tuning',
    value: 90,
    file: 'apps/web/src/teacher/retention.ts',
    line: 63,
    note: 'Learned drive weight decay preset (days).',
    evidence: { sources: ['fuzz', 'world-outcome'], mass: null, note: '§5.2 row 4: decay presets 7/45/90 → per-store stability.' }
  },
  {
    name: 'STABILITY_NON_WORD_TRACE_DAYS',
    class: 'tuning',
    value: 7,
    file: 'apps/web/src/teacher/retention.ts',
    line: 67,
    note: 'Non-word trace decay preset (days).',
    evidence: { sources: ['fuzz', 'world-outcome'], mass: null, note: '§5.2 row 4: decay presets 7/45/90 → per-store stability.' }
  },
  {
    name: 'STABILITY_RULE_CORROBORATION_DAYS',
    class: 'tuning',
    value: 30,
    file: 'apps/web/src/teacher/retention.ts',
    line: 70,
    note: 'A rule\'s world credit horizon (days).',
    evidence: { sources: ['fuzz', 'world-outcome'], mass: null, note: 'The R16 horizon the data could set.' }
  },
  {
    name: 'TRUST_PSEUDO_COUNT',
    class: 'tuning',
    value: 4,
    file: 'apps/web/src/teacher/trust.ts',
    line: 42,
    note: 'Pseudo-count of the Bayesian smoothing — the pull of the prior.',
    evidence: { sources: ['fuzz', 'calibration'], mass: null, note: 'Smoothing strength the calibration data could estimate.' }
  },
  {
    name: 'BEHAVIOR_WEIGHT_LR',
    class: 'tuning',
    value: 0.1,
    file: 'apps/web/src/teacher/drives.ts',
    line: 62,
    note: 'Learning rate for a single drive outcome.',
    evidence: { sources: ['fuzz', 'world-outcome'], mass: null, note: 'A learning-rate magnitude the outcomes could fit.' }
  },
  {
    name: 'GOAL_CURRICULUM_BOOST',
    class: 'tuning',
    value: 0.5,
    file: 'apps/web/src/teacher/plan.ts',
    line: 325,
    note: 'Curriculum signal boost toward a chosen goal.',
    evidence: { sources: ['fuzz', 'world-outcome'], mass: null, note: 'A blend weight the data could set.' }
  },
  {
    name: 'MIN_POSITIVE_STRENGTH',
    class: 'tuning',
    value: 0.5,
    file: 'apps/web/src/teacher/contradictions.ts',
    line: 36,
    note: 'A positive edge below this no longer asserts in the sweep.',
    evidence: { sources: ['fuzz'], mass: null, note: 'A threshold the contradiction outcomes could set.' }
  },
  {
    name: 'ECHO_THRESHOLD',
    class: 'tuning',
    value: 0.8,
    file: 'apps/web/src/teacher/grounding.ts',
    line: 39,
    note: 'Grounding threshold — below this a composition reads as echoing seeds.',
    evidence: { sources: ['fuzz'], mass: null, note: 'The fabrication threshold the grounding bench reads.' }
  },
  {
    name: 'CDE_REGIME_TOP_TWO_MARGIN',
    class: 'tuning',
    value: 0.17,
    file: 'apps/web/src/teacher/cde.ts',
    line: 196,
    note: 'Candidate-distribution regime threshold: m ≥ this reads clear (one dominant candidate).',
    evidence: {
      sources: ['fuzz', 'adversarial'],
      mass: 16,
      note: 'Calibrated from cde-bench: flat class (adversarial probes) m ∈ [0.011, 0.044], clear class (exact deck recall) m ∈ [0.293, 0.436]; threshold = gap midpoint. Regime labels are measurement only — Phase A refuted the routing (no variant beats the top score on fuzz AUC).'
    }
  },
  {
    name: 'CDE_REGIME_TOP_TWO_THREE_MARGIN',
    class: 'tuning',
    value: 0.2,
    file: 'apps/web/src/teacher/cde.ts',
    line: 197,
    note: 'Candidate-distribution regime threshold: m₂₃ ≥ this reads disambiguate (two dominant candidates).',
    evidence: {
      sources: ['fuzz', 'adversarial'],
      mass: null,
      note: 'Placeholder: cde-bench found NO two-dominant-candidate corpus (measured m₂₃ overlaps between classes, exact [0.008, 0.119] vs. adversarial [0.007, 0.033]); stays permissive until a disambiguation corpus exists.'
    }
  },
  {
    name: 'SLOW_CONTEXT_STABILITY_TURNS',
    class: 'tuning',
    value: 2,
    file: 'apps/web/src/observer/options.ts',
    line: 30,
    note: 'Slow context (E.2 §6.2) retention stability in turns — the per-turn decay factor is R(1; S) under the one retention law.',
    evidence: {
      sources: ['fuzz', 'llm-grade'],
      mass: null,
      note: 'E.2 §6.2 / priming-bench: primed resolution must rise with contamination 0 on fuzz/honesty probes; any probe lost keeps the flag off.'
    }
  },
  {
    name: 'SLOW_CONTEXT_BLEND_WEIGHT',
    class: 'tuning',
    value: 0.15,
    file: 'apps/web/src/observer/options.ts',
    line: 32,
    note: 'Slow context (E.2 §6.2) recall-cue blend weight — a bounded direction tilt (core clamps to [0, 0.5]), never a magnitude override.',
    evidence: {
      sources: ['fuzz', 'llm-grade'],
      mass: null,
      note: 'E.2 §6.2 / priming-bench: the tilt must raise primed resolution without flipping a single unrelated probe (contamination 0).'
    }
  },
  {
    name: 'PER_STORE_STABILITY_LEARNED',
    class: 'tuning',
    value: 0,
    file: 'apps/web/src/teacher/retention.ts',
    line: 118,
    note: '0 = the decay presets 7/45/90/30 are the CONTROL; 1 = each store\'s stability is learned from that store\'s own retrieval outcomes under the FSRS update law (the preset is the prior the updates learn away from).',
    evidence: { sources: ['fuzz', 'world-outcome'], mass: null, note: '§5.2 row 4: per-store stability exactly as FSRS learns per-word stability; the law-shape (success stretches, failure shrinks) is pinned per store by the programmatic storeStability bench, including parity with the FSRS update constants.' }
  },
  {
    name: 'MDL_UNKNOWN_COST_MEASURED',
    class: 'tuning',
    value: 0,
    file: 'apps/web/src/teacher/mdl.ts',
    line: 35,
    note: '0 = the 20-bit unknown-token cost is the CONTROL; 1 = −log₂ of the unseen-word mass under a Good–Turing estimate over the deck frequency table.',
    evidence: { sources: ['math', 'fuzz'], mass: null, note: '§5.2 row 6: Good–Turing over the deck; the programmatic mdl bench pins the estimate finite and drifting correctly (unseen mass falls, cost rises) as the deck grows.' }
  },
  {
    name: 'MDL_SLOT_COST_MEASURED',
    class: 'tuning',
    value: 0,
    file: 'apps/web/src/teacher/mdl.ts',
    line: 35,
    note: '0 = the 15-bit slot annotation cost is the CONTROL; 1 = −log₂ P(slot position | shell grammar) estimated from the learned-operator library\'s templates.',
    evidence: { sources: ['math', 'fuzz'], mass: null, note: '§5.2 row 5: the library\'s own statistics, Good–Turing smoothed; the programmatic mdl bench pins the estimate finite and matching the empirical position rates.' }
  },
  {
    name: 'COUNCIL_GOAL_MDL_PROMOTION',
    class: 'tuning',
    value: 0,
    file: 'apps/web/src/teacher/network.ts',
    line: 323,
    note: '0 = the 2-miss goal threshold is the CONTROL; 1 = promote a goal when the recurring deficit\'s MDL gain as a goal is positive (a goal that saves more asks than it costs).',
    evidence: { sources: ['chain', 'math'], mass: null, note: '§5.2 row 8: the same criterion as operators; the programmatic goalMdl bench pins promotion occurring only at positive gain.' }
  },
  {
    name: 'WORLD_WEIGHT_MEASURED',
    class: 'tuning',
    value: 0,
    file: 'apps/web/src/teacher/trust.ts',
    line: 72,
    note: '0 = the 0.25 world-feedback weight is the CONTROL; 1 = the world channel\'s measured agreement with ground truth via the trust kernel\'s bucket machinery (Wilson lower bound at prior 0).',
    evidence: { sources: ['fuzz', 'world-outcome'], mass: null, note: '§5.2 row 9: measured by the trust kernel itself; the programmatic trust bench pins the measured weight bounded and evidence-responsive.' }
  },
  {
    name: 'ELABORATION_MARGINAL_SCORE_FLOOR',
    class: 'tuning',
    value: 0.6,
    file: 'apps/web/src/teacher/elaboration.ts',
    line: 190,
    note: '§8.1: the frontier stop engages when the best remaining claim\'s marginal score falls below this floor — the elaboration stopping criterion, not a fixed depth budget.',
    evidence: { sources: ['fuzz', 'adversarial'], mass: null, note: '§8 elaboration-bench: 0 fabrications at every depth, redundancy falls as the stop engages; the floor is the knob the bench measures.' }
  },
  {
    name: 'ELABORATION_TRACE_RECALL_FLOOR',
    class: 'tuning',
    value: 0.25,
    file: 'apps/web/src/teacher/elaboration.ts',
    line: 205,
    note: '§8.4: the recall score at which a stored elaboration resolves a re-ask; below it the elaboration is re-searched.',
    evidence: { sources: ['fuzz', 'adversarial'], mass: null, note: '§8 elaboration-trace-bench: stored elaborations recall on re-ask and decay under the retention law like ordinary traces.' }
  },
  {
    name: 'CONTEXT_SENSE_SPLIT_ENABLED',
    class: 'tuning',
    value: 0,
    file: 'apps/web/src/teacher/senseModel.ts',
    line: 399,
    note: '0 = the context-bimodality split induction (F.4 / §7.4) is OFF (the control — only supplied senses are used); 1 = a trace whose context-prime distribution is bimodal splits when the entropy reduction exceeds the new sense node\'s cost.',
    evidence: { sources: ['fuzz', 'adversarial'], mass: null, note: '§7.4 sense-split-bench: the rule recovers the known sense splits with 0 splits on the monosemous control; the flag earns itself on that measurement.' }
  },
  {
    name: 'CONCEPT_SYNTHESIS_ENABLED',
    class: 'tuning',
    value: 0,
    file: 'apps/web/src/teacher/agent/relations.ts',
    line: 98,
    note: '0 = MDL concept synthesis (§9) is OFF (the control); 1 = induced concepts enter the hypothesis tier, answer hedged, promote on corroboration, stop on two world denials.',
    evidence: { sources: ['fuzz', 'chain'], mass: null, note: '§9 hypernym-recovery-bench: recovery 1.00 vs shuffle-chance 0.00 with 0 false-inheritance in asserted speech; the flag gates the tier integration.' }
  }
] as const;

// ────────────────────────────────────────────────────────────────────────────
// Classification helpers
// ────────────────────────────────────────────────────────────────────────────

export function constantsByClass(cls: ConstantClass): ConstantEntry[] {
  return CONSTANTS.filter((c) => c.class === cls);
}

export function tuningConstants(): ConstantEntry[] {
  return constantsByClass('tuning');
}

// ────────────────────────────────────────────────────────────────────────────
// D.10 — the circularity guard
// ────────────────────────────────────────────────────────────────────────────

/**
 * A self-tuning gate must have at least one programmatic bench (fuzz, chain,
 * adversarial, math) in its evidence. LLM grades, world outcomes, and
 * calibration samples are themselves measured against those benches, so a
 * gate whose only evidence is LLM grades would be tuning on a composite that
 * flatters itself — the loop §5.4 forbids. Throws on a gate with no
 * programmatic anchor.
 */
export function assertProgrammaticAnchor(tuning: TuningEvidence): void {
  const anchored = tuning.sources.some((source) => PROGRAMMATIC_BENCHES.has(source));
  if (!anchored) {
    throw new Error(
      `self-tuning gate is not anchored: evidence sources [${tuning.sources.join(', ')}] ` +
        'contain no programmatic bench (fuzz/chain/adversarial/math) — a gate whose only ' +
        'evidence is LLM grades must not self-tune'
    );
  }
}

/** Apply the guard to every tuning entry in the registry; throws on the first
 *  un-anchored gate. The report CLI and tests call this as the tripwire. */
export function assertAllAnchored(): void {
  for (const entry of tuningConstants()) {
    if (entry.evidence === undefined) {
      throw new Error(`tuning constant ${entry.name} has no evidence recorded`);
    }
    assertProgrammaticAnchor(entry.evidence);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Export / drift — the tripwire record
// ────────────────────────────────────────────────────────────────────────────

/** One tuned value as it is written into an exported record. */
export interface TunedConstantSnapshot {
  name: string;
  value: number;
  evidenceMass: number | null;
  sources: readonly EvidenceSource[];
}

/** The tuned-constant slice of an exported record (additive, versioned). */
export interface ConstantsExport {
  version: 1;
  exportedAt: string;
  tuned: TunedConstantSnapshot[];
}

/** Build the snapshot of the registry's current tuning values + evidence mass. */
export function exportTunedConstants(now = new Date()): ConstantsExport {
  return {
    version: 1,
    exportedAt: now.toISOString(),
    tuned: tuningConstants().map((entry) => ({
      name: entry.name,
      value: entry.value,
      evidenceMass: entry.evidence?.mass ?? null,
      sources: entry.evidence?.sources ?? []
    }))
  };
}

/** Read a tuned-constant snapshot from an exported record. Tolerates either
 *  a bare export JSON (`{ constantsExport }`) or a bootstrap record carrying
 *  the slice under `learningState.constantsExport`. Returns null when the
 *  record carries no snapshot. */
export function readConstantsExport(record: unknown): ConstantsExport | null {
  if (typeof record !== 'object' || record === null) return null;
  const top = (record as { constantsExport?: unknown }).constantsExport;
  if (isConstantsExport(top)) return top;
  const learningState = (record as { learningState?: { constantsExport?: unknown } }).learningState;
  if (learningState !== undefined && isConstantsExport(learningState.constantsExport)) {
    return learningState.constantsExport;
  }
  return null;
}

function isConstantsExport(value: unknown): value is ConstantsExport {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ConstantsExport>;
  return candidate.version === 1 && Array.isArray(candidate.tuned);
}

export interface DriftEntry {
  name: string;
  current: number;
  exported: number | null;
  delta: number | null;
}

/** Compare the registry's current tuning values against a snapshot. A tuning
 *  constant absent from the snapshot reports `exported`/`delta` null. */
export function driftAgainst(exported: ConstantsExport): DriftEntry[] {
  const byName = new Map(exported.tuned.map((t) => [t.name, t]));
  return tuningConstants().map((entry) => {
    const prior = byName.get(entry.name);
    return {
      name: entry.name,
      current: entry.value,
      exported: prior?.value ?? null,
      delta: prior === undefined ? null : entry.value - prior.value
    };
  });
}
