import type { TeacherAgent } from './TeacherAgent';
import {
  BOOTSTRAP_VERSION,
  BOOTSTRAP_MIN_SUPPORTED_VERSION,
  BOOTSTRAP_VOCABULARY_SCHEME,
  computeVocabularyFingerprint,
  type BootstrapRecord
} from './bootstrap';
import { OBSERVER_OPTIONS } from '../observer/options';

/** A JSON.parse of this size freezes the main thread and can OOM mobile.
 *  Shared by the deployed-record fetch and the Settings file import. */
export const MAX_RECORD_BYTES = 256 * 1024 * 1024;

/** The fingerprint of the vocabulary THIS app decodes traces against.
 *  Memoized: the table is ~20k entries and never changes within a session. */
let appFingerprint: string | null = null;
function appVocabularyFingerprint(): string {
  if (appFingerprint === null) {
    appFingerprint = computeVocabularyFingerprint(OBSERVER_OPTIONS.vocabulary);
  }
  return appFingerprint;
}

/**
 * Reject a record trained under a DIFFERENT vocabulary table than the one
 * this app decodes against. Version/scheme/deck checks cannot catch this:
 * under the semantic scheme a deck-content change (an override, a layered
 * sense, an appended word) shifts signatures silently while every coarse
 * marker still matches. Legacy records without a fingerprint are accepted
 * — regenerating with npm run train stamps one.
 */
export function assertVocabularyCompatible(record: BootstrapRecord): void {
  if (record.vocabularyFingerprint === undefined) return;
  if (record.vocabularyFingerprint !== appVocabularyFingerprint()) {
    throw new Error(
      `bootstrap record was trained under vocabulary ${record.vocabularyFingerprint}, but this app's deck builds ${appVocabularyFingerprint()} — the deck content changed since training; regenerate the record with npm run train`
    );
  }
}

export interface BootstrapImportSummary {
  restored: number;
  conversations: number;
  definitions: number;
  /** Word states skipped because the importing deck does not teach the word
   *  (or its trace failed to restore) — reported so the drop is visible. */
  droppedWords: number;
  /** Traces rejected by the pre-encoding-era stale check. */
  stale: number;
}

/** Exported for the round-trip gate: the app's own export must always be
 *  re-importable under the deck it stamps (H5). */
export function assertImportable(record: BootstrapRecord): void {
  if (typeof record.version !== 'number' || record.version < BOOTSTRAP_MIN_SUPPORTED_VERSION || record.version > BOOTSTRAP_VERSION) {
    throw new Error(`unsupported bootstrap record version ${record.version}; regenerate it with npm run train`);
  }
  if (record.vocabularyScheme !== BOOTSTRAP_VOCABULARY_SCHEME) {
    throw new Error(
      `bootstrap vocabulary scheme "${String(record.vocabularyScheme)}" is incompatible with "${BOOTSTRAP_VOCABULARY_SCHEME}"; regenerate it with npm run train`
    );
  }
  // The batch trainer emits 'en-20000' and the autonomous classroom emits
  // 'classroom'; both teach the deck this app teaches. Any other deck would
  // bind traces to words that do not exist here.
  if (record.deck !== 'en-20000' && record.deck !== 'classroom') {
    throw new Error(
      `bootstrap record was trained on deck "${record.deck}", but this app teaches the en-20000 deck — regenerate it with npm run train or npm run classroom`
    );
  }
}

/** Import a record into the live session and persist it before returning. */
export async function importRecord(
  teacher: TeacherAgent,
  record: BootstrapRecord,
  options: { markDeployed?: boolean } = {}
): Promise<BootstrapImportSummary> {
  assertImportable(record);
  const result = teacher.importBootstrap(record);
  if (options.markDeployed === true) {
    // Remembering WHICH deploy was imported keeps a newer headless record
    // from being shadowed by stale browser state on the next load.
    teacher.markBootstrapImported({ generatedAt: record.generatedAt, words: record.source.words.length });
  }
  await teacher.persistAll();
  return result;
}

