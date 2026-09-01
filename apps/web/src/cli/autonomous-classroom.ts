#!/usr/bin/env node
/**
 * THE SUSTAINED AUTONOMOUS CLASSROOM — long-term learning from the shell.
 *
 * Runs the observer's school continuously: reviews (decaying words), new
 * words, goal-driven plans, conversation practice, and creative exercise,
 * with PERIODIC CHECKPOINTS (full learning record: traces, states,
 * definitions, drive weights, goal history, composition weights, fade λ,
 * exposure) and a LIVE REPORT CARD (recall sample, chains, adversarial,
 * learned patterns, beliefs, goals, handover λ) fed to the log as it goes.
 *
 * At the end (or any checkpoint) the record is written where the web
 * interface loads it — open the app and the trained observer is there for
 * further refinement and chatting.
 *
 * Usage:
 *   npm run classroom -- --words 2000 --minutes 10 [--science]
 *     [--checkpoint-every 120] [--bench-every 180] [--resume latest.json]
 *     [--out apps/web/public/bootstrap.json] [--no-deploy]
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ObserverSession } from '../observer/engine';
import { OBSERVER_OPTIONS } from '../observer/options';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { ACTIVE_DECK } from '../teacher/decks';
import { TECHNICAL_CONCEPTS } from '../teacher/technical';
import { ALL_CONVERSATION_PAIRS } from '../teacher/conversation';
import { MemoryPersistenceStore } from '../persistence/store';
import { inheritanceChains } from '../teacher/relations';
import { claimsRelationalYes, negativeTargetsFor } from '../teacher/adversarial';
import { spearman } from '../teacher/composite';

/** Spearman window for the handover's measured agreement (5b). */
const FADE_AGREEMENT_WINDOW = 12;
import { isContentWord, tokenizeText } from '../teacher/context';
import { learnWordGoal, fillGapGoal, executeGoalStep, chooseGoal, discoverDeficitGoals } from '../teacher/plan';
import type { BootstrapRecord } from '../teacher/bootstrap';
import type { DeckWord } from '../teacher/deck';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}
const WORDS = Number(flag('--words', '2000'));
const MINUTES = Number(flag('--minutes', '5'));
const CHECKPOINT_EVERY = Number(flag('--checkpoint-every', '120'));
const BENCH_EVERY = Number(flag('--bench-every', '180'));
const RESUME = flag('--resume', '');
const OUT = flag('--out', join(ROOT, 'apps', 'web', 'public', 'bootstrap.json'));
const NO_DEPLOY = process.argv.includes('--no-deploy');
const INCLUDE_SCIENCE = process.argv.includes('--science');
const CHECKPOINT_DIR = flag('--checkpoint-dir', join(ROOT, 'apps', 'web', 'node_modules', '.cache', 'sentient', 'classroom'));
const ENDPOINT = process.env.LM_STUDIO_ENDPOINT ?? 'http://localhost:1234/v1';

const PROMPTS = [
  'what do you think about the weather',
  'tell me something about yourself',
  'what do you want to learn next',
  'are you tired of learning',
  'do you enjoy talking with me',
  'what is your favorite word',
  'can you tell me a story',
  'what do you like to do',
  'how do you feel today',
  'what do you think about the words you know'
];

