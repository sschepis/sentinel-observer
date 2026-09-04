/**
 * CREATIVE FACULTY - creative reply, grading, world feedback, fade/handover
 * (agent split refactor).
 *
 * The observer's compositional voice: creativeReply over recalled memories,
 * the LLM grade pipeline (gradeCreativeWithReliability) plus the world's
 * junior-judge signals (re-ask / retention credits), and the L2 emergent
 * handover (fade agreement telemetry + lambda traffic). State
 * (creativeMemoryIds, creativeUtteredKeys, compositionWeights/Meta,
 * authoredAnswers, answerGrades, reliabilityModel, fadeAgreementTelemetry,
 * lambdaTraffic, compositionCost, compositionRng) lives on TeacherAgentCore.
 */
import { TeacherAgentCore, type Constructor, type CrossFacultyApi } from './base';
import {
  bumpAgedWeights,
  type WeightMeta
} from '../agedWeights';
import {
  composeCreativeResponse,
  type TransitionWeights
} from '../conversation';
import {
  parseNegationStatement
} from '../operators';
import {
  composeGrounded,
  criticize,
  groundedSubjects,
  hedgeComposition
} from '../groundedFrames';
import {
  deniedFromNegations
} from '../chain';
import {
  classifyUtterance,
  blendReward,
  fadeCriteria,
  type GradeClass
} from '../fade';
import {
  JUDGE_COMPOSITE
} from '../trust';
import {
  compositeScore
} from '../composite';
import {
  groundingScore
} from '../grounding';
import {
  type Negation,
  type SourceClass
} from '../relations';
import {
  difficultyBandOf,
  gradeBandOf,
  ruleBandForGrounding,
  bandsAgree,
  GRADE_STRONG_THRESHOLD,
  WORLD_FEEDBACK_WEIGHT,
  type GradeBand,
  type GradeCriteria
} from '../reliability';
import {
  tokenizeText,
  isContentWord
} from '../context';
import {
  clampRange
} from '@sschepis/sentient-core';
import {
  creativeReinforceScore,
  RETENTION_FRACTION,
  CREATIVE_WEAKEN_SCORE,
  creativeGradeDelta,
  CREATIVE_GRADE_DELTA,
  type AnswerProvenance,
  type CreativeReply
} from './support';

