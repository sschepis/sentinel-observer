#!/usr/bin/env node
/**
 * COUNCIL BENCH — the network-of-observers, measured.
 *
 * Three specialized observers (nature / daily-life / mind), each trained on
 * its domain deck over the SHARED vocabulary (the merge-compatibility
 * invariant), plus the conversation deck so creative mode unlocks. Then the
 * council — each observer answers alone; divergence triggers resonance
 * rounds where the observers observe each other's answers until agreement.
 *
 * Probes: domain-positive definitions (one expert should speak grounded
 * where the others abstain), negative chains, unknown words, and garbage.
 * The black-body claim is measured directly: response entropy across rounds.
 *
 * Usage: npx tsx src/cli/council-bench.ts [--words N]
 */
import { ObserverSession } from '../observer/engine';
import { OBSERVER_OPTIONS } from '../observer/options';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { ALL_CONVERSATION_PAIRS } from '../teacher/conversation';
import { MemoryPersistenceStore } from '../persistence/store';
import { domainDecks, type DomainName } from '../teacher/domains';
import { ObserverNetwork, type CouncilResult } from '../teacher/network';
import { ShardTrainer } from '../teacher/shardTrainer';
import type { DeckWord } from '../teacher/deck';

const WORDS = Number(process.argv[process.argv.indexOf('--words') + 1] ?? 1200);

async function buildMember(name: DomainName, deck: readonly DeckWord[], record: unknown): Promise<TeacherAgent> {
  const session = new ObserverSession(OBSERVER_OPTIONS, 100);
  await session.initialize();
  const teacher = new TeacherAgent(session, deck, new MemoryPersistenceStore(), 500);
  // The word traces come from the shard record (imported below); the
  // conversation faculty is taught here so creative mode unlocks.
  teacher.teachConversationDeck(ALL_CONVERSATION_PAIRS);
  for (const pair of ALL_CONVERSATION_PAIRS) teacher.respond(pair.cue);
  teacher.importBootstrap(record as never);
  return teacher;
}

function summarize(result: CouncilResult): string {
  return (
    `[${result.mode}] "${result.answer.slice(0, 70)}" ` +
    `rounds ${result.rounds} · agreement ${result.agreement.toFixed(2)} · ` +
    `entropy ${result.entropy.toFixed(2)} bits (round-0 ${result.entropyRoundZero.toFixed(2)}) · ` +
    `contributors [${result.contributors.join(', ')}]`
  );
}

async function main(): Promise<void> {
  const decks = domainDecks(WORDS);
  for (const domain of Object.keys(decks) as DomainName[]) {
    console.log(`[council] domain "${domain}": ${decks[domain].length} words (${decks[domain][0]?.word} … ${decks[domain][decks[domain].length - 1]?.word})`);
  }

  // Train the three domain experts in parallel shards (the production path).
  const trainer = new ShardTrainer(3);
  const records = await trainer.train([decks.nature, decks.daily, decks.mind]);
  trainer.dispose();
  const names: DomainName[] = ['nature', 'daily', 'mind'];
  const teachers = await Promise.all(names.map((name, i) => buildMember(name, decks[name], records[i])));

  const council = new ObserverNetwork(
    names.map((name, i) => ({ name, teacher: teachers[i] })),
    3,
    0.55
  );
  console.log('[council] three specialized observers + the conversation faculty, over one shared vocabulary');
  console.log('');

  const probes: Array<{ label: string; question: string }> = [
    { label: 'domain-positive (nature expert should speak)', question: 'what is water' },
    { label: 'domain-positive (nature expert should speak)', question: 'what is a bird' },
    { label: 'domain-positive (daily expert should speak)', question: 'what is a house' },
    { label: 'domain-positive (daily expert should speak)', question: 'what is a chair' },
    { label: 'domain-positive (mind expert should speak)', question: 'what is a thought' },
    { label: 'chain (no expert — resonance or ask)', question: 'does golf have rules' },
    { label: 'negative chain', question: 'is water a person' },
    { label: 'unknown word', question: 'what is zzz' },
    { label: 'garbage', question: 'zzz xyz qqq' },
    { label: 'who is the expert on language?', question: 'what is a word' }
  ];

  console.log('══════ COUNCIL PROBES ══════');
  let grounded = 0;
  let asked = 0;
  const domainProbes: Record<DomainName, Array<{ question: string }>> = {
    nature: [
      { question: 'what is water' },
      { question: 'what is a bird' },
      { question: 'what is a tree' },
      { question: 'where does a bird live' }
    ],
    daily: [
      { question: 'what is a house' },
      { question: 'what is a chair' },
      { question: 'what is a table' },
      { question: 'what are clothes' }
    ],
    mind: [
      { question: 'what is a thought' },
      { question: 'what is a word' },
      { question: 'what is a memory' },
      { question: 'what is a question' }
    ]
  };
  const roles: Record<string, Record<DomainName, number>> = {};

  for (const [domain, probes] of Object.entries(domainProbes) as Array<[DomainName, Array<{ question: string }>]>) {
    for (const probe of probes) {
      const result = council.respond(probe.question);
      const answeredBy = result.contributors[0] ?? result.mode;
      if (!(answeredBy in roles)) roles[answeredBy] = { nature: 0, daily: 0, mind: 0 };
      roles[answeredBy][domain] = (roles[answeredBy][domain] ?? 0) + 1;
    }
  }

  // Division of labor: which domain's probes each member actually answers.
  console.log('══════ NICHE FORMATION (division of labor, measured) ══════');
  for (const [member, dist] of Object.entries(roles)) {
    const total = Object.values(dist).reduce((a, b) => a + b, 0);
    const shares = Object.entries(dist).map(([d, n]) => `${d} ${n}/${total}`);
    console.log(`  ${member.padEnd(8)} → ${shares.join(' · ')}`);
  }
  console.log(`  trust: ${JSON.stringify(council.networkTrust())}`);

  for (const probe of probes) {
    const result = council.respond(probe.question);
    if (result.mode === 'grounded') grounded += 1;
    if (result.mode === 'ask') asked += 1;
    console.log(`Q: ${probe.question}  (${probe.label})`);
    console.log(`A: ${summarize(result)}`);
    console.log('');
  }
  console.log(`[council] grounded ${grounded}/${probes.length} · asked ${asked}/${probes.length} · the rest resonated (composed)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});