async function quickBenches(teacher: TeacherAgent): Promise<Record<string, string>> {
  const bank = teacher.getMemoryBank();
  const results: Record<string, string> = {};

  // Recall sample: 60 taught words.
  const taught = teacher.listWords().filter((w) => w.traceId !== null).slice(0, 60);
  let correct = 0;
  for (const w of taught) {
    const q = teacher.ask(w.word.word, 'recognition');
    if (teacher.grade(w.word.word, q).verdict === 'correct') correct += 1;
  }
  results.recall = taught.length === 0 ? 'n/a' : `${((correct / taught.length) * 100).toFixed(1)}% (${correct}/${taught.length})`;

  // Chains: inheritance positives.
  const relations = teacher.relations();
  const chains = inheritanceChains(relations).slice(0, 3);
  let chainOk = 0;
  for (const chain of chains) {
    const answer = teacher.chatAnswer(`does ${chain.subject} have ${chain.part}`);
    if (answer.mode === 'operator' && answer.response.toLowerCase().includes('yes')) chainOk += 1;
  }
  results.chains = `${chainOk}/${chains.length}`;

  // Adversarial: negative chaining over safe targets.
  const deckContent = [...new Set(relations.map((r) => r.object))].filter((w) => isContentWord(w));
  let advOk = 0;
  let advN = 0;
  for (const chain of chains.slice(0, 2)) {
    for (const target of negativeTargetsFor(chain.subject, relations, deckContent, 2)) {
      const answer = teacher.chatAnswer(`is ${chain.subject} a ${target}`);
      if (!claimsRelationalYes(answer)) advOk += 1;
      advN += 1;
    }
  }
  results.adversarial = `${advOk}/${advN}`;

  results.patterns = String(teacher.learnedPatternCount());
  results.beliefs = String(bank.all().filter((t) => t.metadata?.kind === 'belief').length);
  results.goals = String(teacher.goalList().filter((g) => g.status === 'active').length);
  const lambdas = teacher.fadeLambdas();
  results.handover = `λ=${lambdas.conversational.toFixed(2)} dep=${teacher.teacherDependenceRate().toFixed(2)}`;
  results.traces = String(bank.all().length);
  results.curiosity = `${teacher.gapList().length} gaps, pressure ${teacher.curiosityPressure().toFixed(1)}`;
  return results;
}

async function writeRecord(teacher: TeacherAgent, path: string, deckName: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const record = teacher.exportBootstrap(deckName);
  writeFileSync(path, JSON.stringify(record), 'utf8');
}

