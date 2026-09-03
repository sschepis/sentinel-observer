/**
 * PERSISTENCE FACULTY - persist/restore/bootstrap import-export (agent split
 * refactor).
 *
 * The write path (chained, debounced, coalesced full-record saves + explicit
 * flush/persistAll), the restore path (word states + traces rebuilt into the
 * live state), and the bootstrap record import/export (the shipped deploy).
 * State (persistence, persistEvery, persistCounter, persistChain,
 * persistTimer, dirtySince, bootstrapImportedMeta) lives on TeacherAgentCore.
 */
import { TeacherAgentCore, type Constructor, type CrossFacultyApi } from './base';
import {
  FSRS_INITIAL_STABILITY,
  FSRS_INITIAL_DIFFICULTY
} from '../fsrs';
import {
  bumpAgedWeights,
  type WeightMeta
} from '../agedWeights';
import {
  type GoalType
} from '../plan';
import {
  REVIEW_HISTORY_CAP
} from '../curriculum';
import {
  isSourceClass,
  type Relation,
  type RelationPredicate,
  type Negation,
  type SourceClass
} from '../relations';
import {
  type ReliabilitySnapshot
} from '../reliability';
import {
  type DSLExpr
} from '../technical/dsl';
import {
  type DerivationDenial,
  type RewriteRule
} from '../rules/types';
import {
  type BehaviorOption,
  type BehaviorWeights
} from '../drives';
import {
  EpisodicMemory
} from '../episodic';
import {
  BOOTSTRAP_VERSION,
  BOOTSTRAP_MIN_SUPPORTED_VERSION,
  BOOTSTRAP_VOCABULARY_SCHEME,
  type BootstrapRecord
} from '../bootstrap';
import {
  CREATIVE_REINFORCE_SCORE,
  PERSIST_DEBOUNCE_MS,
  PERSIST_MAX_DELAY_MS,
  isTouchedWordState,
  ANSWER_GRADES_CAP,
  CREATIVE_GRADE_DELTA,
  isStaleEncoding,
  type CompiledRule,
  type WordState,
  type EdgeRef,
  type AnswerGradeEntry
} from './support';

