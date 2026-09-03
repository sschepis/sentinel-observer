import { isContentWord } from './context';

/**
 * RELATIONAL TRACES — the enabling layer for operator chaining.
 *
 * Definitions are decomposed into typed edges (subject, predicate, object)
 * so the observer can compose two memories to answer questions it was never
 * taught ("does a robin have wings?" via robin is-a bird ∘ bird has-part
 * wings). The extractor is PRECISION-first: only high-confidence patterns
 * produce edges; an unparsed definition is honest, a wrong edge poisons
 * inheritance. Every edge carries its source definition for provenance.
 */

/**
 * The prose-extractable predicates, plus the ones the technical curriculum
 * authors directly (see technical/types.ts) and the ones the Chaperone (LLM)
 * supplies. Extraction only ever produces the first four — a technical or
 * chaperoned edge is stated, never inferred from English prose.
 */
export type RelationPredicate =
  | 'is-a'
  | 'has-part'
  | 'located-in'
  | 'made-of'
  | 'depends-on'
  | 'defined-as'
  | 'measured-in'
  | 'symbol-for'
  | 'special-case-of'
  | 'has-property'
  | 'capable-of'
  | 'used-for'
  | 'causes'
  | 'opposite-of'
  | 'requires';

/** All predicates, in answerable-question order (the operator layer's enum). */
export const RELATION_PREDICATES: readonly RelationPredicate[] = [
  'is-a',
  'has-part',
  'located-in',
  'made-of',
  'depends-on',
  'defined-as',
  'measured-in',
  'symbol-for',
  'special-case-of',
  'has-property',
  'capable-of',
  'used-for',
  'causes',
  'opposite-of',
  'requires'
];

/** Where an edge came from — provenance decides priority on ties. */
export type RelationOrigin = 'regex' | 'authored' | 'chaperone' | 'reading';

/**
 * P14 CORROBORATION SOURCE CLASSES — the INDEPENDENT knowledge channels an
 * edge can be supported by. A relation stated by exactly one class is a
 * WEAK claim: it may still be spoken, but hedged (never fabricated, never
 * deleted — the graph keeps it for the next corroborating source). Two or
 * more independent classes corroborate it: confidence rises and hedging is
 * removed. Classes are deliberately coarse so agreement is real agreement —
 * the technical curriculum and the everyday supplement are both
 * 'curriculum', and agreeing with yourself is not corroboration.
 *
 *   curriculum      — regex-extracted from taught deck definitions, or
 *                     authored in the technical / everyday / grounded-facts
 *                     curriculum decks.
 *   definition      — LLM-chaperoned definitions/edges (origin 'chaperone'):
 *                     a single untrusted source until another class agrees.
 *   conversation    — mined from user statements ("my dog can bark" is
 *                     evidence for dog capable-of bark) and past chat
 *                     transcripts.
 *   world-feedback  — the world accepted a graded answer citing the edge
 *                     (a strong semantic grade confirms the claim).
 */
export type SourceClass = 'curriculum' | 'conversation' | 'world-feedback' | 'definition' | 'reading';

/** Every source class, in policy-order. */
export const SOURCE_CLASSES: readonly SourceClass[] = [
  'curriculum',
  'conversation',
  'world-feedback',
  'definition',
  'reading'
];

/** The source class a provenance origin states by itself. */
export function sourceClassForOrigin(origin: RelationOrigin): SourceClass {
  if (origin === 'chaperone') return 'definition';
  if (origin === 'reading') return 'reading';
  return 'curriculum';
}

/** True when `value` names a real source class (persistence guard). */
export function isSourceClass(value: unknown): value is SourceClass {
  return typeof value === 'string' && (SOURCE_CLASSES as readonly string[]).includes(value);
}

/**
 * The natural English verb a predicate reads as, article included where the
 * verb demands one ("bird is-a animal" -> "is an animal"). Used for belief
 * phrasing and operator answers so edges speak English, not predicate IDs.
 */
export function predicateVerb(predicate: RelationPredicate, object: string): string {
  switch (predicate) {
    case 'is-a':
      return `is ${/^[aeiou]/.test(object) ? 'an' : 'a'}`;
    case 'has-part':
      return 'has';
    case 'located-in':
      return 'is located in';
    case 'made-of':
      return 'is made of';
    case 'has-property':
      return 'is';
    case 'capable-of':
      return 'can';
    case 'used-for':
      return 'is used for';
    case 'causes':
      return 'causes';
    case 'opposite-of':
      return 'is the opposite of';
    case 'requires':
      return 'requires';
    case 'depends-on':
      return 'depends on';
    case 'defined-as':
      return 'is defined as';
    case 'measured-in':
      return 'is measured in';
    case 'symbol-for':
      return 'is the symbol for';
    case 'special-case-of':
      return 'is a special case of';
  }
}

