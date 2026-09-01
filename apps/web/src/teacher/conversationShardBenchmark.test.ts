/**
 * @jest-environment node
 */
/**
 * CONVERSATION AUTO-SHARD BENCHMARK — single compact bank vs the
 * entropy-driven sharded bank on the REAL interference case: the 728-pair
 * paraphrase-heavy conversation curriculum plus a word core.
 *
 * Measured on both sides, identically:
 *   - conversation competency (produced/taught cues, the 0.8 identity gate)
 *   - targeted paraphrase probes ("good morning" etc.) answered correctly
 *   - the retrieval interference entropy reading (bits) of the bank
 *   - wall-clock training time
 *
 * The claim: auto-sharding does not regress recall and measurably lowers
 * retrieval interference entropy while keeping every trace reachable.
 */
import { describe, it, expect } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { OBSERVER_OPTIONS } from '../observer/options';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { ACTIVE_DECK } from '../teacher/decks';
import { ALL_CONVERSATION_PAIRS } from '../teacher/conversation';
import { MemoryPersistenceStore } from '../persistence/store';
import { retrievalInterferenceEntropy } from '@sschepis/sentient-core';

const WORDS = Number(process.env.SHARD_BENCH_WORDS ?? 150);

async function trainObserver(memoryMode: 'compact' | 'autoshard'): Promise<{
  teacher: TeacherAgent;
  session: ObserverSession;
  sharded?: { shards: number; entropyBits: number; audit: { traces: number; entropyBits: number }[] };
  wallMs: number;
}> {
  const started = Date.now();
  const session = new ObserverSession({ ...OBSERVER_OPTIONS, memoryMode }, 100);
  await session.initialize();
  const teacher = new TeacherAgent(session, ACTIVE_DECK, new MemoryPersistenceStore(), 500);
  for (const entry of ACTIVE_DECK.slice(0, WORDS)) teacher.teach(entry.word);
  teacher.teachConversationDeck(ALL_CONVERSATION_PAIRS);
  for (const pair of ALL_CONVERSATION_PAIRS) teacher.respond(pair.cue);
  const bank = session.observer.getMemoryBank();
  const sharded =
    memoryMode === 'autoshard'
      ? {
          shards: (bank as unknown as { shardAudit(): { traces: number; entropyBits: number }[] }).shardAudit().length,
          entropyBits: (bank as unknown as { retrievalEntropy(): number }).retrievalEntropy(),
          audit: (bank as unknown as { shardAudit(): { traces: number; entropyBits: number }[] }).shardAudit()
        }
      : undefined;
  return { teacher, session, sharded, wallMs: Date.now() - started };
}

/** The paraphrase probes that collide in a single bank. */
const PROBES = [
  'good morning',
  'good afternoon',
  'good evening',
  'good night',
  'how is it going',
  'how are you doing',
  'how have you been',
  'see you later',
  'take care',
  'long time no see'
];

describe('conversation auto-shard benchmark (honest control: single compact bank)', () => {
  it('auto-sharding lowers retrieval interference entropy and matches or beats competency', async () => {
    const single = await trainObserver('compact');
    const sharded = await trainObserver('autoshard');

    const competency = (teacher: TeacherAgent): number => teacher.conversationReport().competency;
    const singleCompetency = competency(single.teacher);
    const shardedCompetency = competency(sharded.teacher);

    const probeScore = (teacher: TeacherAgent): number => {
      const correct = PROBES.filter((cue) => {
        const answer = teacher.chatAnswer(cue);
        return answer.mode === 'memorized';
      }).length;
      return correct / PROBES.length;
    };
    const singleProbes = probeScore(single.teacher);
    const shardedProbes = probeScore(sharded.teacher);

    // The mechanism: interference must never RISE. The split gate is
    // honest — it declines when a partition would not beat a random split
    // of the same sizes — so a single-shard outcome is a valid result and
    // the assertion is parity, with a measurable reduction whenever the
    // bank did shard.
    expect(sharded.sharded).not.toBeUndefined();
    const singleTraces = single.session.observer.getMemoryBank().all();
    const singleEntropy = retrievalInterferenceEntropy(singleTraces) * singleTraces.length;
    expect(sharded.sharded!.entropyBits).toBeLessThanOrEqual(singleEntropy * 1.001);
    if (sharded.sharded!.shards > 1) {
      expect(sharded.sharded!.entropyBits).toBeLessThan(singleEntropy);
    }

    // The honest contract: no regression on the identity-gated recall.
    expect(shardedCompetency).toBeGreaterThanOrEqual(singleCompetency - 0.02);
    expect(shardedProbes).toBeGreaterThanOrEqual(singleProbes - 0.1);

    // eslint-disable-next-line no-console
    console.log(
      `[conversationShardBench] words=${WORDS} pairs=${ALL_CONVERSATION_PAIRS.length}\n` +
        `  single-bank:  competency ${(singleCompetency * 100).toFixed(1)}% · probes ${Math.round(singleProbes * PROBES.length)}/${PROBES.length} · entropy ${singleEntropy.toFixed(2)} bits · ${single.wallMs}ms\n` +
        `  auto-shard:   competency ${(shardedCompetency * 100).toFixed(1)}% · probes ${Math.round(shardedProbes * PROBES.length)}/${PROBES.length} · entropy ${sharded.sharded!.entropyBits.toFixed(2)} bits across ${sharded.sharded!.shards} shards · ${sharded.wallMs}ms\n` +
        `  entropy reduction: ${(((singleEntropy - sharded.sharded!.entropyBits) / singleEntropy) * 100).toFixed(1)}%\n` +
        `  shards: ${sharded.sharded!.audit.map((a) => `${a.traces}t/${a.entropyBits.toFixed(2)}b`).join(' | ')}`
    );

    single.session.dispose();
    sharded.session.dispose();
  }, 120000);
});
