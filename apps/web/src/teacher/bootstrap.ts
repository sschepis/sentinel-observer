import type { SerializedTrace } from '@sschepis/sentient-core';
import type { WordState, CompiledRule, AnswerGradeEntry } from './TeacherAgent';
import type { Relation, Negation } from './relations';
import { SEMANTIC_VOCABULARY_SCHEME } from './semanticSignature';

export const BOOTSTRAP_VERSION = 2 as const;
export const BOOTSTRAP_VOCABULARY_SCHEME = SEMANTIC_VOCABULARY_SCHEME;

/**
 * The bootstrap learning record: a complete, serializable snapshot of the
 * observer's learned state, produced headlessly by the batch trainer CLI and
 * imported by the app (`TeacherAgent.importBootstrap`). The record uses the
 * same serialized-trace shape as persistence, so the browser restores it
 * identically to a normal IndexedDB restore.
 */

export type BootstrapWordState = Pick<
  WordState,
  | 'traceId'
  | 'taughtAt'
  | 'lastAskedAt'
  | 'lastGrade'
  | 'successes'
  | 'failures'
  | 'strengthHistory'
  | 'stability'
  | 'difficulty'
  | 'dueAt'
  | 'lastIntervalDays'
> & { word: string };

export interface BootstrapDefinition {
  word: string;
  definition: string;
  example: string;
}

export interface BootstrapRecord {
  version: typeof BOOTSTRAP_VERSION;
  vocabularyScheme: typeof BOOTSTRAP_VOCABULARY_SCHEME;
  /** Record encoding marker. 'q16' = amplitudes quantized to uint16
   *  fixed-point (dequantized on import); absent = legacy float amplitudes. */
  encoding?: 'q16';
  /** The field's full prime basis, stored ONCE per record (every trace
   *  carried the identical 256-prime array — ~1KB × 20k traces of pure
   *  redundancy). Traces in a deduped record reference this basis. */
  primeBasis?: number[];
  /** The curriculum deck the record was trained on (e.g. 'en-1000'). */
  deck: string;
  generatedAt: string;
  source: {
    /** The taught words, in training order. */
    words: string[];
    /** Whether the conversation phrase deck was included. */
    conversation: boolean;
    /** Whether definitions were filled by the LLM at training time. */
    definitionsFilled: boolean;
  };
  traces: SerializedTrace[];
  wordStates: BootstrapWordState[];
  definitions: BootstrapDefinition[];
  /** Chaperone-supplied typed edges (origin: 'chaperone'), reconciled on
   *  import — the relations pass of `--fill-definitions`. */
  relations?: Relation[];
  /** Executable DSL rules induced from drills (P2), recompiled on import. */
  compiledRules?: CompiledRule[];
  /** The bounded per-answer grade ledger (P7), restored on import. */
  answerGrades?: AnswerGradeEntry[];
  /** The world-feedback credit map (P7), restored on import. */
  authoredAnswers?: Array<{ utterance: string; traceIds: string[]; at: number }>;
  /** The per-edge confidence overlay (P8), restored on import. */
  edgeConfidence?: Record<string, number>;
  /** The confirmed-false store (P8), restored on import. */
  negations?: Negation[];
  /** The contradiction-sweep resolution ledger — conflict ids the world has
   *  resolved. One-shot: a resolved conflict is never re-reported, so the
   *  ledger must survive reloads exactly like the negations it settled. */
  resolvedSweepConflicts?: string[];
  /** Learned arbitration weights (absent = archetypal defaults). */
  driveWeights?: Record<string, number>;
  /** Per-goal-type completion history (absent = no goal experience). */
  goalHistory?: Record<string, { completed: number; abandoned: number }>;
  /** The FULL higher-order learning state (composition transition weights,
   *  behavior outcome history, fade-state λ, exposure counters) — so a
   *  headlessly-trained record handed to the web restores the entire
   *  teacher, not just its memory. */
  learningState?: {
    compositionWeights?: Record<string, number>;
    behaviorOutcomes?: Record<string, { wins: number; losses: number }>;
    fadeState?: { agreement: Record<string, number | null>; lambda: Record<string, number> };
    exposureCounts?: Record<string, number>;
    encounterCounts?: Record<string, number>;
    /** Taught cues the observer has actually spoken — the numerator of
     *  recall competency. Without it an imported record reads 0% recall and
     *  creative mode can never unlock. */
    producedCues?: string[];
    /** Last recall confidence per produced cue. */
    cueConfidence?: Record<string, number>;
    bootstrapImportedMeta?: { generatedAt: string; words: number } | null;
  };
}