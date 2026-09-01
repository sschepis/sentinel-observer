/**
 * LEARNED RELATION-HOLE LANGUAGE TEMPLATES (P5 extension).
 *
 * The fixed frames (groundedFrames) are the SEED set: every content word of
 * a rendered frame comes from a stored typed edge, so the sentence is
 * grounded by construction, and the internal critic re-parses the output
 * back through the claim grammar before anything is spoken. This module
 * learns EXPRESSIVE templates from the same material the fixed frames use —
 * successful compositions the world accepted — while keeping that honesty
 * contract load-bearing:
 *
 *   - a template is a pattern over {subject, predicate, object} holes:
 *     `{s}` (the subject), `{p:is-a}` (the object LIST of a predicate),
 *     `{p:has-part:1}` (the INDEXED object), `{a:p:is-a}` (article + object),
 *     `{n:is-a}` (objects from the confirmed-false store — negations);
 *   - INDUCTION: when a grounded answer is graded strong, its clause
 *     structure is reconstructed as a template — the observed slot order and
 *     connectives become the template, but the CONTENT is still read from
 *     stored edges at generation time;
 *   - ADMISSION: a candidate template is used (and admitted) only if it
 *     survives the internal critic — every sentence it can render over the
 *     graph re-parses into backed claims — AND it needs >= MIN_EVIDENCE
 *     distinct successful uses, AND its measured acceptance matches or beats
 *     the fixed-frame baseline (no overfitting to one-off phrasing). The
 *     admitted set is capped; a template whose renders the critic refuses
 *     live is demoted.
 *
 * The Markov composer remains the LABELED fallback in the caller
 * (creativeReply): learned templates never widen the grammar, only the
 * structure drawn from it.
 */

import { isContentWord } from './context';
import { edgeObjects, deniedFromNegations, type DeniedClaim } from './chain';
import { RELATION_PREDICATES, type Negation, type Relation, type RelationPredicate } from './relations';
import { criticize, parseClaims, extractSubject } from './groundedFrames';

/** A rendered frame: the id of the template that produced it. */
export interface FrameRef {
  id: string;
  text: string;
  /** True when the frame names the subject (may open a composition). */
  namesSubject: boolean;
}

/** Per-template outcome tracking (the world-feedback ledger). */
export interface FrameTemplateStats {
  /** Times the template was part of a composed, world-graded answer. */
  uses: number;
  /** Subset of uses graded strong (>= the creative reinforce threshold). */
  accepted: number;
  /** Times a composition using the template was refused by the critic. */
  rejected: number;
  /** Distinct successful uses (induction confirmations) — the admission
   *  evidence, replay-guarded per template. */
  evidence: number;
}

/** One hole-template: seed (fixed) or learned. */
export interface HoleTemplate {
  id: string;
  /** The frame surface with holes: "A {s} is {a:p:is-a}." */
  text: string;
  namesSubject: boolean;
  /** Fixed seed templates keep the original first-frame priority rules. */
  requiresParent: boolean;
  learned: boolean;
  /** May appear in compositions (fixed seeds always; learned after gates). */
  admitted: boolean;
  stats: FrameTemplateStats;
}

/** The admission gate verdict for a candidate template. */
export interface AdmissionVerdict {
  probePassed: boolean;
  enoughEvidence: boolean;
  meetsBaseline: boolean;
  admitted: boolean;
}

/** Audit view (bench + tests + introspection). */
export interface TemplateAudit {
  id: string;
  text: string;
  learned: boolean;
  admitted: boolean;
  /** fixed seed / admitted / candidate (exploring) / dropped. */
  status: 'fixed' | 'admitted' | 'candidate' | 'dropped';
  evidence: number;
  uses: number;
  accepted: number;
  rejected: number;
  /** accepted / uses over graded uses (1 when unmeasured). */
  acceptance: number;
}

export interface LearnedFrameOptions {
  /** Distinct successful uses required before admission. */
  minEvidence?: number;
  /** Cap on admitted learned templates. */
  maxLearned?: number;
  /** Live rejections (rejected > accepted) that demote an admitted template. */
  rejectDemote?: number;
  /** Probability a not-yet-admitted candidate joins a composition pool. */
  exploreProbability?: number;
  /** Probe subjects consulted by the admission critic gate. */
  probeCap?: number;
}

