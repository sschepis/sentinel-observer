/**
 * CONVERSATION FACULTY - exchanges, beliefs, working/episodic memory (agent
 * split refactor).
 *
 * The observer's conversational core: taught exchange decks, live respond
 * (which routes to teach / recall / relations / creative / operator paths),
 * stored beliefs about subjects, session working memory, and the episodic
 * memory facade. State (conversationTraceIds, taught/produced cues,
 * beliefsStored, workingMemory, persistedConversationTexts, episodic) lives
 * on TeacherAgentCore.
 */
import { TeacherAgentCore, type Constructor, type CrossFacultyApi } from './base';
import type {
  RecallResult
} from '@sschepis/sentient-core';
import {
  CONVERSATION_RECALL_FLOOR,
  CONVERSATION_EXACT_RECALL_FLOOR,
  CREATIVE_UNLOCK_THRESHOLD,
  type ConversationPair
} from '../conversation';
import {
  WorkingMemory,
  type WorkingTurn
} from '../context';
import {
  type EpisodicFact,
  type RememberedFact
} from '../episodic';
import {
  CONVERSATION_HIGH_CONFIDENCE,
  CONVERSATION_MIN_MARGIN,
  authoritativeRecall,
  type ConversationAnswer,
  type ConversationReport
} from './support';