export interface Relation {
  subject: string;
  predicate: RelationPredicate;
  object: string;
  source: string;
  /** Provenance: regex-extracted, authored by the curriculum, or LLM-supplied. */
  origin: RelationOrigin;
  /**
   * P14 corroboration provenance: the INDEPENDENT source classes supporting
   * this edge (always includes the class of `origin`). One class = a weak
   * single-source claim (hedged when spoken); two or more = corroborated.
   * Stamped on the derived graph by the edge store; persisted per-key so a
   * reload keeps the accumulated agreement.
   */
  sourceClasses?: readonly SourceClass[];
  /**
   * Confidence weight (P8/P14): the corroboration base (1 = a single stated
   * curriculum source; 0.6 = a single LLM-chaperoned source; 1.0 / 1.2 / 1.4
   * for 2 / 3 / 4 independent source classes) plus the agreement/grade
   * overlay. Agreement between sources and correct grades of answers citing
   * the edge bump it; wrong grades weaken it. Absent = 1.
   */
  strength?: number;
  /**
   * M5 (Phase 22): the edge's tier. 'asserted' (or absent — every legacy
   * edge) is the precision-first graph: operators answer it, walks chain it.
   * 'hypothesis' is the PROPOSER tier: a loose extraction or unvalidated
   * second-pass edge that may only ever be spoken HEDGED, never chained,
   * and is PROMOTED to asserted purely by corroboration (a second
   * independent source class or a strong world grade citing it). Precision
   * lives in the promotion gate, not in the proposer.
   */
  tier?: 'asserted' | 'hypothesis';
}

/** A confirmed-false claim (P8): "golf is not a bird" — evidence-backed No. */
export interface Negation {
  subject: string;
  predicate: RelationPredicate;
  object: string;
  /** The taught exchange or graded answer that confirmed the falsehood. */
  evidence: string;
  origin: 'taught' | 'graded' | 'reading';
}

/** A same-predicate disagreement between the regex extractor and the LLM. */
export interface RelationConflict {
  subject: string;
  predicate: RelationPredicate;
  regexObject: string;
  llmObject: string;
}

/**
 * Cross-check the precision-first regex edges against the LLM's proposed
 * edges. AGREED edges need no further attention; LLM-ONLY edges are new
 * graph material; a CONFLICT (same subject+predicate, different objects)
 * is a disagreement to VERIFY — never a silent override of the regex edge.
 * Regex-only edges (the extractor caught something the LLM omitted) are
 * neither added nor flagged: extraction is precision-first and already
 * validated, and omission is not contradiction.
 */
export function reconcileRelations(
  regexRels: readonly Relation[],
  llmRels: readonly Relation[]
): { agreed: Relation[]; llmOnly: Relation[]; conflicts: RelationConflict[] } {
  const regexByKey = new Map<string, Relation>();
  for (const relation of regexRels) {
    regexByKey.set(`${relation.subject}\u0000${relation.predicate}\u0000${relation.object}`, relation);
  }
  const seenRegex = new Set(
    regexRels.map((relation) => `${relation.subject}\u0000${relation.predicate}`)
  );

  const agreed: Relation[] = [];
  const llmOnly: Relation[] = [];
  const conflicts: RelationConflict[] = [];

  for (const relation of llmRels) {
    const key = `${relation.subject}\u0000${relation.predicate}\u0000${relation.object}`;
    if (regexByKey.has(key)) {
      agreed.push(relation);
      continue;
    }
    const predicateKey = `${relation.subject}\u0000${relation.predicate}`;
    if (seenRegex.has(predicateKey)) {
      const regexEdge = regexRels.find(
        (r) => r.subject === relation.subject && r.predicate === relation.predicate
      );
      if (regexEdge !== undefined) {
        conflicts.push({
          subject: relation.subject,
          predicate: relation.predicate,
          regexObject: regexEdge.object,
          llmObject: relation.object
        });
        continue;
      }
    }
    llmOnly.push(relation);
  }

  return { agreed, llmOnly, conflicts };
}