// ── Constants ───────────────────────────────────────────────────────────────

export const MIN_EVIDENCE = 3;
export const MAX_LEARNED_TEMPLATES = 12;
export const REJECT_DEMOTE_THRESHOLD = 3;
export const EXPLORE_PROBABILITY = 0.25;
export const PROBE_SUBJECT_CAP = 12;
/** First-frame pick: prefer the top-priority fixed frame, explore learned
 *  openings with the remainder. */
export const FIRST_FRAME_PREFERENCE = 0.75;

// ── Marker language ─────────────────────────────────────────────────────────
// {s}            the subject (rendered as the subject word)
// {p:pred}       the object LIST of `pred` ("wings and feathers")
// {p:pred:N}     the Nth object of `pred` (single)
// {a:p:pred}     article + first object of `pred` ("a bird", "an animal")
// {a:p:pred:N}   article + Nth object
// {n:pred}       object list from the confirmed-false store (negations)
// {a:n:pred}     article + first negated object ("not a bird")

const SUBJECT_MARKER = '{s}';
/** {p:is-a} / {p:has-part:1} / {a:p:is-a} / {a:n:is-a:0} — the hole markers:
 *  kind p = positive object list, n = confirmed-false objects, a = article
 *  form (needs the subkind: {a:p:...} positive, {a:n:...} negated). */
const HOLE_RE = /\{([apn])(?::([pn]))?:([a-z-]+)(?::(\d+))?\}/g;

const article = (word: string): string => (/^[aeiou]/.test(word) ? 'an' : 'a');

