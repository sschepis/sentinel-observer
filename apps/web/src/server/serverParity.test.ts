/**
 * @jest-environment node
 */
/**
 * SERVER PARITY GATE — the honest control for moving learning server-side.
 *
 * Reloading a browser (or a server) restores the PERSISTED learning record
 * (traces, word states, weights) but not the observer's transient live SMF
 * trajectory — exactly the EMA state §19 measured. So the gate the server
 * must pass is restore fidelity: a fresh in-process reload of the same disk
 * record and a server boot of that record must reproduce the SAME retrieval
 * distribution, row for row, to the last digit. If the server path loses
 * anything the browser reload path keeps, the numbers say so.
 *
 * Also reported honestly: the measured effect of a reload itself (live-SMF
 * loss) on scores — ranking is expected to survive; raw scores shift.
 */
import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObserverSession } from '../observer/engine';
import { OBSERVER_OPTIONS } from '../observer/options';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { ACTIVE_DECK } from '../teacher/decks';
import { ALL_CONVERSATION_PAIRS } from '../teacher/conversation';
import { FilePersistenceStore } from './FilePersistenceStore';
import { ServerSession } from './ServerSession';

const WORDS = 40;
const CUE_COUNT = 50;
const SETTLE_STEPS = 4;
const SETTLE_DT = 0.05;

function sampleCues(count: number): string[] {
  const seen = new Set<string>();
  const cues: string[] = [];
  for (const pair of ALL_CONVERSATION_PAIRS) {
    if (!seen.has(pair.cue)) {
      seen.add(pair.cue);
      cues.push(pair.cue);
    }
  }
  return cues.slice(0, count);
}

/** The teacher's private exciteAndSettle, replicated through the public API
 *  so every arm builds the cue's converged moment identically. */
function exciteAndSettle(session: ObserverSession, cue: string): void {
  session.settleField();
  session.observeText(cue);
  session.observer.tick(0.02);
  for (let step = 0; step < SETTLE_STEPS; step += 1) {
    session.observer.tick(SETTLE_DT);
  }
}

interface MarginRow {
  cue: string;
  trueScore: number | null;
  distractor: number | null;
  margin: number | null;
  top1: boolean;
  top5: boolean;
}

function measureMargins(session: ObserverSession, cues: string[]): MarginRow[] {
  const rows: MarginRow[] = [];
  for (const cue of cues) {
    exciteAndSettle(session, cue);
    const results = session.recall(cue, 5);
    const trueIdx = results.findIndex((r) => r.trace.metadata?.cue === cue);
    let bestOther: number | null = null;
    for (let k = 0; k < results.length; k += 1) {
      if (k === trueIdx) continue;
      if (bestOther === null || results[k].score > bestOther) bestOther = results[k].score;
    }
    rows.push({
      cue,
      trueScore: trueIdx === -1 ? null : results[trueIdx].score,
      distractor: bestOther,
      margin: trueIdx === -1 || bestOther === null ? null : results[trueIdx].score - bestOther,
      top1: trueIdx === 0,
      top5: trueIdx !== -1
    });
  }
  return rows;
}

function summarize(rows: MarginRow[]) {
  const withTrue = rows.filter((r) => r.trueScore !== null);
  return {
    top1: rows.filter((r) => r.top1).length / rows.length,
    meanTrue: withTrue.reduce((sum, r) => sum + (r.trueScore ?? 0), 0) / Math.max(1, withTrue.length),
    meanDistractor:
      rows.filter((r) => r.distractor !== null).reduce((sum, r) => sum + (r.distractor ?? 0), 0) /
      Math.max(1, rows.filter((r) => r.distractor !== null).length),
    meanMargin:
      rows.filter((r) => r.margin !== null).reduce((sum, r) => sum + (r.margin ?? 0), 0) /
      Math.max(1, rows.filter((r) => r.margin !== null).length)
  };
}