/**
 * Merge relation lists with provenance priority: regex > authored > chaperone.
 * A same-key edge is kept once; when a later (lower-priority) source repeats
 * the key, the earlier source wins. This is the tie rule behind "regex and
 * authored edges keep priority in answering". Corroboration is NOT computed
 * here — the edge store re-stamps `sourceClasses` from the per-key evidence
 * store after the merge (merging would confuse "the deck repeats itself"
 * with "an independent source agrees").
 */
export function mergeRelations(...lists: readonly (readonly Relation[])[]): Relation[] {
  const originPriority: Record<RelationOrigin, number> = { regex: 0, authored: 1, chaperone: 2, reading: 3 };
  const seen = new Map<string, Relation>();
  const merged: Relation[] = [];
  for (const list of lists) {
    for (const relation of list) {
      const key = `${relation.subject}\u0000${relation.predicate}\u0000${relation.object}`;
      const existing = seen.get(key);
      if (existing === undefined || originPriority[relation.origin] < originPriority[existing.origin]) {
        seen.set(key, relation);
      }
    }
  }
  for (const relation of seen.values()) merged.push(relation);
  return merged;
}

/** Modifier words that must never be mistaken for the head noun of a
 *  definition ("a small bird" → bird, never small). */
const ADJECTIVE_BLACKLIST = new Set([
  'small', 'big', 'large', 'little', 'tiny', 'huge', 'enormous', 'great',
  'red', 'green', 'blue', 'yellow', 'white', 'black', 'brown', 'gray', 'grey',
  'pink', 'purple', 'orange', 'golden', 'silver', 'round', 'square', 'long',
  'short', 'tall', 'thin', 'thick', 'wide', 'narrow', 'deep', 'shallow',
  'soft', 'hard', 'hot', 'cold', 'warm', 'cool', 'wet', 'dry', 'clean',
  'dirty', 'sweet', 'sour', 'bitter', 'salty', 'young', 'old', 'wild',
  'domestic', 'fresh', 'ripe', 'raw', 'cooked', 'clear', 'smooth', 'rough',
  'heavy', 'light', 'fast', 'slow', 'strong', 'weak', 'rich', 'poor',
  'simple', 'complex', 'common', 'rare', 'real', 'false', 'true', 'full',
  'empty', 'open', 'closed', 'flat', 'sharp', 'dull', 'bright', 'dark',
  // Nationality / regional / proper modifiers that are deck words but must
  // never become hypernyms ("a United States territory" -> territory).
  'united', 'american', 'british', 'french', 'german', 'italian', 'spanish',
  'chinese', 'japanese', 'indian', 'african', 'european', 'asian',
  'australian', 'canadian', 'mexican', 'russian', 'turkish', 'greek',
  'arabic', 'islamic', 'christian', 'jewish', 'buddhist', 'hindu',
  'eastern', 'western', 'northern', 'southern', 'central', 'tropical',
  'polar', 'arctic', 'antarctic', 'coastal', 'inland', 'urban', 'rural',
  'national', 'international', 'local', 'regional', 'global', 'federal',
  'public', 'private', 'general', 'specific', 'particular', 'individual',
  'social', 'cultural', 'political', 'economic', 'industrial', 'agricultural',
  'commercial', 'financial', 'medical', 'scientific', 'technological',
  'digital', 'electronic', 'mechanical', 'electrical', 'chemical', 'physical',
  'mental', 'natural', 'human', 'modern', 'ancient', 'traditional',
  'contemporary', 'official', 'personal', 'professional', 'standard',
  'normal', 'usual', 'typical', 'similar', 'different', 'certain', 'various',
  'liquid', 'solid', 'gaseous', 'female', 'male', 'adult', 'younger', 'elderly',
  'distinctive', 'prominent', 'prominent', 'outstanding', 'remarkable', 'striking',
  'states', 'republic', 'kingdom', 'formal', 'informal', 'verbal', 'visual',
  'material', 'spiritual', 'emotional', 'intellectual', 'musical', 'visual',
  // Pronoun-ish heads that carry no kind information ("someone entrusted
  // to..." must not produce is-a someone).
  'one', 'ones', 'someone', 'somebody', 'something', 'anyone', 'anybody',
  'anything', 'everyone', 'everybody', 'everything', 'other', 'others'
]);

/** Clause markers that end the head noun phrase of a definition. Includes
 *  the common post-modifier participles ("a nucleotide found in...") and
 *  relative/place clauses ("a building where people live" -> building). */
