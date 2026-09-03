/**
 * RELATIONS FACULTY — graph, hypothesis tier, negations, hologram (agent
 * split refactor).
 *
 * The observer's relational world: lazy extraction over the deck, the
 * reconciled derived graph (symbolic relations() + corroboration overlays +
 * a bounded HYPOTHESIS tier that promotion admits only under corroboration),
 * confirmed-false negations, and the distributed-vector relational hologram.
 * State lives on TeacherAgentCore (relationsCache, chaperoneRelations,
 * edgeConfidence, edgeSources, hypothesisEdges, exampleIndex,
 * persistedConversationTexts, negations, resolvedSweepConflicts,
 * relationalHologram, hiddenRelationKeys).
 */
import { TeacherAgentCore, type Constructor, type CrossFacultyApi } from './base';
import {
  questionFormOf,
  type OperatorResult
} from '../operators';
import {
  hedgeComposition,
  framesFor
} from '../groundedFrames';
import {
  readText
} from '../reading';
import {
  extractRelations,
  mergeRelations,
  reconcileRelations,
  predicateVerb,
  sourceClassForOrigin,
  type Relation,
  type RelationPredicate,
  type Negation,
  type SourceClass
} from '../relations';
import {
  corroborationConfidence,
  distinctClasses,
  evidenceInText
} from '../corroboration';
import {
  RelationalHologram
} from '@sschepis/sentient-core';
import {
  technicalRelations
} from '../technical';
import {
  SUPPLEMENTAL_RELATIONS
} from '../decks/relationSupplements';
import {
  GROUNDED_FACTS_RELATIONS
} from '../decks/groundedFacts';
import {
  tokenizeText,
  singularize
} from '../context';
import {
  SWEEP_RESOLVED_CAP,
  edgeKey,
  READING_WORD_BUDGET
} from './support';