/** "a" / "a and b" / "a, b and c" — the frame object list. */
export function listPhrase(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(', ')}, and ${words[words.length - 1]}`;
}

function escapeRegex(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Rendering ───────────────────────────────────────────────────────────────

/** The objects a hole resolves through: stored edges (positive) or the
 *  confirmed-false store (`{n:...}` markers). Direct + inherited for
 *  positive edges, subject-exact for negations. A subject-level exception
 *  vetoes the object. */
function objectsOf(
  subject: string,
  predicate: RelationPredicate,
  fromNegations: boolean,
  relations: readonly Relation[],
  denied: DeniedClaim,
  negations: readonly Negation[]
): string[] {
  if (fromNegations) {
    return [...new Set(negations.filter((n) => n.subject === subject && n.predicate === predicate).map((n) => n.object))];
  }
  return edgeObjects(relations, subject, predicate)
    .filter((object) => !denied(subject, predicate, object))
    .slice(0, 3);
}

/**
 * Render a template against the graph. Null when any hole is unfillable
 * (the edge vanished, an index ran past the object list, an unknown
 * predicate) — the template declines rather than echo stale content.
 */
export function renderTemplate(
  template: { text: string },
  subject: string,
  relations: readonly Relation[],
  denied: DeniedClaim,
  negations: readonly Negation[]
): string | null {
  let out = template.text.replace(/\{s\}/g, subject);
  out = out.replace(HOLE_RE, (whole, kind: string, subkind: string | undefined, predicateRaw: string, indexRaw?: string) => {
    const predicate = predicateRaw as RelationPredicate;
    if (!RELATION_PREDICATES.includes(predicate)) return whole;
    const fromNegations = kind === 'n' || subkind === 'n';
    const objects = objectsOf(subject, predicate, fromNegations, relations, denied, negations);
    if (objects.length === 0) return whole;
    if (kind === 'p' && indexRaw === undefined) return listPhrase(objects);
    const object = objects[indexRaw === undefined ? 0 : Number(indexRaw)];
    if (object === undefined) return whole;
    return kind === 'a' ? `${article(object)} ${object}` : object;
  });
  // An unresolved hole marker or an empty subject means the template cannot
  // fill — render fails as a whole.
  if (HOLE_RE.test(out) || out.includes('{s}')) return null;
  return out;
}

// ── The fixed seed templates ────────────────────────────────────────────────

interface FixedSeedDef {
  id: string;
  text: string;
  /** False for "It ..." continuation frames. */
  namesSubject: boolean;
  /** The old framesFor quirk: "It has ..." only when the subject also has
   *  an is-a parent. */
  requiresParent?: boolean;
}

/** The seeded fixed frames, in EXACTLY the framesFor priority order: the
 *  first named frame that fills opens the composition; every anaphoric
 *  frame that fills follows. */
const FIXED_SEEDS: readonly FixedSeedDef[] = [
  { id: 'fixed:is-a', text: 'A {s} is {a:p:is-a}.', namesSubject: true },
  { id: 'fixed:has-part', text: 'A {s} has {p:has-part}.', namesSubject: true },
  { id: 'fixed:property', text: 'A {s} is {p:has-property}.', namesSubject: true },
  { id: 'fixed:capable-of', text: 'A {s} can {p:capable-of}.', namesSubject: true },
  { id: 'fixed:used-for', text: 'A {s} is used for {p:used-for}.', namesSubject: true },
  { id: 'fixed:made-of', text: 'A {s} is made of {p:made-of}.', namesSubject: true },
  { id: 'fixed:it-has-part', text: 'It has {p:has-part}.', namesSubject: false, requiresParent: true },
  { id: 'fixed:it-property', text: 'It is {p:has-property}.', namesSubject: false },
  { id: 'fixed:it-capable-of', text: 'It can {p:capable-of}.', namesSubject: false },
  { id: 'fixed:it-used-for', text: 'It is used for {p:used-for}.', namesSubject: false },
  { id: 'fixed:it-made-of', text: 'It is made of {p:made-of}.', namesSubject: false }
];

/** Fresh fixed-template instances (per-store stats). */
function fixedTemplateInstances(): HoleTemplate[] {
  return FIXED_SEEDS.map((seed) => ({
    id: seed.id,
    text: seed.text,
    namesSubject: seed.namesSubject,
    requiresParent: seed.requiresParent === true,
    learned: false,
    admitted: true,
    stats: { uses: 0, accepted: 0, rejected: 0, evidence: 0 }
  }));
}

/**
 * The fixed frames a subject can fill, built ONLY from stored edges (direct
 * or inherited) — byte-for-byte the behavior of the original framesFor. The
 * FIRST frame always names the subject (the critic's resolution anchor);
 * later frames use "It".
 */
export function fixedFrames(
  subject: string,
  relations: readonly Relation[],
  denied: DeniedClaim = () => false
): FrameRef[] {
  const out: FrameRef[] = [];
  const instances = fixedTemplateInstances();
  for (const template of instances) {
    if (!template.namesSubject) continue;
    const rendered = renderTemplate(template, subject, relations, denied, []);
    if (rendered !== null) {
      out.push({ id: template.id, text: rendered, namesSubject: true });
      break; // the first fillable named frame opens — the else-if chain
    }
  }
  const parents = edgeObjects(relations, subject, 'is-a').filter((parent) => !denied(subject, 'is-a', parent)).length > 0;
  for (const template of instances) {
    if (template.namesSubject) continue;
    if (template.requiresParent && !parents) continue;
    const rendered = renderTemplate(template, subject, relations, denied, []);
    if (rendered !== null) out.push({ id: template.id, text: rendered, namesSubject: false });
  }
  return out;
}

/** The fixed frames as plain sentences (the framesFor public API). */
export function framesFor(
  subject: string,
  relations: readonly Relation[],
  denied: DeniedClaim = () => false
): string[] {
  return fixedFrames(subject, relations, denied).map((frame) => frame.text);
}

// ── Induction (structure from accepted answers) ─────────────────────────────

/** Replace the first occurrence of `word` that is not already inside a hole
 *  marker. Returns null when the word cannot be located (the claim's object
 *  is not in the clause text — impossible for critic-backed claims, but the
 *  induction declines rather than guess). */
function replaceFirstOutsideMarkers(text: string, word: string, marker: string): string | null {
  const re = new RegExp(`\\b${escapeRegex(word)}\\b`, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const before = text.slice(0, match.index);
    if (before.lastIndexOf('{') <= before.lastIndexOf('}')) {
      return text.slice(0, match.index) + marker + text.slice(match.index + match[0].length);
    }
  }
  return null;
}

/** Collapse runs of same-(kind, predicate) holes joined by list connectives:
 *  "{p:has-part} and {p:has-part:1}" -> "{p:has-part}" (the renderer re-adds
 *  the connectives from the object list). */
function collapseListRuns(text: string): string {
  const tokens: Array<{ kind: string; pred: string; index: number | null; raw: string; start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  const re = /\{([apn])(?::([pn]))?:([a-z-]+)(?::(\d+))?\}/g;
  while ((match = re.exec(text)) !== null) {
    tokens.push({
      kind: match[1],
      pred: match[3],
      index: match[4] !== undefined ? Number(match[4]) : null,
      raw: match[0],
      start: match.index,
      end: match.index + match[0].length
    });
  }
  const connective = /^\s*(?:,?\s+and\s+|\s*,\s*)\s*$/;
  const runs: Array<{ first: number; last: number }> = [];
  for (let i = 0; i < tokens.length - 1; ) {
    const same = tokens[i].kind === tokens[i + 1].kind && tokens[i].pred === tokens[i + 1].pred;
    if (same && connective.test(text.slice(tokens[i].end, tokens[i + 1].start))) {
      let j = i + 1;
      while (
        j + 1 < tokens.length &&
        tokens[j].kind === tokens[j + 1].kind &&
        tokens[j].pred === tokens[j + 1].pred &&
        connective.test(text.slice(tokens[j].end, tokens[j + 1].start))
      ) {
        j += 1;
      }
      runs.push({ first: i, last: j });
      i = j + 1;
    } else {
      i += 1;
    }
  }
  let out = text;
  for (const run of runs.reverse()) {
    const firstToken = tokens[run.first];
    out = out.slice(0, firstToken.start) + firstToken.raw + out.slice(tokens[run.last].end);
  }
  return out;
}

/**
 * Reconstruct one clause of an accepted answer as a marker string: the
 * subject becomes {s}, each claim object becomes a predicate hole (with the
 * article absorbed for article-bearing forms: "a bird" -> {a:p:is-a}), and
 * list connectives collapse into a single list hole. Null when the clause
 * cannot be generalized (multi-word objects, unparseable clauses).
 */
function clauseTemplate(clauseText: string, subject: string, claims: ReturnType<typeof parseClaims>): string | null {
  if (claims.length === 0) return null;
  let out = clauseText.toLowerCase();
  out = out.replace(new RegExp(`\\b${escapeRegex(subject)}\\b`, 'g'), SUBJECT_MARKER);
  const kindCounts = new Map<string, number>();
  for (const claim of claims) {
    const object = claim.object;
    if (object.length === 0 || object.includes(' ') || !isContentWord(object)) return null;
    const predicate = claim.predicate;
    if (!RELATION_PREDICATES.includes(predicate)) return null;
    const key = `${claim.negated ? 'n' : 'p'}:${predicate}`;
    const count = kindCounts.get(key) ?? 0;
    kindCounts.set(key, count + 1);
    const marker = count === 0 ? `{${claim.negated ? 'n' : 'p'}:${predicate}}` : `{${claim.negated ? 'n' : 'p'}:${predicate}:${count}}`;
    const replaced = replaceFirstOutsideMarkers(out, object, marker);
    if (replaced === null) return null;
    out = replaced;
  }
  // Absorb the article into article-bearing holes: "is a {p:is-a}" ->
  // "is {a:p:is-a}" (an "a bird" object must render with the article the
  // grammar requires, chosen by the object's first letter).
  out = out.replace(/\b(?:a|an)\s+(\{[pn]:[a-z-]+(?::\d+)?\})/g, (whole, marker: string) =>
    marker.replace(/\{([pn]):/, '{a:$1:')
  );
  return collapseListRuns(out);
}

// ── The store ───────────────────────────────────────────────────────────────

export class LearnedFrameStore {
  private readonly options: Required<LearnedFrameOptions>;
  /** Every template: fixed seeds + learned (admitted, candidate, dropped). */
  private readonly templates = new Map<string, HoleTemplate>();
  private readonly candidates = new Map<string, HoleTemplate>();
  private readonly admittedLearned = new Map<string, HoleTemplate>();
  private readonly dropped = new Map<string, HoleTemplate>();
  /** Replay guards: distinct (template, sentence) successful-use keys. */
  private readonly seenSentences = new Map<string, Set<string>>();
  /** The graph the last induction ran against — used to re-evaluate a
   *  candidate's admission when new world feedback arrives. */
  private lastGraph: { relations: readonly Relation[]; negations: readonly Negation[] } | null = null;

  constructor(options: LearnedFrameOptions = {}) {
    this.options = {
      minEvidence: options.minEvidence ?? MIN_EVIDENCE,
      maxLearned: options.maxLearned ?? MAX_LEARNED_TEMPLATES,
      rejectDemote: options.rejectDemote ?? REJECT_DEMOTE_THRESHOLD,
      exploreProbability: options.exploreProbability ?? EXPLORE_PROBABILITY,
      probeCap: options.probeCap ?? PROBE_SUBJECT_CAP
    };
    for (const template of fixedTemplateInstances()) this.templates.set(template.id, template);
  }

  /** The fixed seed templates (per-store instances with live stats). */
  fixedTemplateList(): HoleTemplate[] {
    return FIXED_SEEDS.map((seed) => this.templates.get(seed.id) as HoleTemplate);
  }

  /** The admitted learned templates (audit/introspection). */
  learnedTemplates(): HoleTemplate[] {
    return [...this.admittedLearned.values()];
  }

  /** Not-yet-admitted candidates (audit/introspection). */
  candidateTemplates(): HoleTemplate[] {
    return [...this.candidates.values()];
  }

  /** Dropped templates (audit/introspection). */
  droppedTemplates(): HoleTemplate[] {
    return [...this.dropped.values()];
  }

  /** The fixed frames' acceptance over graded uses — the baseline a learned
   *  template must match or beat. 0 when nothing has been graded. */
  baselineAcceptance(): number {
    let uses = 0;
    let accepted = 0;
    for (const template of this.fixedTemplateList()) {
      uses += template.stats.uses;
      accepted += template.stats.accepted;
    }
    return uses === 0 ? 0 : accepted / uses;
  }

  /**
   * Record the world's verdict on a composed answer: every template the
   * composition used gets one graded use (accepted when the grade cleared
   * the reinforce threshold). The evidence that drives admission comes from
   * induce() — this only measures acceptance.
   */
  observeUse(templateIds: readonly string[], accepted: boolean): void {
    for (const id of templateIds) {
      const template = this.templates.get(id);
      if (template === undefined) continue;
      template.stats.uses += 1;
      if (accepted) template.stats.accepted += 1;
      // New feedback can move a candidate across the acceptance gate — the
      // admission verdict is re-evaluated against the graph it was induced
      // from (a candidate whose acceptance collapses below the baseline
      // never gets admitted).
      if (template.learned && !template.admitted && !this.dropped.has(id) && this.lastGraph !== null) {
        this.maybeAdmit(template, this.lastGraph.relations, this.lastGraph.negations);
      }
    }
  }

  /**
   * Record a critic refusal of a composed answer. An admitted template that
   * accumulates more live rejections than acceptances is demoted (it renders
   * content the grammar no longer backs); a candidate with the same pattern
   * is dropped before it is ever admitted.
   */
  observeRejection(templateIds: readonly string[]): void {
    for (const id of templateIds) {
      const template = this.templates.get(id);
      if (template === undefined) continue;
      template.stats.rejected += 1;
      const { rejectDemote } = this.options;
      if (template.learned && template.stats.rejected >= rejectDemote && template.stats.rejected > template.stats.accepted) {
        this.demote(template);
      }
    }
  }

  private demote(template: HoleTemplate): void {
    if (!template.learned) return;
    this.admittedLearned.delete(template.id);
    this.candidates.delete(template.id);
    template.admitted = false;
    this.dropped.set(template.id, template);
  }

  /**
   * INDUCE — reconstruct the template an accepted, critic-backed answer
   * demonstrates: the observed clause order and connectives become a
   * candidate template whose content is still read from stored edges at
   * generation time. Returns the template when a new one was created or an
   * existing one was confirmed; null when the sentence generalizes to
   * nothing new (unparseable, already fixed, or one-clause — which always
   * duplicates a fixed frame).
   */
  induce(sentence: string, relations: readonly Relation[], negations: readonly Negation[]): HoleTemplate | null {
    this.lastGraph = { relations, negations };
    const verdict = criticize(sentence, relations, negations);
    if (!verdict.grounded) return null;
    const subject = extractSubject(sentence);
    if (subject === null) return null;
    const clauses = sentence
      .split(/[.!?]+\s*/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (clauses.length < 2) return null;

    const clauseTemplates: string[] = [];
    for (const clause of clauses) {
      const claims = parseClaims(clause, subject);
      const marker = clauseTemplate(clause, subject, claims);
      if (marker === null) return null;
      clauseTemplates.push(marker);
    }
    // The composition's anchor: the FIRST clause must name the subject, or
    // the critic cannot resolve the composition (and the template could not
    // open one).
    if (!clauseTemplates[0].includes(SUBJECT_MARKER)) return null;
    const text =
      clauseTemplates.map((clause) => clause.charAt(0).toUpperCase() + clause.slice(1)).join('. ') + '.';

    const existing = [...this.templates.values()].find((t) => t.text === text);
    if (existing !== undefined) {
      // A fixed seed (or a previously learned template) already covers this
      // structure — confirm it rather than duplicate.
      if (existing.learned) {
        this.confirm(existing, sentence);
        this.maybeAdmit(existing, relations, negations);
      }
      return existing.learned ? existing : null;
    }
    if ([...this.dropped.values()].some((t) => t.text === text)) return null;

    const id = `learned:${fnv1a(text).toString(36)}`;
    const template: HoleTemplate = {
      id,
      text,
      namesSubject: text.includes(SUBJECT_MARKER),
      requiresParent: false,
      learned: true,
      admitted: false,
      stats: { uses: 0, accepted: 0, rejected: 0, evidence: 0 }
    };
    this.candidates.set(id, template);
    this.templates.set(id, template);
    this.confirm(template, sentence);
    this.confirmPrefixes(text, sentence, clauses.length, relations, negations);
    this.maybeAdmit(template, relations, negations);
    return template;
  }

  /** Bump a template's evidence with a distinct successful use (replay
   *  guarded: the same sentence cannot confirm a template twice). */
  private confirm(template: HoleTemplate, sentence: string): void {
    const seen = this.seenSentences.get(template.id) ?? new Set<string>();
    if (seen.has(sentence)) return;
    seen.add(sentence);
    this.seenSentences.set(template.id, seen);
    template.stats.evidence += 1;
  }

  /** A multi-clause accepted answer confirms every CLAUSE PREFIX that an
   *  existing learned template already covers ("A {s} is {a:p:is-a}. It has
   *  {p:has-part}. It can {p:capable-of}." confirms the two-clause template
   *  with the same first two clauses). */
  private confirmPrefixes(
    text: string,
    sentence: string,
    clauseCount: number,
    relations: readonly Relation[],
    negations: readonly Negation[]
  ): void {
    const clauses = text.split('. ');
    for (let count = clauseCount - 1; count >= 2; count -= 1) {
      const prefix = clauses.slice(0, count).join('. ') + '.';
      const match = [...this.templates.values()].find((t) => t.learned && t.text === prefix);
      if (match !== undefined) {
        this.confirm(match, sentence);
        this.maybeAdmit(match, relations, negations);
      }
    }
  }

  /**
   * The admission gate: a candidate is admitted only when it survives the
   * internal critic over the graph (every fillable render re-parses into
   * backed claims), has >= minEvidence distinct successful uses, and its
   * measured acceptance matches or beats the fixed-frame baseline. Returns
   * the verdict; drops the candidate when the probe fails.
   */
  evaluateAdmission(template: HoleTemplate, relations: readonly Relation[], negations: readonly Negation[]): AdmissionVerdict {
    const probePassed = this.probeTemplate(template, relations, negations);
    const enoughEvidence = template.stats.evidence >= this.options.minEvidence;
    const baseline = this.baselineAcceptance();
    const measured = template.stats.uses;
    const meetsBaseline = measured === 0 ? true : template.stats.accepted / measured >= baseline;
    return { probePassed, enoughEvidence, meetsBaseline, admitted: probePassed && enoughEvidence && meetsBaseline };
  }

  /** Probe every fillable render of the template over the graph: the
   *  internal critic must accept ALL of them, and at least one subject must
   *  fill. This is the honesty gate — a template that can render an
   *  unbacked claim is never admitted. */
  private probeTemplate(template: HoleTemplate, relations: readonly Relation[], negations: readonly Negation[]): boolean {
    const denied = deniedFromNegations(negations);
    const subjects = new Set<string>();
    for (const relation of relations) subjects.add(relation.subject);
    for (const negation of negations) subjects.add(negation.subject);
    let fillable = 0;
    let probed = 0;
    for (const subject of subjects) {
      if (probed >= this.options.probeCap) break;
      probed += 1;
      const rendered = renderTemplate(template, subject, relations, denied, negations);
      if (rendered === null) continue;
      fillable += 1;
      if (!criticize(rendered, relations, negations).grounded) return false;
    }
    return fillable > 0;
  }

  /** Admit a candidate when it passes the gate; evict the weakest admitted
   *  learned template when the cap is hit. */
  maybeAdmit(template: HoleTemplate, relations?: readonly Relation[], negations?: readonly Negation[]): boolean {
    if (!template.learned || template.admitted) return template.admitted;
    if (this.dropped.has(template.id)) return false;
    if (relations === undefined || negations === undefined) return false;
    const verdict = this.evaluateAdmission(template, relations, negations);
    if (!verdict.admitted) {
      if (!verdict.probePassed) {
        // The candidate can render an unbacked claim — it is dropped for
        // good (structure is unsafe; re-inducing would re-create it).
        this.candidates.delete(template.id);
        template.admitted = false;
        this.dropped.set(template.id, template);
      }
      return false;
    }
    if (this.admittedLearned.size >= this.options.maxLearned) {
      let weakest: HoleTemplate | null = null;
      for (const other of this.admittedLearned.values()) {
        if (weakest === null || this.acceptanceOf(other) < this.acceptanceOf(weakest)) weakest = other;
      }
      if (weakest !== null && this.acceptanceOf(template) < this.acceptanceOf(weakest)) return false;
      if (weakest !== null) this.demote(weakest);
    }
    this.candidates.delete(template.id);
    this.admittedLearned.set(template.id, template);
    template.admitted = true;
    return true;
  }

  /** accepted / uses over graded uses (1 when unmeasured). */
  acceptanceOf(template: HoleTemplate): number {
    return template.stats.uses === 0 ? 1 : template.stats.accepted / template.stats.uses;
  }

  /**
   * The frames a subject can fill for composition: the fixed seeds first
   * (unchanged order), then admitted learned templates, then — with the
   * exploration probability — not-yet-admitted candidates so evidence can
   * accumulate from the world's verdicts. Renders are deduplicated (a
   * learned template may replicate a fixed surface).
   */
  compositionFrames(
    subject: string,
    relations: readonly Relation[],
    denied: DeniedClaim,
    negations: readonly Negation[],
    rng?: () => number
  ): FrameRef[] {
    const out: FrameRef[] = [];
    const seen = new Set<string>();
    const push = (id: string, text: string, namesSubject: boolean): void => {
      if (seen.has(text)) return;
      seen.add(text);
      out.push({ id, text, namesSubject });
    };
    for (const frame of fixedFrames(subject, relations, denied)) push(frame.id, frame.text, frame.namesSubject);
    for (const template of this.admittedLearned.values()) {
      const rendered = renderTemplate(template, subject, relations, denied, negations);
      if (rendered !== null) push(template.id, rendered, template.namesSubject);
    }
    if (rng !== undefined && this.candidates.size > 0 && rng() < this.options.exploreProbability) {
      for (const template of this.candidates.values()) {
        const rendered = renderTemplate(template, subject, relations, denied, negations);
        if (rendered !== null) push(template.id, rendered, template.namesSubject);
      }
    }
    return out;
  }

  /** Full audit view — the bench/CLI/UI surface. */
  audit(): TemplateAudit[] {
    const audits: TemplateAudit[] = [];
    const push = (template: HoleTemplate, status: TemplateAudit['status']): void => {
      audits.push({
        id: template.id,
        text: template.text,
        learned: template.learned,
        admitted: template.admitted,
        status,
        evidence: template.stats.evidence,
        uses: template.stats.uses,
        accepted: template.stats.accepted,
        rejected: template.stats.rejected,
        acceptance: this.acceptanceOf(template)
      });
    };
    for (const template of this.fixedTemplateList()) push(template, 'fixed');
    for (const template of this.admittedLearned.values()) push(template, 'admitted');
    for (const template of this.candidates.values()) push(template, 'candidate');
    for (const template of this.dropped.values()) push(template, 'dropped');
    return audits;
  }
}

/** FNV-1a — stable template ids for introspection and dedup. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