const HEAD_END = /\b(with|having|which|that|who|where|when|used|of|for|in|on|at|from|by|to|containing|made|found|called|named|known|considered|regarded|characterized|consisting|occurring|relating|resembling|derived|based|generated|produced|formed|played)\b/i;

/**
 * The location-clause matcher shared by the relations extractor (located-in
 * edges) and the operator layer ("where is X" answers). Written once so both
 * evolve in lockstep — adding a preposition here updates the graph AND the
 * where-answer.
 */
const LOCATION_PREPOSITIONS = 'in|on|at|near|over|under|above|below|inside|outside|beside|behind|between|around';

export interface LocationClause {
  preposition: string;
  article: string;
  place: string;
}

/** Match "in the sky" / "on a table" style location clauses in a definition. */
export function matchLocationClause(text: string): LocationClause | null {
  const match = text.match(new RegExp(`\\b(${LOCATION_PREPOSITIONS})\\s+(the|a|an|its|their)\\s+([a-z]+)\\b`, 'i'));
  if (match === null) return null;
  return { preposition: match[1], article: match[2], place: match[3] };
}

/**
 * Decompose the deck's definitions into typed edges. `words` is any deck
 * slice (or the full ACTIVE_DECK); subjects are the words themselves,
 * objects must be deck content words — never blacklisted modifiers.
 *
 * `loose` relaxes the object gate: objects need only be content words (not
 * deck words, not blacklisted). The precision-first GRAPH uses the strict
 * mode (a wrong edge poisons inheritance); the distributed-vector layer (P1)
 * binds the loose edges too — "a bird is a creature" or "with feathers"
 * where the object is not a deck word — and grades them by unbind score
 * instead of admitting them as edges.
 */
