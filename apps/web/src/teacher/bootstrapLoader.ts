import type { TeacherAgent } from './TeacherAgent';
import {
  BOOTSTRAP_VERSION,
  BOOTSTRAP_VOCABULARY_SCHEME,
  type BootstrapRecord
} from './bootstrap';

/** A JSON.parse of this size freezes the main thread and can OOM mobile.
 *  Shared by the deployed-record fetch and the Settings file import. */
export const MAX_RECORD_BYTES = 256 * 1024 * 1024;

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
  if (record.version !== BOOTSTRAP_VERSION) {
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

/** Fetch the record deployed alongside the app (written by `npm run train`). */
export async function fetchDeployedBootstrap(): Promise<BootstrapRecord> {
  const response = await fetch('bootstrap.json');
  if (!response.ok) {
    throw new Error(`bootstrap.json not found (HTTP ${response.status}) — run the batch trainer first (npm run train)`);
  }
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > MAX_RECORD_BYTES) {
    throw new Error(
      `bootstrap.json is ${(contentLength / 1024 / 1024).toFixed(0)}MB — too large to import safely; regenerate it with npm run train`
    );
  }
  const record = (await response.json()) as BootstrapRecord;
  assertImportable(record);
  return record;
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

/**
 * Decide whether the deployed record should be imported automatically:
 * nothing has been learned yet, or a newer record has been deployed since
 * the last import.
 */
export async function shouldAutoImportBootstrap(teacher: TeacherAgent): Promise<boolean> {
  const learned = teacher.listWords().some((entry) => entry.traceId !== null);
  try {
    const response = await fetch('bootstrap.meta.json');
    if (!response.ok) return !learned;
    const meta = (await response.json()) as { generatedAt?: string };
    const last = teacher.lastBootstrapImported();
    const newer = meta.generatedAt !== undefined && (last === null || meta.generatedAt > last.generatedAt);
    return !learned || newer;
  } catch {
    return !learned;
  }
}
