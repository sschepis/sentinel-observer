/**
 * MOTIVATION FACULTY - drives, gaps, curiosity, verify (agent split refactor).
 *
 * The observer's evaluative layer: learned drive weights over archetypal
 * behaviors, the curiosity pressure that turns gaps into questions, and the
 * VERIFY drive (belief-contradiction checks against the field). State
 * (behaviorWeights/behaviorOutcomes/behaviorOutcomeAt, the gap, encounter,
 * exposure, cueConfidence and curiosityAsked sets, calibration, ...) lives on
 * TeacherAgentCore.
 */
import { TeacherAgentCore, type Constructor, type CrossFacultyApi } from './base';
import {
  clusterGaps
} from '../operators';
import {
  computeDrives,
  chooseBehavior,
  updateDriveWeight,
  ARCHETYPAL_BEHAVIORS,
  type DriveSignals,
  type DriveState,
  type BehaviorOption,
  type BehaviorWeights
} from '../drives';
import {
  extractUnknownSubject,
  tokenizeText
} from '../context';
import {
  VERIFY_UNLOCK_THRESHOLD,
  matchesCue
} from './support';

export function MotivationMixin<TBase extends Constructor<TeacherAgentCore & CrossFacultyApi>>(Base: TBase) {
  return class MotivationFaculty extends Base {

    /**
     * Record an utterance the observer could not answer (a GAP). Gaps are
     * persisted as traces (kind: 'gap') so a later session can teach them —
     * the observer learns from the conversations it actually had.
     */
    recordGap(utterance: string): void {
      const key = utterance.trim().toLowerCase();
      if (key.length === 0 || this.taughtConversationCues.has(key)) return;
      if (this.gapUtterances.has(key)) {
        // The observer keeps failing this — the curiosity engine notices.
        const misses = (this.gapMissCounts.get(key) ?? 1) + 1;
        this.gapMissCounts.set(key, misses);
        // BELIEF: repeated failure of the same utterance becomes a memory
        // about the observer's own ignorance — "I keep failing X."
        if (misses === 2) {
          this.storeBelief(key, `I keep failing ${key}.`, 'fail', { misses });
        }
        return;
      }
      this.gapUtterances.add(key);
      this.gapMissCounts.set(key, 1);
      // Excited under the utterance so the gap is a real memory of what was
      // heard but not understood.
      this.session.settleField();
      this.session.observeText(utterance);
      this.session.observer.tick(0.02);
      const trace = this.session.storeMemory(utterance.trim(), {
        metadata: { kind: 'gap', uttered: key }
      });
      if (trace !== null) this.gapTraceIds.add(trace.id);
      this.maybePersist();
    }

    /** Every un-answered utterance currently waiting to be taught. */
    listGaps(): string[] {
      return [...this.gapUtterances];
    }

    /**
     * Drop a gap without teaching it — for utterances that were exam items,
     * not questions to the teacher (the drill layer records the RULE gap
     * instead of the instances it just tested).
     */
    forgetGap(utterance: string): void {
      const key = utterance.trim().toLowerCase();
      if (!this.gapUtterances.has(key)) return;
      this.gapUtterances.delete(key);
      this.gapMissCounts.delete(key);
      for (const traceId of this.gapTraceIds) {
        const trace = this.session.observer.getMemoryBank().get(traceId);
        if (trace?.metadata?.uttered === key) {
          this.gapTraceIds.delete(traceId);
          break;
        }
      }
    }

    /**
     * Teach the observer how to answer a previously-recorded gap. Removes the
     * gap once the exchange is memorized.
     */
    teachGap(cue: string, response: string): string | null {
      const key = cue.trim().toLowerCase();
      const traceId = this.teachResponse({ cue, response });
      if (traceId !== null) {
        this.gapUtterances.delete(key);
        // The repeated-miss pressure is resolved with the gap.
        this.gapMissCounts.delete(key);
        // LEARNED GRADIENT: a gap that got taught and memorized is a
        // successful ASK — curiosity paid off.
        this.noteBehaviorOutcome('ask', true);
      }
      return traceId;
    }

    // ── Drive signals (archetypal resonance targets) ─────────────────────────

    /** Curiosity pressure: unanswered gaps + frequently-heard undefined words +
     *  stored fail-beliefs (the observer's own memory of repeated ignorance
     *  feeds its curiosity — beliefs as inputs to the drives). */
    curiosityPressure(): number {
      let pressure = 0;
      for (const misses of this.gapMissCounts.values()) pressure += misses;
      for (const count of this.encounterCounts.values()) pressure += count;
      for (const belief of this.deficitBeliefs()) pressure += 2;
      return pressure;
    }

      /** How many times a content word has been heard in conversation. */
    exposureOf(word: string): number {
      return this.exposureCounts.get(word) ?? 0;
    }

    /** Unanswered gaps, most-missed first (introspection + curiosity fuel). */
    gapList(): string[] {
      return [...this.gapMissCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([gap]) => gap);
    }

    /**
     * Cluster gaps by shared content tokens — the observer can see DOMAINS of
     * ignorance, not just a queue of tokens.
     */
    gapClusters(): Array<{ words: string[]; members: string[] }> {
      return clusterGaps(this.gapList());
    }

    /** Conservation: fraction of memory above the retention floor (P9 —
     *  strength IS the model's prediction, so "strong" means retained). */
    conservationPressure(): number {
      const bank = this.session.observer.getMemoryBank();
      let strong = 0;
      let total = 0;
      for (const trace of bank.all()) {
        total += 1;
        if (trace.strength >= 0.5) strong += 1;
      }
      return total === 0 ? 0 : strong / total;
    }

    /** Novelty: how much of the utterance is new vs the recent context. */
    noveltyOf(utterance: string): number {
      const probe = utterance.trim();
      const recent = new Set(
        this.workingMemory
          .recent(6)
          .filter((turn) => turn.text.trim() !== probe)
          .flatMap((turn) => tokenizeText(turn.text))
      );
      const tokens = tokenizeText(utterance);
      if (tokens.length === 0) return 0;
      const novel = tokens.filter((token) => token.length > 2 && !recent.has(token)).length;
      return Math.min(1, novel / Math.max(1, tokens.length));
    }

    /** Coherence + self-consistency from a fresh recall of the utterance. */
    recallCoherence(utterance: string): { coherence: number; selfConsistency: number } {
      const answer = this.respond(utterance);
      if (answer.response === null || answer.confidence === null) {
        return { coherence: 0, selfConsistency: 0 };
      }
      const questionKey = utterance.trim().toLowerCase();
      const cueKey = (answer.cue ?? '').toLowerCase();
      const consistent = matchesCue(questionKey, cueKey);
      return { coherence: answer.confidence, selfConsistency: consistent ? 1 : 0.5 };
    }

    /** The drive vector for an utterance — the archetypes as numbers. */
    driveSignals(utterance: string): DriveSignals {
      const recall = this.recallCoherence(utterance);
      return {
        coherence: recall.coherence,
        // 2 repeated misses or encounters already reads as real pressure.
        curiosity: Math.min(1, this.curiosityPressure() / 4),
        novelty: this.noveltyOf(utterance),
        conservation: this.conservationPressure(),
        selfConsistency: recall.selfConsistency
      };
    }

    /**
     * READ-ONLY drive snapshot for visualization: never excites the field or
     * touches memory (safe to call during render / on a timer without
     * perturbing the learning process). Coherence comes from the live field
     * metrics; curiosity/novelty/conservation from counters and the bank.
     */
    driveSignalsStatic(): DriveSignals {
      return {
        coherence: this.observerState()?.coherence ?? 0,
        curiosity: Math.min(1, this.curiosityPressure() / 4),
        novelty: this.noveltyOf(this.workingMemory.recent(1)[0]?.text ?? 'hello'),
        conservation: this.conservationPressure(),
        selfConsistency: 0
      };
    }

    /** The drive state, normalized. */
    drives(utterance: string): DriveState {
      return computeDrives(this.driveSignals(utterance));
    }

    /** Drive-weighted choice between the possible next behaviors. The
     *  available set is the ACQUIRED-SET gate: 'verify' is not even
     *  considered until experience has contradicted enough beliefs. When the
     *  gate excludes EVERY option, answering is the sane default — never a
     *  silent bypass of the gate (chooseBehavior returns null in that case). */
    chooseNext(utterance: string, options: readonly BehaviorOption[]): BehaviorOption {
      // M4 (21.2): arbitration explores — Boltzmann sampling at the drive
      // temperature, on the session-seeded stream (deterministic per seed).
      const choice = chooseBehavior(this.drives(utterance), options, this.behaviorWeights, this.availableBehaviors(), this.arbitrationRng);
      return choice ?? 'answer';
    }

    /** The learned arbitration weights (read-only snapshot). */
    driveWeights(): BehaviorWeights {
      return { ...this.behaviorWeights };
    }

    /** The outcome cascade per behavior — credit history (read-only). */
    behaviorOutcomeCounts(): Record<BehaviorOption, { wins: number; losses: number }> {
      return {
        answer: { ...this.behaviorOutcomes.answer },
        ask: { ...this.behaviorOutcomes.ask },
        compose: { ...this.behaviorOutcomes.compose },
        practice: { ...this.behaviorOutcomes.practice },
        verify: { ...this.behaviorOutcomes.verify }
      };
    }

    /** Credit a behavior with an outcome and update its learned weight. */
    noteBehaviorOutcome(option: BehaviorOption, win: boolean): void {
      const record = this.behaviorOutcomes[option];
      if (win) record.wins += 1;
      else record.losses += 1;
      updateDriveWeight(this.behaviorWeights, option, win);
      // L3 (19.3): a fresh outcome restarts the drift clock — the weight is in
      // active use, so it does not decay toward the archetype.
      this.behaviorOutcomeAt.set(option, Date.now());
      this.maybePersist();
    }

    /**
     * PROACTIVE CURIOSITY: the observer asks about something it wants to
     * learn, when it can see its own gaps. Triggers, in priority order:
     *   1. a gap it keeps failing (missed >= 2 times) — ask what its subject
     *      means;
     *   2. a deck word it keeps HEARING without a definition (>= 3
     *      encounters) — ask to be taught it;
     *   3. a practiced phrase whose recall confidence dropped below the
     *      review floor — ask to practice it.
     * Each trigger is asked once (it is consumed). Returns null when nothing
     * is worth asking about.
     */
    curiosityQuestion(): string | null {
      const known = new Set(this.states.keys());

      // 1. Repeatedly-missed gaps (still unanswered — a gap the loop just
      //    taught is no longer worth asking about).
      let bestGap: string | null = null;
      let bestMisses = 0;
      for (const [gap, misses] of this.gapMissCounts) {
        if (misses >= 2 && this.gapUtterances.has(gap) && misses > bestMisses && !this.curiosityAsked.has(`gap:${gap}`)) {
          bestGap = gap;
          bestMisses = misses;
        }
      }
      if (bestGap !== null) {
        this.curiosityAsked.add(`gap:${bestGap}`);
        const subject = extractUnknownSubject(bestGap, known) ?? bestGap;
        return `I do not know what "${subject}" means. Could you teach me about it?`;
      }

      // 1.5 DOMAIN curiosity: several gaps share content words — the observer
      //     asks about the domain, not just a token.
      const clusters = this.gapClusters();
      if (clusters.length > 0) {
        const best = clusters[0];
        if (best.members.length >= 2) {
          const key = `domain:${best.words.slice(0, 3).join(' ')}`;
          if (!this.curiosityAsked.has(key)) {
            this.curiosityAsked.add(key);
            const teachable = best.words.filter((w) => this.states.has(w)).slice(0, 3);
            if (teachable.length > 0) {
              return `Many of my questions are about ${teachable.join(', ')}. Could you teach me about them?`;
            }
          }
        }
      }

      // 2. Frequently-heard words without definitions.
      for (const [word, count] of this.encounterCounts) {
        if (count >= 3 && !this.curiosityAsked.has(`word:${word}`)) {
          const state = this.states.get(word);
          if (state !== undefined && state.word.definition.trim().length === 0) {
            this.curiosityAsked.add(`word:${word}`);
            return `Can you teach me about "${word}"?`;
          }
        }
      }

      return null;
    }

    /** How many stored beliefs have been contradicted by experience — the
     *  evidence that beliefs can be wrong (persistence-safe: derived from the
     *  bank, so it rebuilds identically on import). */
    beliefContradictions(): number {
      const bank = this.session.observer.getMemoryBank();
      let contradictions = 0;
      for (const trace of bank.all()) {
        // Real belief contradictions only — the plan-failure meta-beliefs
        // (beliefKind 'goal-failed') are not evidence that the observer's
        // self-knowledge was wrong, and must not unlock the verify drive.
        if (
          trace.metadata?.kind === 'belief' &&
          trace.metadata.contradicts === true &&
          trace.metadata.beliefKind !== 'goal-failed'
        ) {
          contradictions += 1;
        }
      }
      return contradictions;
    }

    /** The subject of the most recent contradiction (verification target). */
    verifyCandidate(): string | null {
      const bank = this.session.observer.getMemoryBank();
      let best: string | null = null;
      for (const trace of bank.all()) {
        // Same filter as beliefContradictions — never surface a goal-id as a
        // verification subject (plan-failure meta-beliefs are not subjects).
        if (
          trace.metadata?.kind === 'belief' &&
          trace.metadata.contradicts === true &&
          trace.metadata.beliefKind !== 'goal-failed'
        ) {
          const about = String(trace.metadata.about ?? '');
          if (about.length > 0) best = about;
        }
      }
      return best;
    }

    /** ACQUISITION GATE: enough contradictions teach the observer that its
     *  beliefs can be wrong — the 'verify' drive enters the available pool. */
    verifyUnlocked(): boolean {
      return this.beliefContradictions() >= VERIFY_UNLOCK_THRESHOLD;
    }

    /** The behaviors the observer currently considers available. */
    availableBehaviors(): ReadonlySet<BehaviorOption> {
      const available = new Set<BehaviorOption>(ARCHETYPAL_BEHAVIORS);
      if (this.verifyUnlocked()) available.add('verify');
      return available;
    }
  };
}