export function extractRelations(
  words: ReadonlyArray<{ word: string; definition: string }>,
  options: { loose?: boolean } = {}
): Relation[] {
  const loose = options.loose === true;
  const deckSet = new Set(words.map((w) => w.word));
  const candidate = (word: string): boolean =>
    /^[a-z]+$/.test(word) && (loose || deckSet.has(word)) && isContentWord(word) && !ADJECTIVE_BLACKLIST.has(word);
  // Plural heads resolve to their deck singular ("vertebrates" -> vertebrate).
  const resolveNoun = (token: string): string | null => {
    if (candidate(token)) return token;
    if (token.endsWith('ies') && candidate(`${token.slice(0, -3)}y`)) return `${token.slice(0, -3)}y`;
    if (token.endsWith('es') && candidate(token.slice(0, -2))) return token.slice(0, -2);
    if (token.endsWith('s') && candidate(token.slice(0, -1))) return token.slice(0, -1);
    return null;
  };
  // Trailing participles and adverbs are post-modifiers, never the head
  // ("a plane curve generated" -> curve).
  const PARTICIPLE = /^[a-z]{4,}(?:ed|ing)$/;
  const TRAILING_MODIFIER = /^[a-z]{4,}(?:ed|ing)$|^[a-z]{3,}ly$/;
  // A compound noun made of two deck words chains to its head suffix
  // ("songbird" -> bird). Both halves must be substantial deck words and the
  // suffix a plain noun — ("landlocked" -> locked must never produce an edge).
  const compoundHead = (token: string): string | null => {
    for (let i = 4; i <= token.length - 4; i += 1) {
      const prefix = token.slice(0, i);
      const suffix = token.slice(i);
      if (deckSet.has(prefix) && candidate(suffix) && !PARTICIPLE.test(suffix)) return suffix;
    }
    return null;
  };

  const relations: Relation[] = [];
  const seen = new Set<string>();
  const push = (subject: string, predicate: RelationPredicate, object: string, source: string): void => {
    const key = `${subject}\u0000${predicate}\u0000${object}`;
    if (seen.has(key)) return;
    seen.add(key);
    relations.push({ subject, predicate, object, source, origin: 'regex', sourceClasses: ['curriculum'] });
  };

  for (const entry of words) {
    const subject = entry.word;
    const def = entry.definition.trim();
    if (def.length === 0) continue;

    // IS-A: only NOUN-PHRASE definitions produce kind edges. The gate:
    // a leading article ("an abundant ... element"), a leading hyphenated
    // modifier ("warm-blooded ... vertebrates"), or a leading known adjective
    // ("small Old World songbird"). Verb/adverb definitions ("move quickly",
    // "not correct") define actions or qualities, not kinds — skipped.
    // Within the phrase the head noun is the LAST candidate token — English
    // noun phrases are head-final.
    const rawTokens = def.toLowerCase().split(/[^a-z-]+/).filter(Boolean);
    const nounPhrase =
      /^(?:a|an|the)\s+/i.test(def) ||
      (rawTokens.length > 0 && (rawTokens[0].includes('-') || ADJECTIVE_BLACKLIST.has(rawTokens[0])));
    if (nounPhrase) {
      const clauseEnd = def.search(HEAD_END);
      const head = (clauseEnd > 0 ? def.slice(0, clauseEnd) : def).replace(/^(?:a|an|the)\s+/i, '');
      // Hyphenated tokens are compound modifiers ("egg-laying"), never heads.
      const tokens = head.toLowerCase().split(/[^a-z-]+/).filter((t) => t.length > 0 && !t.includes('-'));
      while (tokens.length > 0 && TRAILING_MODIFIER.test(tokens[tokens.length - 1])) tokens.pop();
      let hypernym: string | undefined;
      for (let i = tokens.length - 1; i >= 0; i -= 1) {
        const resolved = resolveNoun(tokens[i]);
        if (resolved !== null) {
          hypernym = resolved;
          break;
        }
        // Compound fallback: "songbird" is the head even when not a deck word.
        const viaCompound = compoundHead(tokens[i]);
        if (viaCompound !== null) {
          hypernym = viaCompound;
          break;
        }
      }
      if (hypernym !== undefined && hypernym !== subject) {
        push(subject, 'is-a', hypernym, def);
        // A compound hypernym also chains upward (songbird is-a bird) so
        // inheritance can walk through it even if its own entry never parses.
        const suffix = compoundHead(hypernym);
        if (suffix !== null && suffix !== hypernym && suffix !== subject) {
          push(hypernym, 'is-a', suffix, def);
        }
      }
    }

    // HAS-PART: "with/having/characterized by a Y" or "... Ys" ("a creature
    // with wings" -> wings). Bare singular nouns after "with" are usually
    // phrases like "with respect to" — excluded for precision.
    const part = def.match(/\b(?:with|having|characterized by)\s+(?:(?:a|an|the)\s+([a-z]+)|([a-z]+s)\b)/i);
    if (part !== null) {
      const object = part[1] ?? part[2];
      if (object !== undefined && candidate(object) && object !== subject) {
        push(subject, 'has-part', object, def);
      }
      // Conjoined second part: "characterized by feathers and forelimbs".
      const rest = def.slice((part.index ?? 0) + part[0].length);
      const conjunct = rest.match(/^\s+and\s+(?:(?:a|an|the)\s+)?([a-z]+)/i);
      if (conjunct !== null && candidate(conjunct[1]) && conjunct[1] !== subject) {
        push(subject, 'has-part', conjunct[1], def);
      }
    }

    // LOCATED-IN: "in/on/at the Y" ("a bird in the sky" -> sky).
    const location = matchLocationClause(def);
    if (location !== null && candidate(location.place) && location.place !== subject) {
      push(subject, 'located-in', location.place, def);
    }

    // MADE-OF: "made of Y" ("a tool made of wood" -> wood).
    const made = def.match(/\bmade (?:up )?of\s+([a-z]+)\b/i);
    if (made !== null && candidate(made[1]) && made[1] !== subject) {
      push(subject, 'made-of', made[1], def);
    }
  }
  return relations;
}

/** Index relations by subject for fast lookups. */
export function indexRelations(relations: readonly Relation[]): Map<string, Relation[]> {
  const index = new Map<string, Relation[]>();
  for (const relation of relations) {
    const list = index.get(relation.subject) ?? [];
    list.push(relation);
    index.set(relation.subject, list);
  }
  return index;
}

/** Find inheritance-ready chains: S is-a Y, and Y has-part Z. */
export function inheritanceChains(relations: readonly Relation[]): Array<{ subject: string; parent: string; part: string }> {
  const index = indexRelations(relations);
  const chains: Array<{ subject: string; parent: string; part: string }> = [];
  for (const relation of relations) {
    if (relation.predicate !== 'is-a') continue;
    const parentEdges = index.get(relation.object) ?? [];
    for (const edge of parentEdges) {
      if (edge.predicate === 'has-part' && edge.object !== relation.subject) {
        chains.push({ subject: relation.subject, parent: relation.object, part: edge.object });
      }
    }
  }
  return chains;
}