export function PersistenceMixin<TBase extends Constructor<TeacherAgentCore & CrossFacultyApi>>(Base: TBase) {
  return class PersistenceFaculty extends Base {

    /**
     * Restore the observer's learning record from persistence: memory traces
     * go back into its memory bank (same ids, strengths and counters), word
     * states rebind to them.
     *
     * Encoding-epoch migration: traces from before the focused-encoding era
     * carry FLAT amplitude profiles (the old lesson-text excitation spread
     * across the whole basis) and near-identity SMFs — restoring them would
     * poison recall. The detector inspects the DATA, not a marker (a marker
     * can be re-badged by a later persist; flat data cannot hide). Stale
     * words are reset to 'new' so the teacher re-teaches them.
     */
    async restoreFromPersistence(): Promise<{ restored: number; stale: number }> {
      if (this.persistence === null) return { restored: 0, stale: 0 };
      const [traces, states, learningState] = await Promise.all([
        this.persistence.loadTraces(),
        this.persistence.loadWordStates(),
        this.persistence.loadLearningState()
      ]);

      const bank = this.session.observer.getMemoryBank();
      const staleTraceIds = new Set<string>();
      let restored = 0;
      // The vocabulary-scheme check guards against a MISMATCHED encoding basis.
      // A MISSING learningState (pre-v4 IndexedDB, or a saveLearningState that
      // failed while saveTraces succeeded — they run as concurrent siblings) is
      // NOT evidence of a mismatch: those traces were written by this app under
      // this scheme, and declaring them all stale silently wipes the record on
      // the next persist (H6). When the scheme is unknown, the per-trace
      // isStaleEncoding check is the only guard — it already separates the
      // pre-focused era by encoding shape.
      const schemeKnown =
        learningState !== null &&
        learningState !== undefined &&
        learningState.vocabularyScheme !== undefined;
      const persistenceCompatible =
        traces.length === 0 ||
        !schemeKnown ||
        learningState.vocabularyScheme === BOOTSTRAP_VOCABULARY_SCHEME;

      for (const data of traces) {
        if (!persistenceCompatible || isStaleEncoding(data)) {
          staleTraceIds.add(data.id);
          continue;
        }
        const trace = bank.restoreTrace(data);
        if (trace !== null) {
          restored += 1;
          if (trace.metadata?.kind === 'conversation' && typeof trace.metadata.cue === 'string') {
            this.conversationTraceIds.add(trace.id);
            this.taughtConversationCues.add(trace.metadata.cue);
          }
          if (trace.metadata?.kind === 'creative') {
            this.creativeMemoryIds.add(trace.id);
          }
          if (trace.metadata?.kind === 'gap' && typeof trace.metadata.uttered === 'string') {
            this.gapUtterances.add(trace.metadata.uttered);
            this.gapMissCounts.set(trace.metadata.uttered, 1);
            this.gapTraceIds.add(trace.id);
          }
          if (trace.metadata?.kind === 'belief') {
            // Rebuild the dedup set so beliefs never re-fire after restore.
            const beliefKind = String(trace.metadata.beliefKind ?? '');
            const about = String(trace.metadata.about ?? '');
            if (about.length > 0) this.beliefsStored.add(`${beliefKind}:${about}`);
          }
          if (trace.metadata?.kind === 'goal') {
            this.storeGoalIfNewInStatic(trace);
          }
        }
      }

      this.rebuildLearnedOperators();
      this.rebuildCompositionWeightsFromMemory();

      if (states !== null) {
        for (const state of states) {
          const current = this.states.get(state.word.word);
          if (!current) continue;
          // Words bound to stale (pre-encoding) traces are re-learned from
          // scratch; their historical grade counts reset with them.
          if (state.traceId !== null && staleTraceIds.has(state.traceId)) {
            current.traceId = null;
            current.taughtAt = null;
            current.lastAskedAt = null;
            current.lastGrade = null;
            current.successes = 0;
            current.failures = 0;
            current.reviewHistory = [];
            continue;
          }
          current.traceId = state.traceId;
          current.taughtAt = state.taughtAt;
          current.lastAskedAt = state.lastAskedAt;
          current.lastGrade = state.lastGrade;
          current.successes = state.successes;
          current.failures = state.failures;
          current.strengthHistory = Array.isArray(state.strengthHistory) ? state.strengthHistory : [];
          // P9: FSRS state rides the word states; old records default to the
          // fresh-word curve (their dueAt is reset so they review promptly).
          current.stability = typeof state.stability === 'number' && state.stability > 0 ? state.stability : FSRS_INITIAL_STABILITY;
          current.difficulty = typeof state.difficulty === 'number' ? state.difficulty : FSRS_INITIAL_DIFFICULTY;
          current.dueAt = typeof state.dueAt === 'number' ? state.dueAt : Date.now();
          current.lastIntervalDays = typeof state.lastIntervalDays === 'number' ? state.lastIntervalDays : null;
          // P-curriculum: records written before the review history existed
          // default to empty — the repeated-gap signal starts from zero.
          current.reviewHistory = Array.isArray(state.reviewHistory)
            ? (state.reviewHistory as Array<'correct' | 'wrong'>).filter((o) => o === 'correct' || o === 'wrong').slice(-REVIEW_HISTORY_CAP)
            : [];
        }
      }

      // P9 wall-clock forgetting: strength is the MODEL's retention prediction
      // at the elapsed interval (the per-word FSRS curve). Runs AFTER the word
      // states bind, so each trace decays on ITS stability — time passed while
      // the observer was away decays exactly what the model predicts.
      this.applyRetention(Date.now());

      // EPISODIC MEMORY: the salient-facts journal survives restarts. A store
      // failure degrades to a fresh memory (the chat degrades to session-only
      // context, reported honestly — the same contract as the other layers).
      try {
        const episodicSnapshot = await this.persistence.loadEpisodicMemory();
        if (episodicSnapshot !== null) this.episodic.deserialize(episodicSnapshot);
      } catch (error) {
        console.warn('episodic-memory restore failed — starting fresh', error);
      }

      // THE FULL LEARNING STATE: the deliberative layers must survive a
      // reload — composition weights (its tiny language model, so fluency
      // survives and the handover does not reset to scaffolded), drive
      // weights, goal history, the fade state, and the exposure counters.
      try {
        if (persistenceCompatible && learningState !== null) {
          if (typeof learningState.compositionWeights === 'object' && learningState.compositionWeights !== null) {
            this.compositionWeights.clear();
            for (const [key, value] of Object.entries(learningState.compositionWeights as Record<string, number>)) {
              this.compositionWeights.set(key, value);
            }
          }
          // L3 (19.2/19.3): adopt the decay clocks when present; a legacy
          // record without them starts every clock at the first decay sweep.
          if (typeof learningState.compositionWeightMeta === 'object' && learningState.compositionWeightMeta !== null) {
            this.compositionWeightMeta.clear();
            for (const [key, value] of Object.entries(learningState.compositionWeightMeta as Record<string, number>)) {
              if (Number.isFinite(value)) this.compositionWeightMeta.set(key, value);
            }
          }
          if (typeof learningState.behaviorOutcomeAt === 'object' && learningState.behaviorOutcomeAt !== null) {
            for (const [key, value] of Object.entries(learningState.behaviorOutcomeAt as Record<string, number>)) {
              if (Number.isFinite(value)) this.behaviorOutcomeAt.set(key as BehaviorOption, value);
            }
          }
          // Phase 24.3 (additive): calibration evidence survives reloads.
          if (typeof learningState.calibration === 'object' && learningState.calibration !== null) {
            this.calibration.restore(learningState.calibration);
          }
          if (typeof learningState.behaviorWeights === 'object' && learningState.behaviorWeights !== null) {
            this.behaviorWeights = { ...(learningState.behaviorWeights as BehaviorWeights) };
          }
          if (typeof learningState.behaviorOutcomes === 'object' && learningState.behaviorOutcomes !== null) {
            const outcomes = learningState.behaviorOutcomes as Record<BehaviorOption, { wins: number; losses: number }>;
            for (const option of Object.keys(this.behaviorOutcomes) as BehaviorOption[]) {
              const record = outcomes[option];
              if (record !== undefined) {
                this.behaviorOutcomes[option] = { wins: record.wins, losses: record.losses };
              }
            }
          }
          if (typeof learningState.goalHistory === 'object' && learningState.goalHistory !== null) {
            for (const [type, record] of Object.entries(learningState.goalHistory as Record<string, { completed: number; abandoned: number }>)) {
              const key = type as GoalType;
              if (key in this.goalHistory) {
                this.goalHistory[key] = { completed: record.completed, abandoned: record.abandoned };
              }
            }
          }
          if (typeof learningState.fadeState === 'object' && learningState.fadeState !== null) {
            // L2 (20.4) MIGRATION: λ is no longer stored — it is derived from
            // the trust kernel. A legacy record's earned λ is preserved by
            // seeding equivalent kernel evidence, so teacher-dependence does
            // NOT reset to scaffolded on upgrade.
            this.seedLegacyFadeState(learningState.fadeState as { lambda?: Record<string, number> });
          }
          if (typeof learningState.exposureCounts === 'object' && learningState.exposureCounts !== null) {
            this.exposureCounts.clear();
            for (const [word, value] of Object.entries(learningState.exposureCounts as Record<string, number>)) {
              this.exposureCounts.set(word, value);
            }
          }
          if (typeof learningState.encounterCounts === 'object' && learningState.encounterCounts !== null) {
            this.encounterCounts.clear();
            for (const [word, value] of Object.entries(learningState.encounterCounts as Record<string, number>)) {
              this.encounterCounts.set(word, value);
            }
          }
          if (typeof learningState.drillFailures === 'object' && learningState.drillFailures !== null) {
            // P-curriculum: the weak-drill signal survives reloads — a concept
            // that kept failing drills yesterday is still weak today.
            this.drillFailures.clear();
            for (const [concept, value] of Object.entries(learningState.drillFailures as Record<string, unknown>)) {
              if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
                this.drillFailures.set(concept, Math.floor(value));
              }
            }
          }
          if (Array.isArray(learningState.relations)) {
            // Chaperone edges survive reloads: they were reconciled and tagged
            // on ingestion, and re-tagging on restore keeps provenance honest.
            this.chaperoneRelations = (learningState.relations as Array<Partial<Relation>>)
              .filter((r) => typeof r?.subject === 'string' && typeof r?.predicate === 'string' && typeof r?.object === 'string')
              .map((r) => ({
                subject: r.subject as string,
                predicate: r.predicate as Relation['predicate'],
                object: r.object as string,
                source: typeof r.source === 'string' ? r.source : '',
                origin: 'chaperone' as const
              }));
          }
          // M5 (22.5): the standing hypothesis tier (absent on legacy records —
          // the next relations rebuild re-proposes from the loose extraction).
          if (Array.isArray(learningState.hypothesisEdges)) {
            this.hypothesisEdges = (learningState.hypothesisEdges as Array<Partial<Relation>>)
              .filter((r) => typeof r?.subject === 'string' && typeof r?.predicate === 'string' && typeof r?.object === 'string')
              .map((r) => ({
                subject: r.subject as string,
                predicate: r.predicate as Relation['predicate'],
                object: r.object as string,
                source: typeof r.source === 'string' ? r.source : '',
                origin: (typeof r.origin === 'string' ? r.origin : 'regex') as Relation['origin'],
                sourceClasses: Array.isArray(r.sourceClasses) ? r.sourceClasses.filter(isSourceClass) : undefined,
                tier: 'hypothesis' as const
              }));
          }
          if (Array.isArray(learningState.compiledRules)) {
            // Executable drill rules survive reloads; malformed entries are
            // dropped loudly-free (a program that cannot parse is not a rule).
            this.compiledRules = (learningState.compiledRules as Array<Partial<CompiledRule>>)
              .filter(
                (r) =>
                  typeof r?.id === 'string' &&
                  typeof r?.concept === 'string' &&
                  typeof r?.drill === 'string' &&
                  typeof r?.program === 'object' &&
                  r?.program !== null &&
                  'op' in (r.program as object)
              )
              .map((r) => ({
                id: r.id as string,
                concept: r.concept as string,
                drill: r.drill as string,
                program: r.program as DSLExpr,
                nodes: typeof r.nodes === 'number' ? r.nodes : 0,
                bits: typeof r.bits === 'number' ? r.bits : 0,
                trainCount: typeof r.trainCount === 'number' ? r.trainCount : 0,
                instanceBits: typeof r.instanceBits === 'number' ? r.instanceBits : 0
              }));
          }
          if (Array.isArray(learningState.rewriteRules)) {
            // R5: LEARNED rewrite rules survive reloads (the authored decks are
            // code, re-seeded every construction). Malformed rules are dropped.
            for (const rule of learningState.rewriteRules as Array<Partial<RewriteRule>>) {
              if (
                typeof rule?.id === 'string' &&
                typeof rule?.name === 'string' &&
                typeof rule?.lhs === 'object' &&
                rule?.lhs !== null &&
                typeof rule?.rhs === 'object' &&
                rule?.rhs !== null
              ) {
                try {
                  this.ruleStore.register({
                    id: rule.id,
                    name: rule.name,
                    lhs: rule.lhs as RewriteRule['lhs'],
                    rhs: rule.rhs as RewriteRule['rhs'],
                    origin: rule.origin === 'induced' || rule.origin === 'taught' || rule.origin === 'chaperone' || rule.origin === 'consolidated' ? rule.origin : 'induced',
                    strength: typeof rule.strength === 'number' ? rule.strength : 1,
                    sourceClasses: Array.isArray(rule.sourceClasses) ? rule.sourceClasses.filter((c) => typeof c === 'string') : [],
                    bits: typeof rule.bits === 'number' ? rule.bits : 0,
                    evidence: typeof rule.evidence === 'number' ? rule.evidence : undefined,
                    schema: rule.schema === 'structural' || rule.schema === 'measure' || rule.schema === 'accessor' || rule.schema === 'search' || rule.schema === 'scalar' ? rule.schema : undefined,
                    active: rule.active !== false,
                    createdAt: typeof rule.createdAt === 'number' ? rule.createdAt : 0,
                    useCount: typeof rule.useCount === 'number' ? rule.useCount : 0,
                    lastUsedAt: typeof rule.lastUsedAt === 'number' ? rule.lastUsedAt : undefined
                  });
                } catch {
                  // An unregisterable rule is not a rule — dropped.
                }
              }
            }
          }
          if (Array.isArray(learningState.rewriteDenials)) {
            for (const denial of learningState.rewriteDenials as Array<Partial<DerivationDenial>>) {
              if (typeof denial?.ruleId === 'string') {
                this.ruleStore.recordDenial({
                  ruleId: denial.ruleId,
                  input: typeof denial.input === 'string' ? denial.input : undefined,
                  output: typeof denial.output === 'string' ? denial.output : undefined,
                  expected: typeof denial.expected === 'string' ? denial.expected : undefined,
                  evidence: denial.evidence === 'taught' || denial.evidence === 'verified-wrong' ? denial.evidence : 'graded-wrong',
                  at: typeof denial.at === 'number' ? denial.at : 0
                });
              }
            }
          }
          if (Array.isArray(learningState.ruleResolutions)) {
            this.ruleResolutions.clear();
            for (const id of learningState.ruleResolutions as unknown[]) {
              if (typeof id === 'string') this.ruleResolutions.add(id);
            }
          }
          if (typeof learningState.rewriteRuleStats === 'object' && learningState.rewriteRuleStats !== null) {
            for (const [id, stats] of Object.entries(learningState.rewriteRuleStats as Record<string, unknown>)) {
              const rule = this.ruleStore.get(id);
              if (rule === undefined || typeof stats !== 'object' || stats === null) continue;
              const entry = stats as Partial<{ uses: number; lastUsedAt: number }>;
              if (typeof entry.uses === 'number') rule.useCount = entry.uses;
              if (typeof entry.lastUsedAt === 'number') rule.lastUsedAt = entry.lastUsedAt;
            }
          }
          if (Array.isArray(learningState.answerGrades)) {
            // The grade ledger survives reloads — malformed entries are dropped.
            this.answerGrades = (learningState.answerGrades as Array<Partial<AnswerGradeEntry>>)
              .filter((g) => typeof g?.at === 'number' && typeof g?.utterance === 'string' && Array.isArray(g.traceIds))
              .slice(-ANSWER_GRADES_CAP)
              .map((g) => ({
                at: g.at as number,
                utterance: g.utterance as string,
                mode: typeof g.mode === 'string' ? g.mode : 'unknown',
                verdict: (g.verdict as AnswerGradeEntry['verdict']) ?? 'neutral',
                traceIds: (g.traceIds as string[]).filter((id) => typeof id === 'string'),
                edges: Array.isArray(g.edges)
                  ? (g.edges as EdgeRef[]).filter((e) => typeof e?.subject === 'string' && typeof e?.object === 'string')
                  : [],
                operatorId: typeof g.operatorId === 'string' ? g.operatorId : undefined,
                ruleIds: Array.isArray(g.ruleIds) ? g.ruleIds.filter((id): id is string => typeof id === 'string') : undefined
              }));
          }
          if (Array.isArray(learningState.authoredAnswers)) {
            // The world-feedback credit map survives reloads (P7).
            this.authoredAnswers.clear();
            for (const entry of learningState.authoredAnswers as Array<Partial<{ utterance: string; traceIds: string[]; at: number; score?: number; provider?: string; template?: string }>>) {
              if (typeof entry?.utterance === 'string' && Array.isArray(entry.traceIds) && typeof entry.at === 'number') {
                this.authoredAnswers.set(entry.utterance, {
                  traceIds: entry.traceIds.filter((id) => typeof id === 'string'),
                  at: entry.at,
                  score: typeof entry.score === 'number' ? entry.score : undefined,
                  provider: typeof entry.provider === 'string' ? entry.provider : undefined,
                  template: typeof entry.template === 'string' ? entry.template : undefined
                });
              }
            }
          }
          if (typeof learningState.edgeConfidence === 'object' && learningState.edgeConfidence !== null) {
            // The P8 confidence overlay survives reloads (agreement + grades).
            this.edgeConfidence.clear();
            for (const [key, value] of Object.entries(learningState.edgeConfidence as Record<string, unknown>)) {
              if (typeof value === 'number' && Number.isFinite(value)) this.edgeConfidence.set(key, value);
            }
          }
          if (typeof learningState.edgeSources === 'object' && learningState.edgeSources !== null) {
            // P14: the corroboration source classes survive reloads — evidence
            // mined yesterday still corroborates today (malformed entries drop).
            this.edgeSources.clear();
            for (const [key, value] of Object.entries(learningState.edgeSources as Record<string, unknown>)) {
              if (Array.isArray(value)) {
                const classes = (value as unknown[]).filter(isSourceClass);
                if (classes.length > 0) this.edgeSources.set(key, classes);
              }
            }
          }
          if (Array.isArray(learningState.negations)) {
            // The confirmed-false store survives reloads (P8).
            this.negations = (learningState.negations as Array<Partial<Negation>>)
              .filter((n) => typeof n?.subject === 'string' && typeof n?.object === 'string' && typeof n?.predicate === 'string')
              .map((n) => ({
                subject: n.subject as string,
                predicate: n.predicate as RelationPredicate,
                object: n.object as string,
                evidence: typeof n.evidence === 'string' ? n.evidence : '',
                origin: n.origin === 'graded' ? 'graded' : 'taught'
              }));
          }
          if (Array.isArray(learningState.resolvedSweepConflicts)) {
            // The sweep resolution ledger survives reloads — a resolved
            // conflict stays resolved (one-shot, no ping-pong).
            this.resolvedSweepConflicts = new Set(
              (learningState.resolvedSweepConflicts as unknown[]).filter(
                (id): id is string => typeof id === 'string'
              )
            );
          }
          if (typeof learningState.bootstrapImportedMeta === 'object' && learningState.bootstrapImportedMeta !== null) {
            const meta = learningState.bootstrapImportedMeta as { generatedAt: string; words: number };
            if (typeof meta.generatedAt === 'string' && typeof meta.words === 'number') {
              this.bootstrapImportedMeta = meta;
            }
          }
          if (typeof learningState.graderReliability === 'object' && learningState.graderReliability !== null) {
            // The grader reliability model survives reloads — per-bucket
            // agreement evidence is cumulative, never re-learned from scratch.
            this.reliabilityModel.restore(learningState.graderReliability as ReliabilitySnapshot);
          }
          this.restoreProducedCues(
            learningState.producedCues,
            learningState.cueConfidence as Record<string, number> | undefined
          );
        }
      } catch (error) {
        console.warn('learning-state restore failed — starting fresh for the deliberative layers', error);
      }
      return { restored, stale: staleTraceIds.size };
    }

    /**
     * Re-adopt the cues the observer has actually spoken. Only cues still
     * backed by a taught trace are kept, so a pruned or stale exchange can
     * never push the numerator past the denominator.
     *
     * Call AFTER the trace loop has rebuilt `taughtConversationCues`.
     */
    protected restoreProducedCues(cues: unknown, confidence?: Record<string, number>): void {
      if (Array.isArray(cues)) {
        for (const cue of cues) {
          if (typeof cue !== 'string' || !this.taughtConversationCues.has(cue)) continue;
          this.producedConversationCues.add(cue);
          const score = confidence?.[cue];
          if (typeof score === 'number') this.cueConfidence.set(cue, score);
        }
        return;
      }
      // A record written before this field existed. An empty array means
      // "genuinely none produced" and is honoured above; only a MISSING field
      // falls through to recovery.
      this.recoverProducedCuesFromTraces();
    }

    /**
     * Recover the produced set from recorded evidence: accessCount starts at
     * zero and only a recall increments it, so a conversation trace with at
     * least one access was demonstrably produced. Traces never recalled stay
     * out — the count is measured, never inferred.
     */
    protected recoverProducedCuesFromTraces(): void {
      for (const trace of this.session.observer.getMemoryBank().all()) {
        if (trace.metadata?.kind !== 'conversation' || (trace.accessCount ?? 0) < 1) continue;
        const cue = trace.metadata.cue;
        if (typeof cue === 'string' && this.taughtConversationCues.has(cue)) {
          this.producedConversationCues.add(cue);
        }
      }
    }

    /** Rebuild the composition transition weights from the observer's own
     *  strong creative traces — the tiny language model, reconstructed from
     *  memory (the handover's fluency signal must survive a reload). */
    protected rebuildCompositionWeightsFromMemory(): void {
      const bank = this.session.observer.getMemoryBank();
      for (const trace of bank.all()) {
        if (trace.metadata?.kind !== 'creative') continue;
        const score = typeof trace.metadata.score === 'number' ? trace.metadata.score : 0.7;
        if (score < CREATIVE_REINFORCE_SCORE) continue;
        bumpAgedWeights(this.compositionWeights, this.compositionWeightMeta, [trace.content], CREATIVE_GRADE_DELTA);
      }
    }

    /**
     * Throttled persistence hook: only every `persistEvery`-th action marks the
     * record dirty, so large batch runs do not spend the run re-serializing their
     * own history (which would otherwise be O(n²) in words taught).
     */
    maybePersist(): void {
      this.persistCounter += 1;
      if (this.persistCounter % this.persistEvery === 0) {
        this.schedulePersist();
      }
    }

    /**
     * Coalesce a burst of mutations into one write. One autonomous cycle fires
     * a dozen mutations; without this each would re-serialize the whole record
     * and the writes would queue up faster than they drain.
     */
    protected schedulePersist(): void {
      if (this.persistence === null) return;
      const now = Date.now();
      if (this.dirtySince === null) this.dirtySince = now;
      // A continuous stream of mutations must still reach storage: past the
      // ceiling the pending write goes out instead of being deferred again.
      if (now - this.dirtySince >= PERSIST_MAX_DELAY_MS) {
        this.runScheduledPersist();
        return;
      }
      if (this.persistTimer !== null) clearTimeout(this.persistTimer);
      this.persistTimer = setTimeout(() => this.runScheduledPersist(), PERSIST_DEBOUNCE_MS);
    }

    protected runScheduledPersist(): void {
      if (this.persistTimer !== null) {
        clearTimeout(this.persistTimer);
        this.persistTimer = null;
      }
      this.dirtySince = null;
      void this.persistAll();
    }

    /**
     * Write any coalesced mutation immediately and wait for every queued write
     * to land. Call this before the page goes away — a debounced save that
     * never ran is a lost lesson.
     */
    async flush(): Promise<void> {
      if (this.persistence === null) return;
      const pending = this.persistTimer !== null || this.dirtySince !== null;
      if (this.persistTimer !== null) {
        clearTimeout(this.persistTimer);
        this.persistTimer = null;
      }
      this.dirtySince = null;
      if (pending) {
        await this.persistAll();
        return;
      }
      await this.persistChain;
    }

    /**
     * Persist the complete learning record (word states + serialized traces).
     * Failures are logged, never thrown: a broken store must not break school.
     * Each save also appends a strength sample to the word's retention history.
     */
    async persistAll(): Promise<void> {
      if (this.persistence === null) return;
      const run = this.persistChain.then(() => this.writeRecord());
      // The chain must survive a failed write, or every later save is skipped.
      this.persistChain = run.catch(() => {});
      return run;
    }

    protected async writeRecord(): Promise<void> {
      if (this.persistence === null) return;
      try {
        const bank = this.session.observer.getMemoryBank();
        const traces = [];
        const now = Date.now();
        for (const state of this.states.values()) {
          if (state.traceId === null) continue;
          const data = bank.serializeTrace(state.traceId);
          if (data !== null) {
            traces.push(data);
            state.strengthHistory.push({ at: now, strength: data.strength });
            while (state.strengthHistory.length > 100) state.strengthHistory.shift();
          }
        }
        // Conversation exchanges, memorized creative answers, gaps, BELIEFS
        // and GOALS are traces too — the observer's full learning record must
        // survive restart, including its self-knowledge and its plans.
        for (const trace of bank.all()) {
          const kind = trace.metadata?.kind;
          if (
            (kind === 'conversation' && !this.conversationTraceIds.has(trace.id)) ||
            (kind === 'creative' && !this.creativeMemoryIds.has(trace.id)) ||
            (kind === 'gap' && !this.gapTraceIds.has(trace.id)) ||
            kind === 'belief' ||
            kind === 'goal'
          ) {
            const data = bank.serializeTrace(trace.id);
            if (data !== null) traces.push(data);
          }
        }
        for (const traceId of this.conversationTraceIds) {
          const data = bank.serializeTrace(traceId);
          if (data !== null) traces.push(data);
        }
        for (const traceId of this.creativeMemoryIds) {
          const data = bank.serializeTrace(traceId);
          if (data !== null) traces.push(data);
        }
        for (const traceId of this.gapTraceIds) {
          const data = bank.serializeTrace(traceId);
          if (data !== null) traces.push(data);
        }
        // THE FULL LEARNING STATE: the deliberative layers (composition
        // weights — the tiny language model, drive weights, goal history,
        // fade state, exposure counters) as one record — otherwise a reload
        // resets the observer's preferences and its self-grading handover.
        const learningState: Record<string, unknown> = {
          vocabularyScheme: BOOTSTRAP_VOCABULARY_SCHEME,
          compositionWeights: Object.fromEntries(this.compositionWeights),
          // L3 (19.2/19.3): the decay clocks ride the same record (additive —
          // absent on legacy records, which start their clocks at restore).
          compositionWeightMeta: Object.fromEntries(this.compositionWeightMeta),
          behaviorOutcomeAt: Object.fromEntries(this.behaviorOutcomeAt),
          // Phase 24.3 (additive): the calibration gates' evidence.
          calibration: this.calibration.snapshot(),
          behaviorWeights: this.behaviorWeights,
          behaviorOutcomes: this.behaviorOutcomes,
          goalHistory: this.goalHistory,
          // L2 (20.4): fadeState is GONE — λ is derived from the trust kernel,
          // whose evidence rides the graderReliability snapshot below.
          exposureCounts: Object.fromEntries(this.exposureCounts),
          encounterCounts: Object.fromEntries(this.encounterCounts),
          drillFailures: Object.fromEntries(this.drillFailures),
          producedCues: [...this.producedConversationCues],
          cueConfidence: Object.fromEntries(this.cueConfidence),
          relations: this.chaperoneRelations,
          // M5 (22.5, additive): the standing hypothesis tier survives reloads
          // so accumulated corroboration can promote across sessions.
          hypothesisEdges: this.hypothesisEdges,
          compiledRules: this.compiledRules,
          answerGrades: this.answerGrades,
          edgeConfidence: Object.fromEntries(this.edgeConfidence),
          edgeSources: Object.fromEntries(this.edgeSources),
          negations: this.negations,
          resolvedSweepConflicts: [...this.resolvedSweepConflicts],
          // R5: the rewrite rules are memories — only the LEARNED ones persist
          // (the authored decks are code; a stale persisted deck would decode
          // against mismatched primitives). Denials and the one-shot stop
          // ledger ride with them.
          rewriteRules: this.ruleStore
            .all()
            .filter((rule) => rule.origin !== 'authored')
            .map((rule) => ({ ...rule })),
          rewriteDenials: this.ruleStore.allDenials(),
          ruleResolutions: [...this.ruleResolutions],
          rewriteRuleStats: Object.fromEntries(
            this.ruleStore
              .all()
              .filter((rule) => rule.useCount > 0 || rule.lastUsedAt !== undefined)
              .map((rule) => [
                rule.id,
                { uses: rule.useCount, lastUsedAt: rule.lastUsedAt ?? rule.createdAt }
              ])
          ),
          authoredAnswers: [...this.authoredAnswers.entries()].map(([utterance, entry]) => ({
            utterance,
            traceIds: entry.traceIds,
            at: entry.at,
            score: typeof entry.score === 'number' ? entry.score : undefined,
            provider: typeof entry.provider === 'string' ? entry.provider : undefined,
            template: typeof entry.template === 'string' ? entry.template : undefined
          })),
          bootstrapImportedMeta: this.bootstrapImportedMeta,
          graderReliability: this.reliabilityModel.snapshot()
        };
        await Promise.all([
          // Untouched words carry nothing but constructor defaults; writing
          // all 20k of them on every save is what made the record too slow to
          // keep up with the learning loop.
          this.persistence.saveWordStates([...this.states.values()].filter(isTouchedWordState)),
          this.persistence.saveTraces(traces),
          this.persistence.saveLearningState(learningState),
          // The episodic journal (salient facts, bounded by its own policy).
          this.persistence.saveEpisodicMemory(this.episodic.serialize())
        ]);
      } catch (error) {
        console.warn('persistence save failed', error);
      }
    }

    /**
     * Import a headlessly-trained bootstrap record into this session: restore
     * every trace into the memory bank, bind the word states, load the
     * conversation exchanges, and apply the definitions. Identical semantics
     * to a fresh-session persistence restore — so the app can reach an
     * "initially trained" state in one step instead of hours of UI teaching.
     */
    importBootstrap(record: BootstrapRecord): { restored: number; conversations: number; definitions: number; droppedWords: number; stale: number } {
      if (
        record.version < BOOTSTRAP_MIN_SUPPORTED_VERSION ||
        record.version > BOOTSTRAP_VERSION ||
        record.vocabularyScheme !== BOOTSTRAP_VOCABULARY_SCHEME
      ) {
        throw new Error('bootstrap vocabulary encoding is incompatible; regenerate it with npm run train');
      }
      const bank = this.session.observer.getMemoryBank();
      let restored = 0;
      let conversations = 0;
      let stale = 0;
      let droppedWords = 0;

      for (const data of record.traces) {
        if (isStaleEncoding(data)) {
          // Pre-encoding-era trace — rejected silently for years; count it so
          // the caller can report why the record restored fewer than exported.
          stale += 1;
          continue;
        }
        // Deduplicated records omit the per-trace basis copy — reconstruct it
        // from the record header. Legacy records carry primes per trace.
        const primes = data.primes.length === 0 && record.primeBasis !== undefined ? record.primeBasis : data.primes;
        const trace = bank.restoreTrace(
          record.encoding === 'q16' ? { ...data, primes, amplitudes: data.amplitudes.map((a) => a / 65535) } : { ...data, primes }
        );
        if (trace !== null) {
          restored += 1;
          if (trace.metadata?.kind === 'belief') {
            const beliefKind = String(trace.metadata.beliefKind ?? '');
            const about = String(trace.metadata.about ?? '');
            if (about.length > 0) this.beliefsStored.add(`${beliefKind}:${about}`);
          }
          if (trace.metadata?.kind === 'conversation' && typeof trace.metadata.cue === 'string') {
            this.conversationTraceIds.add(trace.id);
            this.taughtConversationCues.add(trace.metadata.cue);
            conversations += 1;
          }
          if (trace.metadata?.kind === 'creative') {
            this.creativeMemoryIds.add(trace.id);
            if (typeof trace.metadata.uttered === 'string') {
              this.creativeUtteredKeys.add(trace.metadata.uttered);
            }
          }
          if (trace.metadata?.kind === 'gap' && typeof trace.metadata.uttered === 'string') {
            this.gapUtterances.add(trace.metadata.uttered);
            this.gapMissCounts.set(trace.metadata.uttered, 1);
            this.gapTraceIds.add(trace.id);
          }
        }
      }

      for (const state of record.wordStates) {
        const current = this.states.get(state.word);
        // A word this deck does not teach, or a state bound to a trace that
        // failed to restore, can never be bound here — count the drop so the
        // import summary reports it instead of losing it silently.
        if (!current || state.traceId === null) {
          droppedWords += 1;
          continue;
        }
        // A word whose trace failed to restore is left untaught — never bound
        // to a phantom trace.
        if (bank.get(state.traceId) === undefined) {
          droppedWords += 1;
          continue;
        }
        current.traceId = state.traceId;
        current.taughtAt = state.taughtAt;
        current.lastAskedAt = state.lastAskedAt;
        current.lastGrade = state.lastGrade;
        current.successes = state.successes;
        current.failures = state.failures;
        current.strengthHistory = Array.isArray(state.strengthHistory) ? state.strengthHistory : [];
        // P9: FSRS state rides the word states; old records default fresh.
        current.stability = typeof state.stability === 'number' && state.stability > 0 ? state.stability : FSRS_INITIAL_STABILITY;
        current.difficulty = typeof state.difficulty === 'number' ? state.difficulty : FSRS_INITIAL_DIFFICULTY;
        current.dueAt = typeof state.dueAt === 'number' ? state.dueAt : Date.now();
        current.lastIntervalDays = typeof state.lastIntervalDays === 'number' ? state.lastIntervalDays : null;
        current.reviewHistory = Array.isArray(state.reviewHistory)
          ? (state.reviewHistory as Array<'correct' | 'wrong'>).filter((o) => o === 'correct' || o === 'wrong').slice(-REVIEW_HISTORY_CAP)
          : [];
      }

      const definitions = this.applyDefinitions(record.definitions);
      if (Array.isArray(record.relations)) {
        this.chaperoneRelations = record.relations
          .filter((r) => typeof r?.subject === 'string' && typeof r?.predicate === 'string' && typeof r?.object === 'string')
          .map((r) => ({
            subject: r.subject,
            predicate: r.predicate,
            object: r.object,
            source: typeof r.source === 'string' ? r.source : '',
            origin: 'chaperone' as const
          }));
        this.invalidateRelations();
      }
      if (Array.isArray(record.compiledRules)) {
        this.compiledRules = record.compiledRules
          .filter((r) => typeof r?.id === 'string' && typeof r?.concept === 'string' && typeof r?.drill === 'string' && typeof r?.program === 'object' && r?.program !== null)
          .map((r) => ({
            id: r.id,
            concept: r.concept,
            drill: r.drill,
            program: r.program,
            nodes: typeof r.nodes === 'number' ? r.nodes : 0,
            bits: typeof r.bits === 'number' ? r.bits : 0,
            trainCount: typeof r.trainCount === 'number' ? r.trainCount : 0,
            instanceBits: typeof r.instanceBits === 'number' ? r.instanceBits : 0
          }));
      }
      if (Array.isArray(record.answerGrades)) {
        this.answerGrades = record.answerGrades
          .filter((g) => typeof g?.at === 'number' && typeof g?.utterance === 'string' && Array.isArray(g.traceIds))
          .slice(-ANSWER_GRADES_CAP)
          .map((g) => ({
            at: g.at,
            utterance: g.utterance,
            mode: typeof g.mode === 'string' ? g.mode : 'unknown',
            verdict: g.verdict ?? 'neutral',
            traceIds: g.traceIds.filter((id) => typeof id === 'string'),
            edges: Array.isArray(g.edges)
              ? g.edges.filter((e) => typeof e?.subject === 'string' && typeof e?.object === 'string')
              : [],
            operatorId: typeof g.operatorId === 'string' ? g.operatorId : undefined,
            ruleIds: Array.isArray(g.ruleIds) ? g.ruleIds.filter((id): id is string => typeof id === 'string') : undefined
          }));
      }
      if (Array.isArray(record.authoredAnswers)) {
        this.authoredAnswers.clear();
        for (const entry of record.authoredAnswers) {
          if (typeof entry?.utterance === 'string' && Array.isArray(entry.traceIds) && typeof entry.at === 'number') {
            this.authoredAnswers.set(entry.utterance, {
              traceIds: entry.traceIds.filter((id) => typeof id === 'string'),
              at: entry.at,
              score: typeof entry.score === 'number' ? entry.score : undefined,
              provider: typeof entry.provider === 'string' ? entry.provider : undefined,
              template: typeof entry.template === 'string' ? entry.template : undefined
            });
          }
        }
      }
      if (typeof record.edgeConfidence === 'object' && record.edgeConfidence !== null) {
        this.edgeConfidence.clear();
        for (const [key, value] of Object.entries(record.edgeConfidence as Record<string, unknown>)) {
          if (typeof value === 'number' && Number.isFinite(value)) this.edgeConfidence.set(key, value);
        }
      }
      if (typeof record.edgeSources === 'object' && record.edgeSources !== null) {
        // P14: corroboration source classes ride the bootstrap record.
        this.edgeSources.clear();
        for (const [key, value] of Object.entries(record.edgeSources as Record<string, unknown>)) {
          if (Array.isArray(value)) {
            const classes = (value as unknown[]).filter(isSourceClass);
            if (classes.length > 0) this.edgeSources.set(key, classes);
          }
        }
      }
      if (Array.isArray(record.negations)) {
        this.negations = record.negations
          .filter((n) => typeof n?.subject === 'string' && typeof n?.object === 'string' && typeof n?.predicate === 'string')
          .map((n) => ({
            subject: n.subject,
            predicate: n.predicate,
            object: n.object,
            evidence: typeof n.evidence === 'string' ? n.evidence : '',
            origin: n.origin === 'graded' ? 'graded' : 'taught'
          }));
      }
      if (Array.isArray(record.resolvedSweepConflicts)) {
        // The sweep resolution ledger survives imports — a resolved conflict
        // stays resolved (one-shot, no ping-pong).
        this.resolvedSweepConflicts = new Set(
          (record.resolvedSweepConflicts as unknown[]).filter(
            (id): id is string => typeof id === 'string'
          )
        );
      }
      if (Array.isArray(record.rewriteRules)) {
        // R5: learned rewrite rules survive imports, exactly like reloads.
        for (const rule of record.rewriteRules as Array<Partial<RewriteRule>>) {
          if (
            typeof rule?.id === 'string' &&
            typeof rule?.name === 'string' &&
            typeof rule?.lhs === 'object' &&
            rule?.lhs !== null &&
            typeof rule?.rhs === 'object' &&
            rule?.rhs !== null
          ) {
            try {
              this.ruleStore.register({
                id: rule.id,
                name: rule.name,
                lhs: rule.lhs as RewriteRule['lhs'],
                rhs: rule.rhs as RewriteRule['rhs'],
                origin: rule.origin === 'induced' || rule.origin === 'taught' || rule.origin === 'chaperone' || rule.origin === 'consolidated' ? rule.origin : 'induced',
                strength: typeof rule.strength === 'number' ? rule.strength : 1,
                sourceClasses: Array.isArray(rule.sourceClasses) ? rule.sourceClasses.filter((c) => typeof c === 'string') : [],
                bits: typeof rule.bits === 'number' ? rule.bits : 0,
                evidence: typeof rule.evidence === 'number' ? rule.evidence : undefined,
                schema: rule.schema === 'structural' || rule.schema === 'measure' || rule.schema === 'accessor' || rule.schema === 'search' || rule.schema === 'scalar' ? rule.schema : undefined,
                active: rule.active !== false,
                createdAt: typeof rule.createdAt === 'number' ? rule.createdAt : 0,
                useCount: typeof rule.useCount === 'number' ? rule.useCount : 0,
                lastUsedAt: typeof rule.lastUsedAt === 'number' ? rule.lastUsedAt : undefined
              });
            } catch {
              // Unregisterable rules are dropped.
            }
          }
        }
      }
      if (Array.isArray(record.rewriteDenials)) {
        for (const denial of record.rewriteDenials as Array<Partial<DerivationDenial>>) {
          if (typeof denial?.ruleId === 'string') {
            this.ruleStore.recordDenial({
              ruleId: denial.ruleId,
              input: typeof denial.input === 'string' ? denial.input : undefined,
              output: typeof denial.output === 'string' ? denial.output : undefined,
              expected: typeof denial.expected === 'string' ? denial.expected : undefined,
              evidence: denial.evidence === 'taught' || denial.evidence === 'verified-wrong' ? denial.evidence : 'graded-wrong',
              at: typeof denial.at === 'number' ? denial.at : 0
            });
          }
        }
      }
      if (Array.isArray(record.ruleResolutions)) {
        this.ruleResolutions.clear();
        for (const id of record.ruleResolutions as unknown[]) {
          if (typeof id === 'string') this.ruleResolutions.add(id);
        }
      }
      this.rebuildLearnedOperators();
      if (record.driveWeights !== undefined) {
        this.behaviorWeights = { ...record.driveWeights } as BehaviorWeights;
      }
      if (record.goalHistory !== undefined) {
        for (const [type, record2] of Object.entries(record.goalHistory)) {
          const key = type as GoalType;
          if (key in this.goalHistory) {
            this.goalHistory[key] = { completed: record2.completed, abandoned: record2.abandoned };
          }
        }
      }
      // The FULL higher-order state: composition weights (the tiny language
      // model), outcome history, fade λ, exposure — the entire teacher from a
      // headless record.
      if (record.learningState !== undefined) {
        const ls = record.learningState;
        if (typeof ls.compositionWeights === 'object' && ls.compositionWeights !== null) {
          this.compositionWeights.clear();
          for (const [key, value] of Object.entries(ls.compositionWeights)) this.compositionWeights.set(key, value);
        }
        // L3 (19.2/19.3): the decay clocks (absent on legacy records — the
        // first decay sweep after import starts them).
        if (typeof ls.compositionWeightMeta === 'object' && ls.compositionWeightMeta !== null) {
          this.compositionWeightMeta.clear();
          for (const [key, value] of Object.entries(ls.compositionWeightMeta)) {
            if (Number.isFinite(value)) this.compositionWeightMeta.set(key, value);
          }
        }
        if (typeof ls.behaviorOutcomeAt === 'object' && ls.behaviorOutcomeAt !== null) {
          for (const [key, value] of Object.entries(ls.behaviorOutcomeAt)) {
            if (Number.isFinite(value)) this.behaviorOutcomeAt.set(key as BehaviorOption, value);
          }
        }
        if (typeof ls.behaviorOutcomes === 'object' && ls.behaviorOutcomes !== null) {
          for (const option of Object.keys(this.behaviorOutcomes) as BehaviorOption[]) {
            const record2 = ls.behaviorOutcomes[option];
            if (record2 !== undefined) {
              this.behaviorOutcomes[option] = { wins: record2.wins, losses: record2.losses };
            }
          }
        }
        if (typeof ls.fadeState === 'object' && ls.fadeState !== null && ls.fadeState.lambda != null) {
          // L2 (20.4) MIGRATION: legacy stored λ seeds equivalent kernel
          // evidence (see restoreFromPersistence).
          this.seedLegacyFadeState(ls.fadeState as { lambda?: Record<string, number> });
        }
        if (typeof ls.exposureCounts === 'object' && ls.exposureCounts !== null) {
          this.exposureCounts.clear();
          for (const [word, count] of Object.entries(ls.exposureCounts)) this.exposureCounts.set(word, count);
        }
        if (typeof ls.encounterCounts === 'object' && ls.encounterCounts !== null) {
          this.encounterCounts.clear();
          for (const [word, count] of Object.entries(ls.encounterCounts)) this.encounterCounts.set(word, count);
        }
        if (typeof ls.drillFailures === 'object' && ls.drillFailures !== null) {
          this.drillFailures.clear();
          for (const [concept, count] of Object.entries(ls.drillFailures as Record<string, unknown>)) {
            if (typeof count === 'number' && Number.isFinite(count) && count > 0) {
              this.drillFailures.set(concept, Math.floor(count));
            }
          }
        }
        if (typeof ls.graderReliability === 'object' && ls.graderReliability !== null) {
          this.reliabilityModel.restore(ls.graderReliability as ReliabilitySnapshot);
        }
        this.restoreProducedCues(ls.producedCues, ls.cueConfidence);
      }
      return { restored, conversations, definitions, droppedWords, stale };
    }

    /**
     * Assemble the current session into an exportable bootstrap record — the
     * same shape the batch trainer writes, so a session can be moved between
     * machines (or into a fresh browser) with one import.
     */
    exportBootstrap(deck = 'en-20000'): BootstrapRecord {
      const bank = this.session.observer.getMemoryBank();
      const traces: BootstrapRecord['traces'] = [];
      const wordStates: BootstrapRecord['wordStates'] = [];
      const now = new Date().toISOString();

      // The field's prime basis — every trace carried the identical 256-prime
      // array; store it once and drop the per-trace copy.
      const firstTrace = bank.all()[0];
      const primeBasis: number[] = firstTrace !== undefined ? [...firstTrace.primes] : [];
      const dedupPrimes = (primes: readonly number[]): number[] =>
        primeBasis.length > 0 && primes.length === primeBasis.length && primes.every((p, i) => p === primeBasis[i]) ? [] : [...primes];

      // Record-level compact encoding: amplitudes are quantized to uint16
      // fixed-point (the moment's per-prime distribution is stored to 1/65535
      // resolution — nothing below noise), and review histories are capped at
      // the last 20 events (enough for any trend the report reads).
      const quantize = (amplitudes: readonly number[]): number[] =>
        amplitudes.map((value) => Math.max(0, Math.min(65535, Math.round(value * 65535))));

      for (const state of this.states.values()) {
        if (state.traceId === null) continue;
        const trace = bank.serializeTrace(state.traceId);
        if (trace !== null) traces.push({ ...trace, primes: dedupPrimes(trace.primes), amplitudes: quantize(trace.amplitudes) });
        wordStates.push({
          word: state.word.word,
          traceId: state.traceId,
          taughtAt: state.taughtAt,
          lastAskedAt: state.lastAskedAt,
          lastGrade: state.lastGrade,
          successes: state.successes,
          failures: state.failures,
          strengthHistory: state.strengthHistory.slice(-20),
          stability: state.stability,
          difficulty: state.difficulty,
          dueAt: state.dueAt,
          lastIntervalDays: state.lastIntervalDays,
          reviewHistory: state.reviewHistory.slice(-20)
        });
      }
      for (const trace of bank.all()) {
        if (trace.metadata?.kind !== 'conversation' && trace.metadata?.kind !== 'creative' && trace.metadata?.kind !== 'gap' && trace.metadata?.kind !== 'belief' && trace.metadata?.kind !== 'goal') continue;
        const data = bank.serializeTrace(trace.id);
        if (data !== null && !traces.some((existing) => existing.id === data.id)) {
          traces.push({ ...data, primes: dedupPrimes(data.primes), amplitudes: quantize(data.amplitudes) });
        }
      }

      const definitions: BootstrapRecord['definitions'] = [];
      for (const state of this.states.values()) {
        if (state.word.definition.trim().length === 0 || state.word.example.trim().length === 0) continue;
        definitions.push({ word: state.word.word, definition: state.word.definition, example: state.word.example });
      }

      const weights: Record<string, number> = {};
      for (const option of Object.keys(this.behaviorWeights) as BehaviorOption[]) {
        const value = this.behaviorWeights[option];
        if (value !== undefined) weights[option] = value;
      }
      const goalHistory: Record<string, { completed: number; abandoned: number }> = {};
      for (const [type, record] of Object.entries(this.goalHistory)) {
        if (record.completed > 0 || record.abandoned > 0) goalHistory[type] = { ...record };
      }
      // The FULL higher-order state, so a headlessly-trained record handed to
      // the web restores the entire teacher (its tiny language model, its
      // outcome history, its handover λ, its exposure).
      const learningState: BootstrapRecord['learningState'] = {
        compositionWeights: Object.fromEntries(this.compositionWeights),
        // L3 (19.2/19.3): the decay clocks ride the record (additive fields).
        compositionWeightMeta: Object.fromEntries(this.compositionWeightMeta),
        behaviorOutcomeAt: Object.fromEntries(this.behaviorOutcomeAt),
        behaviorOutcomes: Object.fromEntries(
          Object.entries(this.behaviorOutcomes).map(([option, record]) => [option, { ...record }])
        ) as Record<string, { wins: number; losses: number }>,
        // L2 (20.4): fadeState is GONE — λ derives from the trust kernel; its
        // evidence rides graderReliability below.
        exposureCounts: Object.fromEntries(this.exposureCounts),
        encounterCounts: Object.fromEntries(this.encounterCounts),
        drillFailures: Object.fromEntries(this.drillFailures),
        producedCues: [...this.producedConversationCues],
        cueConfidence: Object.fromEntries(this.cueConfidence),
        bootstrapImportedMeta: this.bootstrapImportedMeta ?? undefined,
        graderReliability: this.reliabilityModel.snapshot()
      };

      return {
        version: BOOTSTRAP_VERSION,
        vocabularyScheme: BOOTSTRAP_VOCABULARY_SCHEME,
        deck,
        generatedAt: now,
        encoding: 'q16' as const,
        primeBasis: primeBasis.length > 0 ? primeBasis : undefined,
        source: {
          words: wordStates.map((state) => state.word),
          conversation: this.conversationTraceIds.size > 0,
          definitionsFilled: definitions.length > 0
        },
        traces,
        wordStates,
        definitions,
        relations: this.chaperoneRelations.length > 0 ? this.chaperoneRelations : undefined,
        compiledRules: this.compiledRules.length > 0 ? this.compiledRules : undefined,
        answerGrades: this.answerGrades.length > 0 ? this.answerGrades : undefined,
        edgeConfidence:
          this.edgeConfidence.size > 0 ? Object.fromEntries(this.edgeConfidence) : undefined,
        edgeSources: this.edgeSources.size > 0 ? Object.fromEntries(this.edgeSources) : undefined,
        negations: this.negations.length > 0 ? this.negations : undefined,
        resolvedSweepConflicts:
          this.resolvedSweepConflicts.size > 0 ? [...this.resolvedSweepConflicts] : undefined,
        rewriteRules:
          this.ruleStore.all().filter((rule) => rule.origin !== 'authored').length > 0
            ? this.ruleStore
                .all()
                .filter((rule) => rule.origin !== 'authored')
                .map((rule) => ({ ...rule }))
            : undefined,
        rewriteDenials: this.ruleStore.allDenials().length > 0 ? this.ruleStore.allDenials() : undefined,
        ruleResolutions: this.ruleResolutions.size > 0 ? [...this.ruleResolutions] : undefined,
        authoredAnswers:
          this.authoredAnswers.size > 0
            ? [...this.authoredAnswers.entries()].map(([utterance, entry]) => ({
                utterance,
                traceIds: entry.traceIds,
                at: entry.at,
                score: typeof entry.score === 'number' ? entry.score : undefined,
                provider: typeof entry.provider === 'string' ? entry.provider : undefined,
                template: typeof entry.template === 'string' ? entry.template : undefined
              }))
            : undefined,
        driveWeights: Object.keys(weights).length > 0 ? weights : undefined,
        goalHistory: Object.keys(goalHistory).length > 0 ? goalHistory : undefined,
        learningState
      };
    }

    /** The last-imported bootstrap meta (read-only, null = never imported). */
    lastBootstrapImported(): { generatedAt: string; words: number } | null {
      return this.bootstrapImportedMeta;
    }

    /** Record that a bootstrap deploy was imported (persisted in the
     *  learning state so the comparison survives reloads). */
    markBootstrapImported(meta: { generatedAt: string; words: number }): void {
      this.bootstrapImportedMeta = meta;
      this.maybePersist();
    }
  };
}
