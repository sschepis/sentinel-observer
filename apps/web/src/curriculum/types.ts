/**
 * THE CURRICULUM REGISTRY — outside knowledge, in the five shapes the
 * observer can actually ingest.
 *
 * The observer is only as deep as its world, and its world has been a
 * dictionary, a few hundred hand-written exchanges, and whatever a language
 * model volunteered. Real corpora exist for every one of the observer's
 * input channels, and this module is the door they come through:
 *
 *   relations    typed edges (subject, predicate, object) with a source class
 *                → the relation graph (applyRelations, multi-valued)
 *   definitions  word → gloss (+ example)           → the deck (applyDefinitions)
 *   dialogue     cue → response pairs               → the conversation deck (teachResponse)
 *   passages     declarative prose                  → the reader (readFrom)
 *   problems     question + checkable answer        → the drill layer (graded without an LLM)
 *
 * A source that fits none of these is not training material for this
 * system, however large it is. Every source is a local file (fetched by a
 * CLI on the operator's machine — the server never reaches out), carries a
 * license note, and is ingested by the classroom loop under a per-cycle
 * budget with a persisted cursor, so the live observer stays live and
 * nothing arrives in a flood. Each source keeps a held-out slice and earns
 * its budget by a bench (Rule 1: null model first; Rule 3: ground truth from
 * outside the loop).
 */
import type { Relation, RelationPredicate } from '../teacher/relations';

export type CurriculumKind = 'relations' | 'definitions' | 'dialogue' | 'passages' | 'problems';

export interface CurriculumSource {
  /** Stable id — the cursor key in the learning state. */
  id: string;
  kind: CurriculumKind;
  /** Absolute path of the local JSONL file. */
  path: string;
  /** Where it came from and under what terms (printed, never enforced). */
  license: string;
  description: string;
}

/** A confirmed-false claim from a source (ConceptNet's Not* relations). */
export interface SourcedNegation {
  subject: string;
  predicate: RelationPredicate;
  object: string;
  evidence: string;
}

export interface RelationBatch {
  relations: Relation[];
  negations: SourcedNegation[];
  /** Rows the adapter refused (vocabulary, relation, shape). */
  skipped: number;
  /** Rows read from the source (accepted + skipped). */
  read: number;
}

export interface DialogueBatch {
  pairs: Array<{ cue: string; response: string }>;
  skipped: number;
  read: number;
}

export interface PassageBatch {
  passages: Array<{ title: string; text: string }>;
  skipped: number;
  read: number;
}

export interface DefinitionBatch {
  definitions: Array<{ word: string; definition: string; example: string }>;
  skipped: number;
  read: number;
}

/** A word the adapters may use: lowercase letters, an internal hyphen or
 *  apostrophe at most — the deck's own token shape. */
export const WORD_SHAPE = /^[a-z]+(?:[-'][a-z]+)?$/;