export function RelationsMixin<TBase extends Constructor<TeacherAgentCore & CrossFacultyApi>>(Base: TBase) {
  return class RelationsFaculty extends Base {

    /** Drop the cached edge graph so the next read re-extracts (definitions
     *  may have changed, or chaperone edges arrived). Also drops the example
     *  corpus index — it is derived from the taught states like the graph. */
    invalidateRelations(): void {
      this.relationsCache = null;
      this.exampleIndex = null;
    }

    /**
     * The authored edge pool: the technical curriculum plus the everyday and
     * grounded-facts supplements, filtered to words the observer knows (memory
     * is the source of truth for what exists) and with the curriculum-only
     * 'special-case-of' folded into 'is-a' so inheritance walks it. Shared by
     * relations() and applyRelations() so both merge the identical pool.
     */
    protected authoredRelationPool(): Relation[] {
      return [...technicalRelations(), ...SUPPLEMENTAL_RELATIONS, ...GROUNDED_FACTS_RELATIONS]
        .filter((relation) => this.knownWords.has(relation.subject) && this.knownWords.has(relation.object))
        .map((relation): Relation => relation.predicate === 'special-case-of'
          ? { ...relation, predicate: 'is-a' }
          : relation);
    }

    /**
     * Ingest chaperone-supplied edges: cross-check against the regex extractor,
     * keep the agreed + LLM-only edges in the graph, and turn any same-predicate
     * DISAGREEMENT into a belief to verify (never a silent override of the
     * precision-first regex edge). Subjects the observer does not know are
     * dropped — memory is the source of truth for what exists.
     */
    /** The grounded frames a subject can fill from the relation graph — the
     *  observer's own words about something it has edges for. */
    protected framesForSubject(subject: string): string[] {
      return framesFor(subject, this.relations(), {
        negations: this.negations,
        cost: this.compositionCost,
        extraRules: this.compositionRules.admitted()
      });
    }

    /** Speak what the graph holds about a subject, hedged by corroboration
     *  (a claim read in one book stays "I think" until something independent
     *  confirms it). Never called without frames — absence stays an ask. */
    protected speakFromFrames(subject: string): string {
      // A NAME takes no article: the frames say "A zeus is a god" because the
      // frame grammar is written for common nouns. Proper entities (read from
      // history and mythology, absent from the deck) drop it.
      const isName = !this.knownWords.has(subject);
      const frames = this.framesForSubject(subject)
        .slice(0, 3)
        .map((frame) => (isName ? frame.replace(/^An?\s+/, (match) => (match === 'A ' || match === 'An ' ? '' : match)) : frame))
        .map((frame, index) => (isName && index === 0 ? frame.charAt(0).toUpperCase() + frame.slice(1) : frame));
      const spoken = hedgeComposition(frames.join(' ').replace(/\s+([.!?])/g, '$1'), this.relations());
      return spoken.sentence;
    }

    /**
     * READ CONTINUOUS TEXT — the non-conversational learning path.
     *
     * The passage is parsed by the reading grammar (the critic's claim grammar
     * run in reverse), and what it yields flows through the SAME machinery a
     * chaperone's edges do: agreement with the existing graph is corroborating
     * evidence, genuinely new edges are kept with 'reading' provenance (so a
     * single book is one source class and its claims are spoken hedged until
     * something independent confirms them), and same-predicate disagreements
     * become beliefs to verify instead of silent overwrites.
     *
     * Explicit denials ("a whale is not a fish") are stored as confirmed-false
     * statements, and every unknown content word is recorded as a gap — the
     * observer reads, notices what it cannot understand, and can ask about it.
     */
    readFrom(text: string, source = 'reading'): {
      sentencesRead: number;
      sentencesParsed: number;
      relationsFound: number;
      accepted: number;
      conflicts: number;
      negations: number;
      /** Deck words the passage taught by using them (definitions stored). */
      wordsLearned: string[];
      unknownWords: Array<{ word: string; count: number }>;
    } {
      const result = readText(text, { vocabulary: this.knownWords, source });
      // MEETING A WORD IN CONTEXT IS A LESSON. A reader with a dictionary
      // learns the words the page is about: every deck word that carried a
      // claim gets taught (its curriculum definition stored) so the observer
      // can define it, not only state facts about it. Bounded per passage so
      // one book cannot flood the bank.
      const wordsLearned: string[] = [];
      for (const relation of result.relations) {
        for (const word of [relation.subject, relation.object]) {
          if (wordsLearned.length >= READING_WORD_BUDGET) break;
          const state = this.states.get(word);
          if (state === undefined || state.traceId !== null || wordsLearned.includes(word)) continue;
          this.teach(word);
          wordsLearned.push(word);
        }
      }
      const { accepted, conflicts } = this.applyRelations(result.relations, { allowUnknownSubjects: true });
      for (const negation of result.negations) {
        this.storeNegation(negation.subject, negation.predicate, negation.object, `${source}: ${negation.sentence}`, 'reading');
      }
      // The reading list: unknown words the passage exposed, most frequent
      // first — the curriculum's next lesson and the observer's next question.
      const unknownWords = [...result.unknownWords.entries()]
        .map(([word, count]) => ({ word, count }))
        .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));
      for (const { word } of unknownWords.slice(0, 32)) this.recordGap(word);
      this.relationsCache = null;
      return {
        sentencesRead: result.sentencesRead,
        sentencesParsed: result.sentencesParsed,
        relationsFound: result.relations.length,
        accepted,
        conflicts,
        negations: result.negations.length,
        wordsLearned,
        unknownWords
      };
    }

    applyRelations(
      relations: readonly Relation[],
      options: { allowUnknownSubjects?: boolean } = {}
    ): { accepted: number; conflicts: number } {
      if (relations.length === 0) return { accepted: 0, conflicts: 0 };
      // Memory is normally the source of truth for what exists — an edge about
      // a subject the observer never met is dropped. READING is the exception:
      // history, mythology and literature are about NAMED ENTITIES ("Zeus",
      // "Nero", "Iliad") that no dictionary deck contains. The observer may
      // hold and state what it read about them while honestly having no
      // definition to recite.
      const relevant = options.allowUnknownSubjects === true
        ? relations
        : relations.filter((relation) => this.knownWords.has(relation.subject));
      const extracted = extractRelations(
        [...this.states.values()].map((s) => ({ word: s.word.word, definition: s.word.definition }))
      );
      const authored = this.authoredRelationPool();
      // Reconcile against the FULL precision-first graph (regex + authored),
      // not just the regex extractor — a same-predicate disagreement with the
      // technical curriculum is a belief to verify too.
      const { agreed, llmOnly, conflicts } = reconcileRelations(mergeRelations(extracted, authored), relevant);

      // P8/P14: AGREEMENT is evidence — a chaperone edge that matches an
      // existing one bumps that edge's confidence (+1 per agreeing source)
      // AND adds the LLM-definition source class, corroborating the claim
      // across independent classes (hedging is removed on the next read).
      for (const relation of agreed) {
        this.bumpEdge(relation.subject, relation.predicate, relation.object, +1);
        this.addEdgeSource(relation.subject, relation.predicate, relation.object, 'definition');
      }

      let accepted = 0;
      for (const relation of llmOnly) {
        const duplicate = this.chaperoneRelations.some(
          (r) => r.subject === relation.subject && r.predicate === relation.predicate && r.object === relation.object
        );
        if (!duplicate) {
          this.chaperoneRelations.push(relation);
          accepted += 1;
        }
      }

      for (const conflict of conflicts) {
        const content =
          `I was taught that ${conflict.subject} ${predicateVerb(conflict.predicate, conflict.regexObject)} ${conflict.regexObject}, ` +
          `but I also heard it ${predicateVerb(conflict.predicate, conflict.llmObject)} ${conflict.llmObject} — I should check which is true.`;
        this.storeBelief(
          conflict.subject,
          content,
          'relation-conflict',
          { predicate: conflict.predicate, regexObject: conflict.regexObject, llmObject: conflict.llmObject },
          true
        );
      }

      // Seed the cache from the work just done instead of discarding it: the
      // reconcile above already paid for the full-deck extraction and the
      // authored pool, and the next relations() read would otherwise repeat
      // both at 20k-deck scale for an identical result.
      this.buildRelationsCache(extracted, authored);
      return { accepted, conflicts: conflicts.length };
    }

    /**
     * Build the merged relation graph and seed the cache from already-computed
     * ingredients. The confidence overlay and hidden-edge gate are applied
     * here so every caller (fresh read or post-ingest reseed) derives the
     * graph identically.
     */
    protected buildRelationsCache(extracted: readonly Relation[], authored: readonly Relation[]): Relation[] {
      // Provenance priority on ties: regex > authored > chaperone. Chaperone
      // edges that CONFLICTED with a regex edge were already diverted to
      // beliefs in applyRelations, so what lands here is agreed or new.
      this.relationsCache = mergeRelations(extracted, authored, this.chaperoneRelations)
        // P14: corroboration rides the derived graph — every edge carries its
        // source classes (its origin class + the accumulated independent
        // evidence: agreeing chaperone edges, mined conversation evidence,
        // accepted graded answers, curriculum example sentences) and its
        // effective strength (corroboration base + grade/agreement overlay),
        // floored so weakened edges still answer hedged.
        .map((relation) => {
          const key = edgeKey(relation.subject, relation.predicate, relation.object);
          const classes = this.classesFor(relation);
          return {
            ...relation,
            sourceClasses: classes,
            strength: Math.max(
              0.1,
              corroborationConfidence(classes) +
                (this.edgeConfidence.get(key) ?? 0)
            )
          };
        });
      // P12 held-out gate: hidden edges leave the SYMBOLIC graph only — the
      // loose hologram below still binds them, so graded recovery works.
      if (this.hiddenRelationKeys !== null && this.hiddenRelationKeys.size > 0) {
        this.relationsCache = this.relationsCache.filter(
          (relation) =>
            !this.hiddenRelationKeys!.has(edgeKey(relation.subject, relation.predicate, relation.object))
        );
      }
      // M5 (22.2): refresh the HYPOTHESIS tier — loose-extraction edges the
      // precision graph intentionally drops become standing hypotheses, ready
      // for corroboration-driven promotion.
      this.refreshHypothesisEdges(this.relationsCache);
      this.rebuildRelationalHologram();
      return this.relationsCache;
    }

    /** Typed edges decomposed from the deck definitions (is-a, has-part, ...). */
    relations(): Relation[] {
      if (this.relationsCache === null) {
        const extracted = extractRelations(
          [...this.states.values()].map((s) => ({ word: s.word.word, definition: s.word.definition }))
        );
        return this.buildRelationsCache(extracted, this.authoredRelationPool());
      }
      return this.relationsCache;
    }

    /**
     * P14: the corroboration classes of a derived edge — its origin class,
     * plus the accumulated independent evidence for its key, plus curriculum
     * class credit when a taught EXAMPLE sentence states the same claim (the
     * reviewed deck itself confirming a chaperone-supplied edge).
     */
    protected classesFor(relation: Relation): SourceClass[] {
      const key = edgeKey(relation.subject, relation.predicate, relation.object);
      const classes = [sourceClassForOrigin(relation.origin), ...(this.edgeSources.get(key) ?? [])];
      // Example sentences are curriculum material: an example that STATES the
      // edge ("A bird can fly.") corroborates a chaperone-only edge — the
      // reviewed deck agrees with the LLM.
      if (relation.origin === 'chaperone' && this.exampleCorroborates(relation)) {
        classes.push('curriculum');
      }
      return distinctClasses(classes);
    }

    /** P14: does any taught example sentence corroborate this relation? The
     *  example corpus is token-indexed once per cache build. */
    protected exampleCorroborates(relation: Relation): boolean {
      if (this.exampleIndex === null) {
        const index = new Map<string, string[]>();
        for (const state of this.states.values()) {
          const example = state.word.example.trim().toLowerCase();
          if (example.length === 0) continue;
          const seen = new Set<string>();
          for (const token of tokenizeText(example)) {
            if (seen.has(token)) continue;
            seen.add(token);
            const list = index.get(token) ?? [];
            list.push(example);
            index.set(token, list);
          }
        }
        this.exampleIndex = index;
      }
      const candidates = this.exampleIndex.get(relation.subject) ?? [];
      for (const example of candidates) {
        if (evidenceInText(example, relation.subject, relation.predicate, relation.object)) return true;
      }
      return false;
    }

    /** P14: record an independent corroborating source class for an edge. */
    addEdgeSource(subject: string, predicate: string, object: string, sourceClass: SourceClass): void {
      const key = edgeKey(subject, predicate, object);
      const current = this.edgeSources.get(key) ?? [];
      if (current.includes(sourceClass)) return;
      this.edgeSources.set(key, [...current, sourceClass]);
      // M5 (22.4): corroboration PROMOTES a standing hypothesis — the second
      // independent class is exactly the promotion gate.
      this.promoteHypothesisIfCorroborated(subject, predicate, object);
      this.invalidateRelations();
    }

    /** M5 (22.2): derive the hypothesis tier from the loose extraction —
     *  every loose edge whose key is neither asserted, negated, nor already
     *  hypothesized becomes a standing hypothesis (bounded FIFO). */
    protected refreshHypothesisEdges(asserted: readonly Relation[]): void {
      // MEASURED (Phase 22, full 20k deck): 1083 loose-only edges over 1053
      // subjects — the cap holds them all with headroom while staying bounded.
      const HYPOTHESIS_EDGE_CAP = 2000;
      const assertedKeys = new Set(asserted.map((r) => edgeKey(r.subject, r.predicate, r.object)));
      const known = new Set(this.hypothesisEdges.map((r) => edgeKey(r.subject, r.predicate, r.object)));
      const loose = extractRelations(
        [...this.states.values()].map((s) => ({ word: s.word.word, definition: s.word.definition })),
        { loose: true }
      );
      for (const relation of loose) {
        const key = edgeKey(relation.subject, relation.predicate, relation.object);
        if (assertedKeys.has(key) || known.has(key)) continue;
        if (this.negations.some((n) => n.subject === relation.subject && n.predicate === relation.predicate && n.object === relation.object)) continue;
        known.add(key);
        this.hypothesisEdges.push({ ...relation, tier: 'hypothesis' });
      }
      if (this.hypothesisEdges.length > HYPOTHESIS_EDGE_CAP) {
        this.hypothesisEdges.splice(0, this.hypothesisEdges.length - HYPOTHESIS_EDGE_CAP);
      }
    }

    /** M5 (22.4): promote a hypothesis whose key has earned ≥ 2 independent
     *  source classes (its own origin class + the accumulated evidence) into
     *  the asserted graph (the chaperone store carries adopted edges). */
    protected promoteHypothesisIfCorroborated(subject: string, predicate: string, object: string): void {
      const index = this.hypothesisEdges.findIndex(
        (r) => r.subject === subject && r.predicate === predicate && r.object === object
      );
      if (index === -1) return;
      const hypothesis = this.hypothesisEdges[index];
      const classes = distinctClasses([
        ...(hypothesis.sourceClasses ?? [sourceClassForOrigin(hypothesis.origin)]),
        ...(this.edgeSources.get(edgeKey(subject, predicate, object)) ?? [])
      ]);
      if (classes.length < 2) return;
      this.hypothesisEdges.splice(index, 1);
      const duplicate = this.chaperoneRelations.some(
        (r) => r.subject === subject && r.predicate === predicate && r.object === object
      );
      if (!duplicate) {
        this.chaperoneRelations.push({ ...hypothesis, tier: 'asserted', sourceClasses: classes });
      }
      this.invalidateRelations();
      this.maybePersist();
    }

    /** M5 (22.3): the hypothesis tier's read surface (tests + introspection). */
    hypothesisEdgeList(): readonly Relation[] {
      return this.hypothesisEdges;
    }

    /**
     * M5 (22.3): a HEDGED answer from the hypothesis tier — consulted only
     * after the asserted graph and operators declined. A hypothesis answers
     * single-edge relational questions only (never chained — the one-hop rule
     * is structural: hypotheses never enter walks), always hedged, and is
     * blocked by the confirmed-false store.
     */
    protected hypothesisAnswerFor(utterance: string): { response: string; edge: Relation; operator: OperatorResult } | null {
      const form = questionFormOf(utterance);
      if (form === null || form.object === undefined) return null;
      const predicate = form.kind as RelationPredicate;
      if (!['is-a', 'has-part', 'made-of', 'used-for', 'capable-of', 'opposite-of', 'requires'].includes(predicate)) {
        return null;
      }
      const edge = this.hypothesisEdges.find(
        (r) => r.subject === form.subject && r.predicate === predicate && r.object === form.object
      );
      if (edge === undefined) return null;
      if (this.negations.some((n) => n.subject === edge.subject && n.predicate === edge.predicate && n.object === edge.object)) {
        return null;
      }
      const response = `I think ${edge.subject} ${predicateVerb(edge.predicate, edge.object)} ${edge.object}, but I have only one source for that.`;
      const operator = ((): OperatorResult => {
        switch (edge.predicate) {
          case 'has-part':
            return { kind: 'has-part', subject: edge.subject, part: edge.object, via: null, answer: response, score: 0.5 };
          case 'made-of':
            return { kind: 'made-of', subject: edge.subject, material: edge.object, answer: response, score: 0.5 };
          case 'capable-of':
            return { kind: 'capable-of', subject: edge.subject, action: edge.object, via: null, answer: response, score: 0.5 };
          case 'used-for':
            return { kind: 'used-for', subject: edge.subject, purpose: edge.object, answer: response, score: 0.5 };
          case 'opposite-of':
            return { kind: 'opposite-of', subject: edge.subject, opposite: edge.object, answer: response, score: 0.5 };
          case 'requires':
            return { kind: 'requires', subject: edge.subject, requirement: edge.object, via: null, answer: response, score: 0.5 };
          default:
            return { kind: 'is-a', subject: edge.subject, target: edge.object, answer: response, score: 0.5 };
        }
      })();
      return { response, edge, operator };
    }

    /** P14: drop a corroborating source class (e.g. the world later rejected
     *  the claim it had accepted). */
    removeEdgeSource(subject: string, predicate: string, object: string, sourceClass: SourceClass): void {
      const key = edgeKey(subject, predicate, object);
      const current = this.edgeSources.get(key) ?? [];
      if (!current.includes(sourceClass)) return;
      this.edgeSources.set(key, current.filter((cls) => cls !== sourceClass));
      this.invalidateRelations();
    }

    /** P14: the corroborating source classes of an edge key (read-only). */
    edgeSourcesOf(subject: string, predicate: string, object: string): readonly SourceClass[] {
      const key = edgeKey(subject, predicate, object);
      const found = this.relations().find(
        (r) => r.subject === subject && r.predicate === predicate && r.object === object
      );
      return found !== undefined ? (found.sourceClasses ?? []) : (this.edgeSources.get(key) ?? []);
    }

    /**
     * P14 CONVERSATION-EVIDENCE MINING: a user statement is evidence — "my dog
     * can bark" corroborates dog capable-of bark, "a robin is a bird I saw"
     * corroborates robin is-a bird. Only DECLARATIVE statements with the
     * predicate expressed are mined (questions and negations never are), and
     * only for edges that already exist — an utterance never invents an edge.
     */
    protected noteConversationEvidence(text: string): void {
      if (text.trim().length === 0) return;
      const tokens = new Set(tokenizeText(text).map(singularize));
      if (tokens.size === 0) return;
      // Deck objects are often plural ("wings", "legs") — match the raw form
      // or its singular ("the bird has wings" covers both).
      const mentioned = (word: string): boolean => tokens.has(word) || tokens.has(singularize(word));
      const relations = this.relations();
      let changed = false;
      for (const relation of relations) {
        if (!mentioned(relation.subject) || !mentioned(relation.object)) continue;
        if (!evidenceInText(text, relation.subject, relation.predicate, relation.object)) continue;
        const key = edgeKey(relation.subject, relation.predicate, relation.object);
        const current = this.edgeSources.get(key) ?? [];
        if (current.includes('conversation')) continue;
        this.edgeSources.set(key, [...current, 'conversation']);
        changed = true;
      }
      if (changed) this.invalidateRelations();
    }

    /** Rebuild the distributed-vector view from the current relation graph. */
    protected rebuildRelationalHologram(): void {
      if (this.relationalHologram === null) {
        this.relationalHologram = new RelationalHologram({ slots: 128 });
      } else {
        this.relationalHologram.clear();
      }
      const bySubject = new Map<string, Relation[]>();
      // The curated graph (regex + authored + chaperone)...
      for (const relation of this.relationsCache ?? []) {
        const list = bySubject.get(relation.subject) ?? [];
        list.push(relation);
        bySubject.set(relation.subject, list);
      }
      // ...plus the LOOSE extraction: bind every content-word object the
      // precision-first graph intentionally drops ("a bird is a creature" when
      // creature is not a deck word, "with feathers" when feathers is not).
      // The graded layer answers those with unbind scores, never as edges.
      for (const relation of extractRelations(
        [...this.states.values()].map((s) => ({ word: s.word.word, definition: s.word.definition })),
        { loose: true }
      )) {
        const list = bySubject.get(relation.subject) ?? [];
        list.push(relation);
        bySubject.set(relation.subject, list);
      }
      for (const [subject, edges] of bySubject) {
        this.relationalHologram.setTrace(
          subject,
          edges.map((relation) => ({ predicate: relation.predicate, object: relation.object }))
        );
      }
    }

    /** Edges originating at a word. */
    edgesOf(word: string): Relation[] {
      return this.relations().filter((r) => r.subject === word);
    }

    /** The distributed-vector unbind+cleanup score (P1) — the graded closed-form
     *  signal the operators hedge on. 0 when the subject has no bound trace. */
    relationalScore(subject: string, predicate: string, object: string): number {
      return this.relationalHologram?.scoreOf(subject, predicate, object) ?? 0;
    }

    // ── Edge confidence + confirmed-false store (P8) ─────────────────────────

    /**
     * The confidence weight of a typed edge: 1 per stated source, plus the
     * accumulated agreement/grade delta. 0 when no edge exists. A weakened
     * edge (< 1) answers hedged, never deleted silently.
     */
    edgeStrengthOf(subject: string, predicate: string, object: string): number {
      for (const relation of this.relations()) {
        if (relation.subject === subject && relation.predicate === predicate && relation.object === object) {
          // relations() already carries the effective strength (base + overlay).
          return Math.max(0.1, relation.strength ?? 1);
        }
      }
      return 0;
    }

    /** Adjust the confidence overlay of an edge (P8): agreement +1, wrong
     *  grades −0.2, correct grades +0.2. Floored at 0.1 — a weakened edge
     *  answers hedged, it is never silently deleted. */
    bumpEdge(subject: string, predicate: string, object: string, delta: number): void {
      const key = edgeKey(subject, predicate, object);
      const current = (this.edgeConfidence.get(key) ?? 0) + delta;
      this.edgeConfidence.set(key, Math.max(-0.9, current));
      // The overlay is applied at graph-build time — a bump must force a rebuild.
      this.invalidateRelations();
    }

    /**
     * Record a confirmed-false claim. Deduped by (subject, predicate, object);
     * the evidence string is the taught exchange or graded answer that
     * confirmed it. A negation that CONTRADICTS a stored positive edge becomes
     * a belief to verify too (the P4 machinery) — never a silent override.
     */
    storeNegation(subject: string, predicate: RelationPredicate, object: string, evidence: string, origin: Negation['origin'] = 'taught'): void {
      if (subject === object) return;
      this.negations = this.negations.filter(
        (n) => !(n.subject === subject && n.predicate === predicate && n.object === object)
      );
      this.negations.push({ subject, predicate, object, evidence, origin });
      if (this.edgeStrengthOf(subject, predicate, object) > 0) {
        this.storeBelief(
          subject,
          `I was taught that ${subject} ${predicateVerb(predicate, object)} ${object}, but I was also told it does not — I should check which is true.`,
          'relation-conflict',
          { predicate, object, negation: evidence },
          true
        );
      }
    }

    /** The confirmed-false entry for a claim, or null (the honest absence). */
    negationOf(subject: string, predicate: string, object: string): Negation | null {
      return (
        this.negations.find(
          (n) => n.subject === subject && n.predicate === predicate && n.object === object
        ) ?? null
      );
    }

    /** The confirmed-false store (P8) — the only source of evidence-backed No. */
    negationsList(): readonly Negation[] {
      return this.negations;
    }

    /**
     * Retract a confirmed-false entry — the world confirmed the positive claim
     * (the sweep's positive-wins resolution, or a user correction). Returns
     * true when an entry was actually removed.
     */
    retractNegation(subject: string, predicate: RelationPredicate, object: string): boolean {
      const before = this.negations.length;
      this.negations = this.negations.filter(
        (n) => !(n.subject === subject && n.predicate === predicate && n.object === object)
      );
      const removed = this.negations.length < before;
      if (removed) this.maybePersist();
      return removed;
    }

    /** The sweep resolution ledger (read-only snapshot). */
    sweepResolutionLedger(): ReadonlySet<string> {
      return new Set(this.resolvedSweepConflicts);
    }

    /**
     * Record that the world resolved a sweep conflict. ONE-SHOT: the sweep
     * never re-reports a resolved id — the same evidence pair cannot ping-pong
     * the verification queue. Bounded like the grade ledger.
     */
    markSweepConflictResolved(id: string): void {
      if (id.length === 0) return;
      this.resolvedSweepConflicts.add(id);
      if (this.resolvedSweepConflicts.size > SWEEP_RESOLVED_CAP) {
        const overflow = [...this.resolvedSweepConflicts].slice(0, this.resolvedSweepConflicts.size - SWEEP_RESOLVED_CAP);
        for (const stale of overflow) this.resolvedSweepConflicts.delete(stale);
      }
      this.maybePersist();
    }

    /**
     * Record a contradiction belief from the sweep — the P4 relation-conflict
     * belief the verify-belief goal machinery (plan.ts) and the verify drive
     * (beliefContradictions) read. The sweep's items become beliefs, exactly
     * like the applyRelations and storeNegation conflict paths.
     */
    noteConflictBelief(subject: string, content: string, basis: Record<string, unknown>): boolean {
      return this.storeBelief(subject, content, 'relation-conflict', basis, true);
    }
  };
}