function humans(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

async function main(): Promise<void> {
  const session = new ObserverSession(OBSERVER_OPTIONS, 100);
  await session.initialize();
  const teacher = new TeacherAgent(session, ACTIVE_DECK, new MemoryPersistenceStore(), 1);
  const started = Date.now();
  const deadline = started + MINUTES * 60_000;

  // SIGINT: check in the current learning state and exit cleanly instead of
  // leaving the shell occupied or losing the run.
  let interrupted = false;
  process.once('SIGINT', () => {
    interrupted = true;
    console.log('\n[classroom] interrupted — checkpointing…');
  });

  console.log(`[classroom] sustained autonomous run — ${WORDS} words${INCLUDE_SCIENCE ? ' + complete science curriculum' : ''} · ${MINUTES} minutes · checkpoint ${CHECKPOINT_EVERY}s · benches ${BENCH_EVERY}s`);
  console.log(`[classroom] resume: ${RESUME || 'none (fresh)'} · deploy: ${NO_DEPLOY ? 'off' : OUT}`);
  let firstAction = true;

  // Resume: load a prior checkpoint (the ENTIRE teacher comes back).
  if (RESUME.length > 0) {
    const fs = await import('node:fs');
    const record = JSON.parse(fs.readFileSync(RESUME, 'utf8')) as BootstrapRecord;
    const result = teacher.importBootstrap(record);
    console.log(`[classroom] resumed from ${RESUME}: ${result.restored} traces restored`);
  } else {
    // Science includes its full arithmetic and measurement prerequisite closure.
    const selected = new Set(ACTIVE_DECK.slice(0, WORDS).map((entry) => entry.word));
    if (INCLUDE_SCIENCE) {
      for (const concept of TECHNICAL_CONCEPTS) selected.add(concept.word);
    }
    const slice = ACTIVE_DECK.filter((entry) => selected.has(entry.word));
    const bar = new ProgressBar(slice.length, () => 'priming');
    for (let i = 0; i < slice.length; i += 1) {
      teacher.teach(slice[i].word);
      bar.update(i + 1, `${((Date.now() - started) / 1000).toFixed(0)}s`);
    }
    bar.finish();
    teacher.teachConversationDeck(ALL_CONVERSATION_PAIRS);
    for (const pair of ALL_CONVERSATION_PAIRS) teacher.respond(pair.cue);
    console.log(`[classroom] primed ${slice.length} words + ${ALL_CONVERSATION_PAIRS.length} phrases, creative ${teacher.conversationReport().creativeUnlocked ? 'unlocked' : 'locked'}`);
  }
  firstAction = true;

  let lastCheckpoint = Date.now();
  let lastBenches = Date.now();
  let cycle = 0;
  // The handover's measured-agreement window: (student composite, world
  // outcome) pairs for the conversational class — Spearman over the window
  // is what the fade controller's λ climbs on (5b below).
  const fadePairs: { composite: number; outcome: number }[] = [];
  const bank = session.observer.getMemoryBank();

  while (Date.now() < deadline) {
    if (interrupted) break;
    cycle += 1;
    const t0 = Date.now();

    // 1. REVIEW: decayed words get re-exercised (recall + production).
    for (let i = 0; i < 4; i += 1) {
      const word = teacher.nextReview();
      if (word === null) break;
      const q = teacher.ask(word, 'recognition');
      teacher.grade(word, q);
      if (teacher.tryState(word)?.word.definition.trim().length ?? 0 > 0) {
        const p = teacher.ask(word, 'production');
        teacher.grade(word, p);
      }
      await sleep(15);
    }

    // 2. NEW WORDS: grow the curriculum toward the target.
    if (teacher.listWords().filter((w) => w.traceId !== null).length < WORDS) {
      for (let i = 0; i < 4; i += 1) {
        const word = teacher.nextNewWord();
        if (word === null) break;
        teacher.teach(word);
        await sleep(15);
      }
    }

    // 3. GOALS: adopt deficit goals (capped — the highest-pressure few, so an
    //    avalanche of fail-beliefs does not flood the plan) + run the plan.
    const deficit = discoverDeficitGoals(teacher);
    if (deficit.length > 0) {
      const existing = teacher.goalList().map((g) => g.id);
      const fresh = deficit.filter((g) => !existing.includes(g.id)).slice(0, 3);
      if (fresh.length > 0) teacher.adoptGoals([...teacher.goalList(), ...fresh]);
    }
    const goals = teacher.goalList().filter((g) => g.status === 'active');
    if (goals.length > 0) {
      for (const g of goals) {
        const h = teacher.goalHistorySnapshot()[g.type] ?? { completed: 0, abandoned: 0 };
        g.successRate = h.completed + h.abandoned === 0 ? 0.5 : h.completed / (h.completed + h.abandoned);
      }
      const goal = chooseGoal(goals, teacher);
      if (goal !== null) {
        const result = await executeGoalStep(teacher, goal);
        if (result.outcome === 'complete') teacher.noteGoalSuccess(goal.type);
        if (result.outcome === 'failed' && goal.status === 'stalled') teacher.noteGoalAbandon(goal.type);
      }
      await sleep(15);
    }

    // 4. CONVERSATION practice: re-produce taught phrases (retention).
    for (const pair of ALL_CONVERSATION_PAIRS.slice(0, 6)) teacher.respond(pair.cue);

    // 5. CREATIVE exercise: converse about the world (composition + the
    //    world's re-ask/retention verdicts — no LLM needed).
    const prompt = PROMPTS[cycle % PROMPTS.length];
    const answer = teacher.chatAnswer(prompt);
    if (answer.mode === 'creative' && answer.response.trim().length > 0) {
      teacher.creativeGradeFeedback(answer.seedTraceIds, 0.8, prompt, answer.response);
    }

    // 5b. HANDOVER FEED: every creative exercise is a chance to grow the
    //     fade agreement — the MEASURED Spearman between the student's
    //     composite (judged against the answer's REAL seeds) and the world's
    //     verdicts: an answer that came from a RETAINED creative memory is a
    //     world-confirmed win (1), an answer the observer had to re-compose
    //     from scratch is a loss (0). No variance → Spearman 0 → λ never
    //     climbs: agreement must be EARNED by discriminating verdicts, not
    //     fed as a fluency proxy (the proxy made the classroom's handover
    //     climb without any measured agreement).
    if (answer.mode === 'creative' && answer.response.trim().length > 0) {
      const composite = (await import('../teacher/composite')).compositeScore(
        answer.response,
        prompt,
        teacher.getCompositionWeights(),
        answer.seedTraceIds
          .map((id) => bank.get(id)?.content)
          .filter((content): content is string => typeof content === 'string')
      ).composite;
      const retained = answer.seedTraceIds.some((id) => bank.get(id)?.metadata?.kind === 'creative');
      fadePairs.push({ composite, outcome: retained ? 1 : 0 });
      if (fadePairs.length >= FADE_AGREEMENT_WINDOW && fadePairs.length % FADE_AGREEMENT_WINDOW === 0) {
        const window = fadePairs.slice(-FADE_AGREEMENT_WINDOW);
        const agreement = spearman(
          window.map((p) => p.composite),
          window.map((p) => p.outcome)
        );
        teacher.noteFadeAgreement('conversational', agreement);
      }
    }

    // CHECKPOINT: the entire teacher, to disk.
    if (Date.now() - lastCheckpoint >= CHECKPOINT_EVERY * 1000) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const path = join(CHECKPOINT_DIR, `checkpoint-${stamp}.json`);
      await writeRecord(teacher, path, 'classroom');
      writeFileSync(join(CHECKPOINT_DIR, 'latest.json'), JSON.stringify(teacher.exportBootstrap('classroom')), 'utf8');
      lastCheckpoint = Date.now();
      console.log(`[classroom] checkpoint ${humans(Date.now() - started)} → ${path}`);
    }

    // REPORT CARD: feed the benches as we go.
    if (Date.now() - lastBenches >= BENCH_EVERY * 1000) {
      const benches = await quickBenches(teacher);
      lastBenches = Date.now();
      const line = Object.entries(benches).map(([k, v]) => `${k} ${v}`).join(' · ');
      console.log(`[classroom] cycle ${cycle} · ${humans(Date.now() - started)} · ${line}`);
    }
  }

  // FINAL: deploy the trained observer to the web interface — the record
  // AND a tiny meta file (generatedAt + word count) the web app uses to
  // detect that this deploy is newer than anything it has already imported.
  if (!NO_DEPLOY) {
    const target = OUT;
    if (teacher.listWords().filter((w) => w.traceId !== null).length > 0) {
      // Don't silently clobber an existing trained record — back it up.
      const fs = await import('node:fs');
      if (fs.existsSync(target) && fs.statSync(target).size > 1024) {
        const backup = `${target}.bak-${Date.now()}`;
        renameSync(target, backup);
        console.log(`[classroom] existing ${target} backed up to ${backup}`);
      }
    }
    await writeRecord(teacher, target, 'classroom');
    const record = teacher.exportBootstrap('classroom');
    const metaPath = target.endsWith('.json') ? target.slice(0, -'.json'.length) + '.meta.json' : `${target}.meta.json`;
    writeFileSync(
      metaPath,
      JSON.stringify({ generatedAt: record.generatedAt, words: record.source.words.length }),
      'utf8'
    );
    console.log(`[classroom] deployed trained observer → ${target} (+ ${metaPath})`);
  }

  const benches = await quickBenches(teacher);
  console.log(`[classroom] FINAL after ${humans(Date.now() - started)} · ${Object.entries(benches).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  console.log(`[classroom] open the web app — the trained observer is loaded for refinement and chatting.`);
  session.dispose();
  // Guaranteed clean exit: dispose is best-effort, but a lingering handle
  // (tsx worker, an open stream, a listener) must never keep the shell
  // occupied after training is done. Exit explicitly with success.
  setTimeout(() => process.exit(0), 50);
}

class ProgressBar {
  private width = 0;
  constructor(private readonly total: number, private readonly label: () => string) {}
  update(progress: number, suffix = ''): void {
    const pct = Math.min(100, Math.round((progress / this.total) * 100));
    const bar = '█'.repeat(Math.floor(pct / 2)).padEnd(50, ' ');
    const line = `\r[classroom] ${this.label()} ${bar} ${pct}% ${suffix}`;
    process.stdout.write(line);
    this.width = Math.max(this.width, line.length);
  }
  finish(): void {
    process.stdout.write('\n');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});