export function CreativeMixin<TBase extends Constructor<TeacherAgentCore & CrossFacultyApi>>(Base: TBase) {
  return class CreativeFaculty extends Base {

    /** Number of stored creative memories (strong answers, incl. hybrid). */
    creativeMemoryCount(): number {
      return this.creativeMemoryIds.size;
    }

    /** The learned composition transition weights (read-only — the observer's
     *  tiny language model, exposed for the Phase 7a correlation bench). */
    getCompositionWeights(): TransitionWeights {
      return this.compositionWeights;
    }

    /** L3 (19.2): the weights' decay clocks (read-only — round-trip gates). */
    getCompositionWeightMeta(): ReadonlyMap<string, number> {
      return this.compositionWeightMeta;
    }

    /**
     * The observer's CREATIVE answer: it hears the utterance, recalls its own
     * memorized conversational sentences, and composes a NEW sentence from
     * those words alone (no LLM in the generation path). With a limited
     * vocabulary the composition is naturally limited — it can only say what
     * it has learned to say. The composition is what gets graded semantically
     * afterwards.
     */
    creativeReply(utterance: string, extraSeeds: readonly string[] = []): CreativeReply {
      const cue = utterance.trim();
      if (cue.length === 0) {
        return { sentence: '', seedCount: 0, confidence: null, seedTraceIds: [], grounded: false, hedged: false, edges: [], templateIds: [] };
      }

      // The moment (converged field) selects the seeds — recallMemories
      // excites and settles the field, then ranks by resonance with the
      // moment's amplitude distribution. The top memory's words ARE the
      // moment's language: the composition continues the coherence pattern.
      const memories = this.recallMemories(utterance, 6);
      const contents = memories.map((memory) => memory.content);
      const seedTraceIds = memories.map((memory) => memory.id);
      const bestScore = memories.length > 0 ? memories[0].score : null;
      const momentTokens = memories.length > 0 ? contents[0].split(' ') : [];
      // Recent working-memory turns are context seeds (low priority, capped)
      // so compositions can continue the topic at hand.
      for (const seed of extraSeeds) {
        const content = seed.trim();
        if (content.length > 0 && !contents.includes(content)) contents.push(content);
        if (contents.length >= 8) break;
      }

      // P5 GROUNDED FIRST: typed frames filled from the relation graph, every
      // content word from a stored edge, verified by the internal critic. The
      // Markov path below is the LABELED fallback. The utterance's own known
      // words are the preferred subjects; an utterance that names a known but
      // EDGELESS topic falls back (answering about a different subject would
      // be non-responsive), while a content-free utterance ("tell me more")
      // lets the recent memory supply the topic.
      const relations = this.relations();
      const denied = deniedFromNegations(this.negations);
      const utteranceContent = tokenizeText(cue).filter(isContentWord);
      const utteranceSubjects = groundedSubjects(utteranceContent, relations, denied);
      const memorySubjects = groundedSubjects(tokenizeText(contents.join(' ')), relations, denied);
      const useGrounded = utteranceSubjects.length > 0 || utteranceContent.length === 0;
      const grounded = useGrounded
        ? composeGrounded(
            [...utteranceSubjects, ...memorySubjects],
            relations,
            this.compositionRng,
            undefined,
            { negations: this.negations, cost: this.compositionCost, extraRules: this.compositionRules.admitted() },
            this.learnedFrames
          )
        : null;
      if (grounded !== null && grounded.edges.length > 0) {
        // The critic already verified the composition in composeGrounded;
        // re-verify against the full graph + negations for the final sentence.
        const verdict = criticize(grounded.sentence, relations, this.negations, {
          cost: this.compositionCost,
          extraRules: this.compositionRules.admitted()
        });
        if (verdict.grounded) {
          // P14: the claims are graph-backed, but single-source claims are
          // still WEAK — phrase them with their corroboration hedge instead of
          // asserting them flatly. Corroborated claims are spoken assertively.
          const spoken = hedgeComposition(grounded.sentence, relations);
          return {
            sentence: spoken.sentence,
            seedCount: memories.length,
            confidence: bestScore,
            seedTraceIds,
            grounded: true,
            hedged: spoken.hedged,
            edges: verdict.edges,
            templateIds: grounded.templateIds
          };
        }
        // A composition the re-parse refuses counts against the templates that
        // produced it (learned templates are demoted on repeated refusal).
        this.learnedFrames.observeRejection(grounded.templateIds ?? []);
      } else if (grounded !== null) {
        this.learnedFrames.observeRejection(grounded.templateIds ?? []);
      }

      const composed = composeCreativeResponse(contents, memories[0]?.content ?? '', {
        weights: this.compositionWeights,
        utterance: cue,
        momentTokens,
        rng: this.compositionRng
      });
      return {
        sentence: composed.sentence,
        seedCount: composed.seedCount,
        confidence: bestScore,
        seedTraceIds,
        grounded: false,
        hedged: false,
        edges: [],
        templateIds: []
      };
    }

    /**
     * Close the creative loop the way the word loop closes: a semantic grade
     * is feedback, not just a number. Strong compositions reinforce their seed
     * memories AND lower the surprise of the transitions they used; weak ones
     * weaken both slightly — creativity becomes a learned behavior on top of
     * memorization, driven by entropy descent over the composition weights.
     *
     * Additionally, a STRONG answer (>= CREATIVE_REINFORCE_SCORE — the live
     * creativeReinforceScore() gate, D.4) is itself
     * memorized as a new creative trace keyed by its utterance — the observer
     * "remembers what worked", so a good answer becomes a repeatable answer
     * (and its words join the composition pool for future novelty). Weak
     * answers are never stored: memory stays honest.
     *
     * The producers are named by PROVENANCE (P7): the seed traces the answer
     * was built from — and, once edges carry confidence (P8), the typed edges
     * it cited. A bad grade weakens exactly those, never the whole bank.
     *
     * `weight` (0..1, default 1) scales the FEEDBACK DELTAS — trace
     * reinforcement, the composition-weight gradient, and the P8 edge bumps —
     * never the grade's BAND: the store/gap/negation decisions still read the
     * unweighted score, so a damped grade can never silently change class.
     * The grader reliability model supplies this weight so low-reliability
     * buckets contribute less to edge strengthening/weakening and to the
     * memory updates the grade drives.
     */
    creativeGradeFeedback(
      provenance: AnswerProvenance | readonly string[],
      score: number | null,
      utterance = '',
      answer = '',
      weight = 1
    ): boolean {
      // Backward-compatible: a bare trace-id list (pre-P7 callers) is a
      // provenance without edges.
      const producers: AnswerProvenance = Array.isArray(provenance)
        ? { traceIds: [...(provenance as readonly string[])], edges: [] }
        : (provenance as AnswerProvenance);
      const seedTraceIds = producers.traceIds;
      const citedEdges = producers.edges;
      const templateIds = producers.templateIds ?? [];
      const citedRules = producers.ruleIds ?? [];
      if (score === null) return false;
      // THE FADING CONTROLLER (Phase 7c): when the student's own composite
      // has proven it can judge (measured agreement ≥ threshold), the reward
      // blends — λ·composite + (1−λ)·teacher — so the observer gradually
      // self-grades what it has learned to judge while the teacher remains
      // the authority on novel/uncertain terrain. The composite is judged
      // against the answer's REAL seeds (the producing trace contents), never
      // against the answer itself.
      if (utterance.trim().length > 0 && answer.trim().length > 0) {
        const seedContents: string[] = [];
        const bankForSeeds = this.session.observer.getMemoryBank();
        for (const traceId of seedTraceIds) {
          const trace = bankForSeeds.get(traceId);
          if (trace !== undefined && !seedContents.includes(trace.content)) {
            seedContents.push(trace.content);
          }
        }
        score = this.fadeReward(utterance, answer, score, seedContents);
      }
      const feedbackWeight = Math.max(0, Math.min(1, weight));
      const bank = this.session.observer.getMemoryBank();
      // L1b (18.2): the delta is surprise-scaled by the grade's margin beyond
      // its gate; the BAND (reinforce/weaken/neutral) is unchanged.
      const rawDelta = creativeGradeDelta(score);
      const delta = rawDelta * feedbackWeight;
      // P5 learned frames: the world's verdict is attributed to the templates
      // the grounded composition used. A strong answer also demonstrates its
      // structure — the induction reconstructs the template from the accepted
      // sentence (content still read from stored edges at generation time).
      const accepted = score >= creativeReinforceScore();
      this.learnedFrames.observeUse(templateIds, accepted);
      if (delta > 0 && templateIds.length > 0 && answer.trim().length > 0) {
        this.learnedFrames.induce(answer, this.relations(), this.negations);
      }
      // R4b: a cited chain is evidence for its predicate sequence — the
      // composition-rule store's acceptance baseline is the seeds' own rate.
      if (citedEdges.length >= 2) {
        this.compositionRules.observe(citedEdges.map((edge) => edge.predicate), accepted);
      }
      if (delta === 0) {
        // P7 contract: the ledger records the producers of EVERY graded
        // answer — a mid-grade (0.3–0.7) answer carries no reinforcement but
        // its producers must still be named for surgical repair.
        this.recordAnswerGrade(utterance, 'creative', 'neutral', {
          traceIds: seedTraceIds,
          edges: citedEdges,
          ruleIds: citedRules.length > 0 ? citedRules : undefined
        });
        this.maybePersist();
        return false;
      }
      // The learned model updates from the SEED contents (the memory that
      // produced the answer) AND from the ANSWER ITSELF — a strong answer is
      // the observer's own new material, and its n-grams must enter the
      // transition model or the student never gains fluency on its own voice
      // (the 7d finding: without this, the uncertainty fallback never
      // releases).
      const contents: string[] = [answer];
      for (const traceId of seedTraceIds) {
        const trace = bank.get(traceId);
        if (trace === undefined) continue;
        if (!contents.includes(trace.content)) contents.push(trace.content);
        bank.reinforce(traceId, delta);
      }
      bumpAgedWeights(this.compositionWeights, this.compositionWeightMeta, contents, delta);
      // P11: a strongly-graded answer makes its seed traces more useful to keep
      // (grade evidence feeds the bank's retrieval-usefulness pruning).
      if (delta > 0) {
        for (const traceId of seedTraceIds) {
          this.session.observer.getMemoryBank().bumpUtility(traceId, 1);
        }
      }
      // P8: a grade on an answer that CITED edges adjusts exactly those —
      // a strong answer confirms them, a weak one calls them into question.
      // The edge delta is scaled by the same feedback weight, so a grade from
      // a low-reliability bucket weakens/strengthens edges less (P8 rides on
      // the weighted grade, never on its unweighted band).
      const edgeDelta = rawDelta > 0 ? 0.2 * feedbackWeight : rawDelta < 0 ? -0.2 * feedbackWeight : 0;
      for (const edge of citedEdges) {
        this.bumpEdge(edge.subject, edge.predicate, edge.object, edgeDelta);
      }
      // P14: the world's verdict is a source class. An ACCEPTED graded answer
      // corroborates the edges it cited (>= 2 independent classes -> spoken
      // assertively); a rejected one withdraws that credit.
      for (const edge of citedEdges) {
        if (delta > 0) this.addEdgeSource(edge.subject, edge.predicate, edge.object, 'world-feedback');
        else if (delta < 0) this.removeEdgeSource(edge.subject, edge.predicate, edge.object, 'world-feedback');
      }
      // R5: the world's verdict on an answer that DERIVED through rules
      // credits or weakens exactly those rules — the rule analog of P8's
      // per-edge confidence. A strong grade corroborates (the hedge lifts);
      // a weak one weakens, records the denial, and stops a doubly-denied
      // rule at the floor (never deleted).
      for (const ruleId of citedRules) {
        if (delta > 0) this.ruleStore.addSourceClass(ruleId, 'world-feedback');
        else if (delta < 0) this.weakenRule(ruleId, feedbackWeight);
      }
      // The P7 grade ledger: this answer's producers (and the edges it cited —
      // consumed by P8's per-edge confidence) are recorded for surgical repair.
      this.recordAnswerGrade(utterance, 'creative', rawDelta > 0 ? 'strong' : rawDelta < 0 ? 'weak' : 'neutral', {
        traceIds: seedTraceIds,
        edges: citedEdges,
        ruleIds: citedRules.length > 0 ? citedRules : undefined
      });

      // Memorize strong answers as creative traces (surprise-gated: only store
      // if this exact answer is not already an utterance-keyed memory).
      let stored = false;
      if (score >= creativeReinforceScore() && utterance.trim().length > 0 && answer.trim().length > 0) {
        const key = utterance.trim().toLowerCase();
        if (!this.creativeUtteredKeys.has(key) && !this.taughtConversationCues.has(key)) {
          // Excite the field with the utterance so the answer stores under a
          // real cue orientation — never store into a quiescent field.
          this.session.settleField();
          this.session.observeText(utterance);
          this.session.observer.tick(0.02);
          const trace = this.session.storeMemory(answer.trim(), {
            metadata: { kind: 'creative', uttered: key, score }
          });
          if (trace !== null) {
            this.creativeMemoryIds.add(trace.id);
            this.creativeUtteredKeys.add(key);
            stored = true;
          }
        }
        // OPERATOR DISCOVERY: a strong answer is a pattern demonstration.
        // The learner itself dedups identical demonstrations (replay guard).
        this.operatorLearner.learn(utterance, answer, score);
      }

      // A weak creative answer is a GAP: the observer could not answer this
      // utterance, so it becomes learning material for the self-teaching loop.
      if (score <= CREATIVE_WEAKEN_SCORE && utterance.trim().length > 0) {
        // A weak creative answer is a GAP: the observer could not answer this
        // utterance, so it becomes learning material for the self-teaching loop.
        this.recordGap(utterance);
        // LEARNED GRADIENT: a weak composition credits compose as a loss.
        this.noteBehaviorOutcome('compose', false);
      }
      if (score >= creativeReinforceScore()) {
        // LEARNED GRADIENT: a strong composition credits compose as a win.
        this.noteBehaviorOutcome('compose', true);
        // P8 GRADED-CONFIRMED "NO": a strong answer that IS a negative statement
        // ("No, golf is not a bird.") confirms the falsehood — evidence-backed.
        if (answer.trim().length > 0) {
          const negated = parseNegationStatement(answer.replace(/^no,?\s+/i, ''));
          if (negated !== null) {
            this.storeNegation(negated.subject, negated.predicate, negated.object, answer, 'graded');
          }
        }
      }

      this.maybePersist();
      return stored;
    }

    /**
     * THE GRADER-RELIABILITY GRADING PATH (the LLM teacher, reliability-
     * weighted). Grades a semantically graded answer the way the app now
     * grades everything LLM-graded:
     *
     *   1. BUCKET the grade by criteria — answer type (creative), the FSRS
     *      difficulty band of its seed words, the question template (fade
     *      classification), and the provider name.
     *   2. RULE CHECK — the composition grounding check predicts a band
     *      (fabrication → weak, echo → mid, grounded composition → strong).
     *      Agreeing bands are evidence FOR the bucket; disagreeing bands are
     *      evidence AGAINST it, and the disagreement schedules a RE-GRADE
     *      (the UI's confirmation queue / deferral) whose resolution feeds
     *      the same model.
     *   3. WEIGHT — the bucket's feedback weight scales the feedback deltas
     *      (never the band): low-reliability buckets contribute less to edge
     *      strengthening/weakening and memory updates.
     *   4. The grade's own LLM score is recorded with the authored answer, so
     *      later WORLD feedback (a re-ask contradicting a strong grade, a
     *      retention confirming it) counts as agreement evidence too.
     *
     * Returns what was applied and whether a re-grade is pending — the caller
     * reports the pending disagreement instead of silently overruling it.
     */
    gradeCreativeWithReliability(
      provenance: AnswerProvenance | readonly string[],
      score: number | null,
      utterance: string,
      answer: string,
      provider: string
    ): { stored: boolean; weight: number; disagreement: boolean; regradeId: string | null } {
      const producers: AnswerProvenance = Array.isArray(provenance)
        ? { traceIds: [...(provenance as readonly string[])], edges: [] }
        : (provenance as AnswerProvenance);
      if (score === null) {
        return { stored: false, weight: 1, disagreement: false, regradeId: null };
      }

      const bank = this.session.observer.getMemoryBank();
      const seedContents: string[] = [];
      for (const traceId of producers.traceIds) {
        const trace = bank.get(traceId);
        if (trace !== undefined && !seedContents.includes(trace.content)) seedContents.push(trace.content);
      }

      const criteria: GradeCriteria = {
        answerType: 'creative',
        difficultyBand: this.difficultyBandOfSeeds(producers.traceIds),
        template: classifyUtterance(utterance),
        provider
      };

      // The rule-based check: the composition's grounding predicts its band.
      // No seeds = no check (a seedless grade is uncheckable, not suspect).
      const ruleBand = seedContents.length > 0 ? ruleBandForGrounding(groundingScore(answer, seedContents)) : null;
      const llmBand = gradeBandOf(score);
      const agree = bandsAgree(llmBand, ruleBand);
      this.reliabilityModel.recordAgreement(criteria, agree);
      // Phase 24.3 (read-only): the creative band gates' calibration evidence.
      if (ruleBand !== null) this.calibration.record('creative-grade', score, agree);

      // Disagreement → schedule the re-grade (the resolution updates the
      // model). The feedback below is applied DAMPED, never withheld.
      let regradeId: string | null = null;
      if (ruleBand !== null && !agree) {
        regradeId = this.reliabilityModel.scheduleRegrade(criteria, {
          utterance,
          answer,
          llmScore: score,
          llmBand,
          ruleBand,
          reason:
            ruleBand === 'weak'
              ? 'the answer grounds on none of its seeds — fabrication'
              : ruleBand === 'mid'
                ? 'the answer echoes its seeds — no composition happened'
                : 'the answer composes its seeds — the rule check expects a strong grade'
        });
      }

      // The grade's own band travels with the authored answer so later world
      // verdicts (re-ask / retention) can confirm or contradict it — and L2
      // (20.3): the STUDENT's band travels too, so the same world verdicts
      // measure the composite judge under the same bucket.
      if (utterance.trim().length > 0) {
        const authored = this.previousAnswerFor(utterance);
        if (authored !== undefined) {
          const composite = compositeScore(answer, utterance, this.compositionWeights, seedContents).composite;
          this.authoredAnswers.set(utterance.trim().toLowerCase(), {
            traceIds: authored.traceIds,
            at: authored.at,
            score,
            provider,
            template: criteria.template,
            compositeBand: composite > 0 ? gradeBandOf(composite) : null
          });
        }
      }

      const weight = this.reliabilityModel.feedbackWeight(criteria);
      const stored = this.creativeGradeFeedback(producers, score, utterance, answer, weight);
      return { stored, weight, disagreement: !agree, regradeId };
    }

    /** Note a creative answer the observer itself produced (the seed traces
     *  it was composed from + when). */
    protected noteAuthoredAnswer(utterance: string, seedTraceIds: string[]): void {
      const key = utterance.trim().toLowerCase();
      if (key.length === 0) return;
      this.authoredAnswers.set(key, { traceIds: seedTraceIds, at: Date.now() });
    }

    /** The answer the observer last gave for an utterance (for re-ask credit). */
    protected previousAnswerFor(utterance: string): { traceIds: string[]; at: number; score?: number | null; provider?: string | null; template?: string | null; compositeBand?: GradeBand | null } | undefined {
      return this.authoredAnswers.get(utterance.trim().toLowerCase());
    }

    /** The reliability criteria of an authored answer, rebuilt at world-
     *  feedback time. The provider and the question template travel with the
     *  entry (captured at grade time); the difficulty band comes from the
     *  seeds' FSRS state. */
    protected worldFeedbackCriteria(authored: { traceIds: string[]; provider?: string | null; template?: string | null }, utterance: string): GradeCriteria {
      return {
        answerType: 'creative',
        difficultyBand: this.difficultyBandOfSeeds(authored.traceIds),
        template: authored.template ?? classifyUtterance(utterance),
        provider: authored.provider ?? ''
      };
    }

    /** RE-ASK CREDIT: the user asked this again — the prior answer failed.
     *  Weaken the composition paths it used (the same gradient the LLM's weak
     *  grade applies), and record the miss as an unanswered gap. */
    protected creditReAsk(utterance: string): void {
      const prior = this.previousAnswerFor(utterance);
      if (prior === undefined) return;
      // GRADER RELIABILITY — WORLD FEEDBACK: the world just contradicted the
      // prior answer. A grade that called it STRONG was wrong; a grade that
      // called it WEAK was right. Counted as weak evidence — the world
      // confirms slowly, and this bucket's reliability moves only a little.
      if (typeof prior.score === 'number') {
        this.reliabilityModel.recordWorldFeedback(
          this.worldFeedbackCriteria(prior, utterance),
          gradeBandOf(prior.score) !== 'strong'
        );
      }
      // L2 (20.3): the same world verdict measures the COMPOSITE judge — a
      // re-ask contradicts a composite that called the answer strong.
      if (prior.compositeBand !== undefined && prior.compositeBand !== null) {
        this.reliabilityModel.recordJudgeAgreement(
          JUDGE_COMPOSITE,
          this.worldFeedbackCriteria(prior, utterance),
          prior.compositeBand !== 'strong',
          WORLD_FEEDBACK_WEIGHT
        );
      }
      const bank = this.session.observer.getMemoryBank();
      const contents: string[] = [];
      for (const id of prior.traceIds) {
        const trace = bank.get(id);
        if (trace !== undefined) contents.push(trace.content);
      }
      if (contents.length > 0) {
        // L1b: the re-ask is the world's full-strength weaken — the helper's
        // weak extreme (creativeGradeDelta(0) = −CREATIVE_GRADE_DELTA).
        bumpAgedWeights(this.compositionWeights, this.compositionWeightMeta, contents, creativeGradeDelta(0));
      }
      for (const id of prior.traceIds) {
        const trace = bank.get(id);
        if (trace !== undefined) bank.reinforce(id, creativeGradeDelta(0));
      }
      // The gap is recorded by the ask path itself — never double-bump.
    }

    /** RETENTION CREDIT: this trace was recalled again later — the answer was
     *  worth keeping. Reinforce its composition paths by the small retention
     *  delta (a weaker, cumulative signal than the LLM grade — the world
     *  confirms slowly, the teacher confirms sharply). */
    creditRetention(traceId: string): void {
      const trace = this.session.observer.getMemoryBank().get(traceId);
      if (trace === undefined) return;
      // GRADER RELIABILITY — WORLD FEEDBACK: the world kept this answer. A
      // grade that called it STRONG is confirmed; a grade that called it WEAK
      // was wrong. The authored answer that stored it carries the grade.
      for (const authored of this.authoredAnswers.values()) {
        if (!authored.traceIds.includes(traceId) || typeof authored.score !== 'number') continue;
        this.reliabilityModel.recordWorldFeedback(
          this.worldFeedbackCriteria(authored, trace.content),
          gradeBandOf(authored.score) === 'strong'
        );
        // L2 (20.3): retention confirms a composite that called it strong.
        if (authored.compositeBand !== undefined && authored.compositeBand !== null) {
          this.reliabilityModel.recordJudgeAgreement(
            JUDGE_COMPOSITE,
            this.worldFeedbackCriteria(authored, trace.content),
            authored.compositeBand === 'strong',
            WORLD_FEEDBACK_WEIGHT
          );
        }
        break;
      }
      // L1b: retention is the world's slow confirm — the helper's strong
      // extreme (creativeGradeDelta(1) = +CREATIVE_GRADE_DELTA) × the
      // retention fraction.
      bumpAgedWeights(this.compositionWeights, this.compositionWeightMeta, [trace.content], creativeGradeDelta(1) * RETENTION_FRACTION);
      this.session.observer.getMemoryBank().reinforce(traceId, creativeGradeDelta(1) * RETENTION_FRACTION);
    }

    /** Feed a freshly measured bench agreement (7a Spearman window) into the
     *  kernel as composite-judge evidence: a window at/above the strong band
     *  agrees, below it disagrees. The raw value is kept as telemetry. */
    noteFadeAgreement(cls: GradeClass, agreement: number): void {
      this.fadeAgreementTelemetry[cls] = agreement;
      this.reliabilityModel.recordJudgeAgreement(JUDGE_COMPOSITE, fadeCriteria(cls), agreement >= GRADE_STRONG_THRESHOLD);
    }

    /** L2 (20.4) MIGRATION: a legacy record's stored per-class λ becomes
     *  equivalent kernel evidence — 20 samples at the stored agreement rate —
     *  so an upgraded observer keeps its earned handover instead of resetting
     *  to scaffolded. (Additive: runs once per restored legacy record; new
     *  records carry no fadeState.) */
    seedLegacyFadeState(fade: { lambda?: Record<string, number> }): void {
      if (typeof fade.lambda !== 'object' || fade.lambda === null) return;
      for (const cls of ['conversational', 'operator', 'other'] as const) {
        const lambda = fade.lambda[cls];
        if (typeof lambda !== 'number' || !Number.isFinite(lambda) || lambda <= 0) continue;
        const criteria = fadeCriteria(cls);
        const mass = 20;
        const agreeMass = clampRange(lambda, 0, 1) * mass;
        if (agreeMass > 0) this.reliabilityModel.recordJudgeAgreement(JUDGE_COMPOSITE, criteria, true, agreeMass);
        if (mass - agreeMass > 0) this.reliabilityModel.recordJudgeAgreement(JUDGE_COMPOSITE, criteria, false, mass - agreeMass);
      }
    }

    /** The latest measured bench agreement per class (telemetry). */
    fadeAgreements(): Record<GradeClass, number | null> {
      return { ...this.fadeAgreementTelemetry };
    }

    /** The current per-class λ (read-only) — DERIVED from the trust kernel. */
    fadeLambdas(): Record<GradeClass, number> {
      return {
        conversational: this.reliabilityModel.lambdaFor(fadeCriteria('conversational')),
        operator: this.reliabilityModel.lambdaFor(fadeCriteria('operator')),
        other: this.reliabilityModel.lambdaFor(fadeCriteria('other'))
      };
    }

    /** Teacher-dependence rate (20.5): the traffic-weighted mean TEACHER SHARE
     *  (1 − λ) over graded answers. 0 = fully handed-over; 1 = fully
     *  scaffolded; 0 before any graded traffic. */
    teacherDependenceRate(): number {
      if (this.lambdaTraffic.count === 0) return 0;
      return clampRange(1 - this.lambdaTraffic.sum / this.lambdaTraffic.count, 0, 1);
    }

    /** The blended reward for a graded answer: λ·composite + (1−λ)·teacher,
     *  with λ the EMERGENT handover weight (normalized trust, L2). The
     *  student's composite is also a MEASURED JUDGE (20.3): its band is
     *  checked against the rule-based grounding band right here, so every
     *  graded answer feeds the very trust that λ is computed from.
     *
     *  The composite is the student's judgment ON ITS OWN MATERIAL: it must be
     *  computed against the answer's actual SEEDS (the recalled memories the
     *  composition was built from). Grading the answer against itself as its
     *  own seed collapses novelty to 0 and the composite to 0, and the
     *  blendReward guard passes the teacher grade through — the abstention
     *  path (subsuming the old isUncertain fallback: the composite is
     *  multiplicative, so fluency 0 ⇒ composite 0 ⇒ teacher grades). */
    fadeReward(utterance: string, answer: string, teacherGrade: number, seeds: readonly string[]): number {
      const cls = classifyUtterance(utterance);
      const criteria = fadeCriteria(cls);
      const { composite } = compositeScore(answer, utterance, this.compositionWeights, seeds);
      // 20.3: the composite judges — measure it. Only when it HAS an opinion
      // (composite > 0) and a rule check exists (seeds present): an abstaining
      // judge earns no evidence either way.
      if (composite > 0 && seeds.length > 0 && answer.trim().length > 0) {
        const ruleBand = ruleBandForGrounding(groundingScore(answer, seeds));
        this.reliabilityModel.recordJudgeAgreement(
          JUDGE_COMPOSITE,
          criteria,
          bandsAgree(gradeBandOf(composite), ruleBand)
        );
      }
      const lambda = this.reliabilityModel.lambdaFor(criteria);
      // Dependence accounting (20.5): the teacher's share of THIS reward. A
      // composite with no opinion consults the teacher fully (λ-effective 0).
      const effective = composite > 0 ? lambda : 0;
      this.lambdaTraffic.sum += effective;
      this.lambdaTraffic.count += 1;
      return blendReward(teacherGrade, composite, lambda);
    }
  };
}
