/**
 * @jest-environment node
 *
 * P14 CORROBORATION BENCHMARK — two measured claims:
 *
 *   1. RECALL ACCURACY IS UNCHANGED — hedging weak single-source claims is a
 *      PRESENTATION change on top of the same relation graph. The word-recall
 *      benchmark (the Phase-2 acceptance metric, docs/SCALING.md) must hold
 *      its ≥ 0.7 floor with corroboration active.
 *   2. ASSERTIVENESS TRACKS CORROBORATION — single-source generated claims
 *      are spoken hedged ("I think"); claims corroborated across >= 2
 *      independent source classes are spoken assertively. The SAME prompt
 *      flips from hedged to assertive the moment agreement arrives, without
 *      changing the composition.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { DECK_100 } from './decks/en-100';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';

const BENCH_WORDS = 30;

describe('P14 corroboration benchmark', () => {
  let session: ObserverSession;
  let teacher: TeacherAgent;

  beforeAll(async () => {
    const deck = DECK_100.slice(0, BENCH_WORDS);
    session = new ObserverSession(
      { primeCount: 64, gridSize: 128, smfWidth: 128, vocabulary: deckVocabulary(deck, PRIME_SPACE) },
      100
    );
    await session.initialize();
    teacher = new TeacherAgent(session, deck);
  });

  afterAll(() => {
    session.dispose();
  });

  it('weak-claim hedging does not reduce recall accuracy (floor ≥ 0.7)', async () => {
    for (const entry of DECK_100.slice(0, BENCH_WORDS)) {
      teacher.teach(entry.word);
    }
    const words = teacher.listWords().filter((w) => w.traceId !== null);
    let correct = 0;
    for (const state of words) {
      const answer = teacher.ask(state.word.word, 'recognition');
      if (answer.recall !== null && answer.recall.trace.id === state.traceId) correct += 1;
    }
    const accuracy = correct / words.length;
    // eslint-disable-next-line no-console
    console.log(`\nBENCH: recognition accuracy WITH corroboration hedging ${(accuracy * 100).toFixed(1)}% (${correct}/${words.length})`);
    expect(accuracy).toBeGreaterThanOrEqual(0.7);
  }, 60000);

  it('single-source claims are spoken hedged; corroborated claims are spoken assertively', async () => {
    const deck = [
      { word: 'bird', definition: 'a creature with wings and feathers that can fly', example: 'A bird can fly.' },
      { word: 'robin', definition: 'a small bird with a red breast', example: 'I saw a robin.' },
      { word: 'wings', definition: 'a part of a bird used for flying', example: 'Wings flap.' },
      { word: 'feathers', definition: 'a soft covering of a bird', example: 'Feathers are soft.' },
      { word: 'fly', definition: 'to move through the air using wings', example: 'Birds fly.' }
    ];
    const benchSession = new ObserverSession({}, 100);
    await benchSession.initialize();
    const benchTeacher = new TeacherAgent(benchSession, deck, null, 1, 4, 42);
    for (const entry of deck) benchTeacher.teach(entry.word);
    for (const cue of ['hello', 'hi', 'how are you', 'what is up', 'good morning']) {
      benchTeacher.teachResponse({ cue, response: `reply to ${cue}` });
      benchTeacher.respond(cue);
    }

    // SINGLE-SOURCE: the same prompt, measured twice (hedged both times).
    let singleSourceAnswers = 0;
    let singleSourceHedged = 0;
    for (let i = 0; i < 3; i += 1) {
      const answer = benchTeacher.chatAnswer('tell me about robin');
      if (answer.mode !== 'creative' || !answer.grounded) continue;
      singleSourceAnswers += 1;
      if (answer.hedged || /I think|Probably/.test(answer.response)) singleSourceHedged += 1;
    }
    const hedgedRate = singleSourceAnswers > 0 ? singleSourceHedged / singleSourceAnswers : 0;

    // CORROBORATED: an independent source class (the LLM chaperone) agrees
    // with EVERY edge in the graph — any composition the observer builds is
    // now corroborated across >= 2 independent classes.
    for (const relation of benchTeacher.relations()) {
      benchTeacher.applyRelations([
        { subject: relation.subject, predicate: relation.predicate, object: relation.object, source: 'llm', origin: 'chaperone' }
      ]);
    }
    let corroboratedAnswers = 0;
    let corroboratedAssertive = 0;
    for (let i = 0; i < 3; i += 1) {
      const answer = benchTeacher.chatAnswer('tell me about robin');
      if (answer.mode !== 'creative' || !answer.grounded) continue;
      corroboratedAnswers += 1;
      if (!answer.hedged && !/I think|Probably/.test(answer.response)) corroboratedAssertive += 1;
    }
    const assertiveRate = corroboratedAnswers > 0 ? corroboratedAssertive / corroboratedAnswers : 0;

    // eslint-disable-next-line no-console
    console.log(`\nBENCH: single-source hedged rate ${(hedgedRate * 100).toFixed(0)}% (${singleSourceHedged}/${singleSourceAnswers}) · corroborated assertive rate ${(assertiveRate * 100).toFixed(0)}% (${corroboratedAssertive}/${corroboratedAnswers})`);

    // Both measured behaviors must hold — hedging is presentation, promotion
    // is confidence.
    expect(hedgedRate).toBe(1);
    expect(assertiveRate).toBe(1);
    benchSession.dispose();
  }, 60000);
});