describe('observer server parity gate', () => {
  it('server reload reproduces the in-process reload exactly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'observer-server-parity-'));
    try {
      // ── TRAIN: in-process, over the server's disk store ──────────────────
      const storeA = new FilePersistenceStore(dir);
      const sessionA = new ObserverSession(OBSERVER_OPTIONS, 100);
      await sessionA.initialize();
      const teacherA = new TeacherAgent(sessionA, ACTIVE_DECK, storeA, 1);
      for (const entry of ACTIVE_DECK.slice(0, WORDS)) teacherA.teach(entry.word);
      teacherA.teachConversationDeck(ALL_CONVERSATION_PAIRS);
      for (const pair of ALL_CONVERSATION_PAIRS) teacherA.respond(pair.cue);
      await teacherA.flush();
      await storeA.drain();

      const cues = sampleCues(CUE_COUNT);
      const rowsBeforeReload = measureMargins(sessionA, cues);
      // The measurement mutates in-memory access counts; the disk holds the
      // pre-measurement state — deliberately NOT re-flushed, so both reload
      // arms boot from exactly what a crash would leave behind.
      sessionA.dispose();

      // ── ARM A (reference): a fresh IN-PROCESS reload of that disk ────────
      const storeReload = new FilePersistenceStore(dir);
      const sessionReload = new ObserverSession(OBSERVER_OPTIONS, 100);
      await sessionReload.initialize();
      const teacherReload = new TeacherAgent(sessionReload, ACTIVE_DECK, storeReload, 1);
      const restoredA = await teacherReload.restoreFromPersistence();
      const definitions = await storeReload.loadDefinitions();
      if (definitions.length > 0) teacherReload.applyDefinitions(definitions);
      expect(restoredA.restored).toBeGreaterThan(0);
      const rowsReload = measureMargins(sessionReload, cues);
      sessionReload.dispose();

      // ── ARM B: the server path boots the same disk ───────────────────────
      const serverB = new ServerSession({ dataDir: dir, words: 0, autosaveMs: 60000, tickImmediately: false, train: false });
      await serverB.boot();
      try {
        const stateB = serverB.state();
        expect(stateB.restored).toBeGreaterThan(0);
        expect(stateB.learned).toBe(WORDS);
        const sessionB = serverB.session;
        expect(sessionB).not.toBeNull();
        const rowsServer = measureMargins(sessionB!, cues);

        // ── THE GATE: server reload ≡ in-process reload, row for row ───────
        expect(rowsServer.length).toBe(rowsReload.length);
        for (let i = 0; i < rowsReload.length; i += 1) {
          const a = rowsReload[i];
          const b = rowsServer[i];
          expect(b.cue).toBe(a.cue);
          expect(b.top1).toBe(a.top1);
          expect(b.top5).toBe(a.top5);
          expect(b.trueScore).toBe(a.trueScore);
          expect(b.distractor).toBe(a.distractor);
          expect(b.margin).toBe(a.margin);
        }
        expect(summarize(rowsServer)).toEqual(summarize(rowsReload));

        // ── The measured effect of a reload itself, reported honestly ─────
        const before = summarize(rowsBeforeReload);
        const after = summarize(rowsServer);
        // eslint-disable-next-line no-console
        console.log(
          `[serverParity] words=${WORDS} cues=${CUE_COUNT}\n` +
            `  before reload: top-1 ${(before.top1 * 100).toFixed(1)}% · true ${before.meanTrue.toFixed(4)} · distractor ${before.meanDistractor.toFixed(4)} · margin +${before.meanMargin.toFixed(4)}\n` +
            `  after  reload: top-1 ${(after.top1 * 100).toFixed(1)}% · true ${after.meanTrue.toFixed(4)} · distractor ${after.meanDistractor.toFixed(4)} · margin +${after.meanMargin.toFixed(4)}\n` +
            `  (in-process reload and server reload agree bit-for-bit on every row)`
        );
        // Ranking must survive the reload even though scores shift.
        expect(after.top1).toBeGreaterThanOrEqual(before.top1 - 0.02);
      } finally {
        await serverB.shutdown();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300000);
});