export function ConversationMixin<TBase extends Constructor<TeacherAgentCore & CrossFacultyApi>>(Base: TBase) {
  return class ConversationFaculty extends Base {

    /**
     * Teach one conversational exchange: the observer hears the CUE, ticks once
     * so the field imprints the cue's orientation, and stores the RESPONSE as a
     * tagged conversation trace. Re-teaching the same cue is a no-op. Very
     * short cues ('hi', 'bye') sometimes leave the field too quiet to store, so
     * the excitation is retried a few times before giving up.
     */
    teachResponse(pair: ConversationPair): string | null {
      const key = pair.cue.toLowerCase();
      if (this.taughtConversationCues.has(key)) return null;

      let lastTraceId: string | null = null;
      for (let attempt = 0; attempt < 3 && lastTraceId === null; attempt += 1) {
        this.session.settleField();
        this.session.observeText(pair.cue);
        this.session.observer.tick(0.02);
        const trace = this.session.storeMemory(pair.response, {
          metadata: { kind: 'conversation', cue: key }
        });
        lastTraceId = trace?.id ?? null;
      }
      if (lastTraceId !== null) {
        // Mark the cue taught only AFTER the store succeeded — a quiescent
        // field must not burn the cue forever (re-teach stays possible).
        this.taughtConversationCues.add(key);
        this.conversationTraceIds.add(lastTraceId);
        this.maybePersist();
        return lastTraceId;
      }
      return null;
    }

    /** Teach every phrase in the conversation deck that is not yet taught. */
    teachConversationDeck(pairs: readonly ConversationPair[]): number {
      let taught = 0;
      for (const pair of pairs) {
        if (this.teachResponse(pair) !== null) taught += 1;
      }
      return taught;
    }

    /**
     * The observer's conversational reply: hear the utterance (excites its
     * primes and aligns the field), recall among CONVERSATION traces only, and
     * speak the best-matching taught response above the recall floor. Nothing
     * confidently recalled is an honest "I haven't learned that yet" — the
     * observer never invents an answer it cannot back with a memory trace.
     */
    respond(utterance: string): ConversationAnswer {
      const cue = utterance.trim().toLowerCase();
      if (cue.length === 0) {
        return { utterance, response: null, confidence: null, traceId: null, cue: null, kind: null };
      }

      this.exciteAndSettle(utterance);
      const results = this.session.recall(utterance, 10);

      // The strongest memory wins — memorized EXCHANGES and memorized CREATIVE
      // answers (stored hybrid/strong compositions) compete on score, so a
      // stored hybrid answer is recalled from memory, not shadowed by a weak
      // partial overlap with some other taught cue.
      let bestConversation: RecallResult | null = null;
      let bestCreative: RecallResult | null = null;
      for (const result of results) {
        const kind = result.trace.metadata?.kind;
        if (kind === 'conversation' && (bestConversation === null || result.score > bestConversation.score)) {
          bestConversation = result;
        } else if (kind === 'creative' && (bestCreative === null || result.score > bestCreative.score)) {
          bestCreative = result;
        }
      }
      let best = bestConversation;
      if (bestCreative !== null && (best === null || bestCreative.score > best.score)) {
        best = bestCreative;
      }

      if (best === null || best.score < CONVERSATION_RECALL_FLOOR) {
        return { utterance, response: null, confidence: null, traceId: null, cue: null, kind: null };
      }

      // The SEPARATION from the best competitor — the honest measure of
      // whether this recall is unambiguous (see CONVERSATION_MIN_MARGIN).
      let runnerUp = 0;
      for (const result of results) {
        if (result.trace.id === best.trace.id) continue;
        if (result.score > runnerUp) runnerUp = result.score;
      }
      const margin = best.score - runnerUp;
      const bestKind = best.trace.metadata?.kind === 'creative' ? ('creative' as const) : ('conversation' as const);
      const matchedCue =
        typeof best.trace.metadata?.cue === 'string'
          ? best.trace.metadata.cue
          : typeof best.trace.metadata?.uttered === 'string'
            ? best.trace.metadata.uttered
            : null;
      if (matchedCue !== null && bestKind === 'conversation') {
        // Confidence tracking is a MEASUREMENT of the observer's own recall —
        // it updates on any match, including weak ones the answering layer
        // refuses to speak. The belief fires on the same measurement: a phrase
        // the observer used to recall well and now recalls poorly decays into
        // a memory about its own fading — "I used to recall X better." (the
        // forgetting curve, witnessed by itself).
        this.cueConfidence.set(matchedCue, best.score);
        const previous = this.lastRecallConfidence.get(matchedCue);
        this.lastRecallConfidence.set(matchedCue, best.score);
        if (previous !== undefined && previous >= CONVERSATION_HIGH_CONFIDENCE && best.score < CONVERSATION_RECALL_FLOOR + 0.1) {
          this.storeBelief(matchedCue, `I used to recall ${matchedCue} better.`, 'drop', { previous, current: best.score });
        }
        // The competency numerator, by contrast, counts only PRODUCED answers
        // — the pair counts only when its response was spoken, which is the
        // SAME gate chatAnswer applies before speaking a memorized answer:
        // identity (the recall's cue IS the taught exchange, not a partial
        // overlap) AND high confidence (>= 0.8). A 0.6–0.8 partial overlap
        // the answering layer refuses must not inflate competency toward the
        // creative unlock. A stored creative answer is a novel prompt, not a
        // taught phrase, and must not inflate the numerator past 100% (the
        // bestKind === 'conversation' check above).
        if (authoritativeRecall(best.score, margin, cue, matchedCue)) {
          this.producedConversationCues.add(matchedCue);
        }
      }

      // WORLD RETENTION (Phase 7b): recalling a CREATIVE trace again later is
      // the world confirming the answer was worth keeping — reinforce its
      // composition paths by the small retention fraction (the world confirms
      // slowly; the teacher confirms sharply).
      if (bestKind === 'creative') {
        this.creditRetention(best.trace.id);
      }

      return {
        utterance,
        response: best.trace.content,
        confidence: best.score,
        margin,
        traceId: best.trace.id,
        cue: matchedCue,
        kind: bestKind
      };
    }

    /**
     * CHAT MEMORIZED LAYER ONLY: recall the taught exchange whose cue IS the
     * question, exactly (modulo terminal punctuation). respond() stays the
     * raw, gate-neutral recall that drills and competency measurement
     * exercise; this lookup carries the chat's identity policy — an exact
     * cue match is spoken at the exact-cue floor regardless of near-twin
     * competition, because the recalled trace IS the exchange the question
     * names.
     */
    recallExactExchange(utterance: string): ConversationAnswer {
      const cue = utterance.trim().toLowerCase().replace(/[?!.]+$/, '');
      if (cue.length === 0) {
        return { utterance, response: null, confidence: null, traceId: null, cue: null, kind: null };
      }
      // The field is ALREADY excited for the utterance: chatAnswer calls this
      // immediately after respond(resolved/utterance), whose exciteAndSettle
      // left the field settled. Recall here is a pure read — an extra
      // excitation pass would perturb the field and shift every later recall
      // score (the drill suite's small banks depend on a fixed pass count).
      const results = this.session.recall(cue, 10);
      let target: RecallResult | null = null;
      for (const result of results) {
        if (result.trace.metadata?.kind !== 'conversation') continue;
        const resultCue = result.trace.metadata?.cue;
        if (typeof resultCue === 'string' && resultCue.trim().toLowerCase().replace(/[?!.]+$/, '') === cue) {
          target = result;
          break;
        }
      }
      if (target === null || target.score < CONVERSATION_EXACT_RECALL_FLOOR) {
        return { utterance, response: null, confidence: null, traceId: null, cue: null, kind: null };
      }
      let runnerUp = 0;
      for (const result of results) {
        if (result.trace.id === target.trace.id) continue;
        const kind = result.trace.metadata?.kind;
        if (kind !== 'conversation' && kind !== 'creative') continue;
        if (result.score > runnerUp) runnerUp = result.score;
      }
      return {
        utterance,
        response: target.trace.content,
        confidence: target.score,
        margin: target.score - runnerUp,
        traceId: target.trace.id,
        cue: target.trace.metadata?.cue as string,
        kind: 'conversation'
      };
    }

    /**
     * Conversation competency: the fraction of taught exchanges the observer
     * has actually produced in reply (recall exercises the trace; the pair
     * counts only when its response was spoken). Creative answers unlock when
     * this clears the configured threshold — measured memorization first,
     * then generation.
     */
    conversationReport(): ConversationReport {
      const taught = this.conversationTraceIds.size;
      const recalled = this.producedConversationCues.size;
      const competency = taught === 0 ? 0 : recalled / taught;
      return {
        taught,
        recalled,
        competency,
        creativeUnlocked: competency >= CREATIVE_UNLOCK_THRESHOLD
      };
    }

    /** Every taught conversation exchange (cue + memorized response). */
    listConversationPairs(): ConversationPair[] {
      const bank = this.session.observer.getMemoryBank();
      const pairs: ConversationPair[] = [];
      for (const traceId of this.conversationTraceIds) {
        const trace = bank.get(traceId);
        if (trace === undefined) continue;
        const cue = trace.metadata?.cue;
        if (typeof cue === 'string') pairs.push({ cue, response: trace.content });
      }
      return pairs;
    }

    // ── BELIEF TRACES: the observer's own states as memories ──────────────────
    //
    // The introspection operators REPORT quantities; belief traces make them
    // MEMORIES — stor eable, decayable, recallable content about the observer
    // itself, through the identical associative machinery as world knowledge.
    // "I know water well." is not a computed template anymore once it has a
  // trace that reinforcement and decay act on; a failed grade can
    // CONTRADICT it, storing a revising belief and demoting the original.

    storeBelief(
      about: string,
      content: string,
      beliefKind: string,
      basis: Record<string, unknown>,
      contradicts = false
    ): boolean {
      if (about.length === 0) return false;
      const key = `${beliefKind}:${about}`;
      if (this.beliefsStored.has(key)) return false;
      // Same storage discipline as teach: settle the residue first, EXCITE
      // with the subject, then store — memory is NEVER stored into a
      // quiescent field (a belief about an inactive state is invented).
      this.session.settleField();
      this.session.observeText(about);
      this.session.observer.tick(0.02);
      const trace = this.session.storeMemory(content.trim(), {
        metadata: { kind: 'belief', beliefKind, about, basis, contradicts }
      });
      if (trace === null) return false;
      this.beliefsStored.add(key);
      this.maybePersist();
      return true;
    }

    /** All stored belief traces about a subject, most recent first. */
    beliefsOf(about: string): Array<{
      traceId: string;
      content: string;
      beliefKind: string;
      contradicts: boolean;
      basis: Record<string, unknown>;
      strength: number;
    }> {
      const bank = this.session.observer.getMemoryBank();
      return bank
        .all()
        .filter((trace) => trace.metadata?.kind === 'belief' && trace.metadata.about === about)
        .reverse()
        .map((trace) => ({
          traceId: trace.id,
          content: trace.content,
          beliefKind: String(trace.metadata.beliefKind ?? ''),
          contradicts: trace.metadata.contradicts === true,
          basis: (trace.metadata.basis ?? {}) as Record<string, unknown>,
          strength: trace.strength
        }));
    }

    /** The most recent belief about a subject (or null). */
    latestBelief(about: string): {
      traceId: string;
      content: string;
      beliefKind: string;
      contradicts: boolean;
      basis: Record<string, unknown>;
      strength: number;
    } | null {
      return this.beliefsOf(about)[0] ?? null;
    }

    /** The belief-facing view for the self-knowledge operator. */
    protected beliefAboutForOperator(word: string): { content: string; contradicts: boolean } | null {
      const belief = this.latestBelief(word);
      return belief === null ? null : { content: belief.content, contradicts: belief.contradicts };
    }

    /** Record a turn in the working-memory window (used by external drivers).
     *  User turns are also observed by the episodic memory — a driver that
     *  bypasses chatAnswer must still feed the selective journal. */
    noteTurn(role: 'user' | 'observer', text: string): void {
      this.workingMemory.note(role, text);
      this.episodic.observeTurn(role, text);
    }

    /**
     * Perturb the field with external text — the council's "observing each
     * other". A transient excitation: the field is excited and settled, and
     * nothing is stored. Rotation of the moment changes what the next
     * creative recall resonates with; memory itself is untouched.
     */
    perturb(text: string): void {
      if (text.trim().length === 0) return;
      this.session.observeText(text);
      this.session.settleField();
    }

    /** The recent conversation window (for the UI context line). */
    getWorkingMemory(): WorkingTurn[] {
      return this.workingMemory.all();
    }

    /** Every stored episodic fact (read-only — the selective journal). */
    episodicFacts(): readonly EpisodicFact[] {
      return this.episodic.all();
    }

    /** The episodic facts clearly relevant to an utterance, tagged as
     *  remembered (topic-gated, salience-ranked). Consumed by the hybrid
     *  voice and any caller that needs the long-term context. */
    episodicRecall(utterance: string, topK = 3): RememberedFact[] {
      return this.episodic.recall(utterance, { topK });
    }

    /** Stored deficit beliefs ("I keep failing X") — the planner's raw feed. */
    deficitBeliefs(): Array<{ about: string; content: string }> {
      const bank = this.session.observer.getMemoryBank();
      const out: Array<{ about: string; content: string }> = [];
      for (const trace of bank.all()) {
        if (trace.metadata?.kind !== 'belief' || trace.metadata.beliefKind !== 'fail') continue;
        const about = String(trace.metadata.about ?? '');
        if (about.length > 0) out.push({ about, content: trace.content });
      }
      return out;
    }
  };
}
