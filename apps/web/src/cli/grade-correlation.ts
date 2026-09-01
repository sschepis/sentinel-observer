#!/usr/bin/env node
/**
 * PHASE 7a — THE CORRELATION BENCH.
 *
 * The handover's dataset: during normal scaffolded training, every creative
 * answer is logged with BOTH the teacher's grade (LLM) and the student's
 * composite (its own machine). The verdict per task class is their rank
 * agreement — how well the student's judgment predicts the teacher's. That
 * agreement IS the fading schedule's data (Phase 7c): λ climbs only where
 * the student has proven it can judge like the teacher.
 *
 * Usage: npx tsx src/cli/grade-correlation.ts [--words N] [--answers N]
 */
import { ObserverSession } from '../observer/engine';
import { OBSERVER_OPTIONS } from '../observer/options';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { ACTIVE_DECK } from '../teacher/decks';
import { ALL_CONVERSATION_PAIRS } from '../teacher/conversation';
import { MemoryPersistenceStore } from '../persistence/store';
import { OpenAICompatProvider, semanticGrader } from '../teacher/chaperone';
import { compositeScore, spearman, type CompositeParts } from '../teacher/composite';
import { tokenizeText } from '../teacher/context';
import { semanticAssignment, semanticRelatedness } from '../teacher/semanticSignature';
import { deckVocabulary, PRIME_SPACE } from '../teacher/primeSignature';
import { twistClosure } from '../teacher/twistClosure';

const ENDPOINT = process.env.LM_STUDIO_ENDPOINT ?? 'http://localhost:1234/v1';
const MODEL = process.env.LM_STUDIO_MODEL ?? 'dirty-muse-writer-v01-uncensored-erotica-nsfw-i1';

const WORDS = Number(process.argv[process.argv.indexOf('--words') + 1] ?? 400);
const ANSWERS = Number(process.argv[process.argv.indexOf('--answers') + 1] ?? 30);

interface LoggedAnswer {
  mode: string;
  utterance: string;
  answer: string;
  teacherGrade: number;
  parts: CompositeParts;
  composite: number;
  semanticSimilarity: number;
  hashSimilarity: number;
  semanticTwist: number;
  hashTwist: number;
}

async function main(): Promise<void> {
  const semanticVocabulary = OBSERVER_OPTIONS.vocabulary;
  const hashVocabulary = deckVocabulary(ACTIVE_DECK, PRIME_SPACE);
  const session = new ObserverSession(OBSERVER_OPTIONS, 100);
  await session.initialize();
  const teacher = new TeacherAgent(session, ACTIVE_DECK, new MemoryPersistenceStore(), 500);

  console.log(`[7a] teaching ${WORDS} words + conversation deck…`);
  for (const entry of ACTIVE_DECK.slice(0, WORDS)) teacher.teach(entry.word);
  teacher.teachConversationDeck(ALL_CONVERSATION_PAIRS);
  for (const pair of ALL_CONVERSATION_PAIRS) teacher.respond(pair.cue);

  // The teacher: the semantic grader over the live LM Studio endpoint.
  const provider = new OpenAICompatProvider({ endpoint: ENDPOINT, apiKey: process.env.LM_STUDIO_API_KEY ?? 'lm-studio', model: MODEL });
  const grader = semanticGrader(provider);
  if (grader === null) {
    console.error('[7a] no semantic grader available — is the LLM endpoint up?');
    session.dispose();
    process.exit(1);
  }

  const prompts: Array<{ utterance: string; class: string }> = [
    { utterance: 'What do you think about the weather?', class: 'conversational' },
    { utterance: 'Tell me something about yourself.', class: 'conversational' },
    { utterance: 'Do you enjoy talking with me?', class: 'conversational' },
    { utterance: 'What do you want to learn next?', class: 'conversational' },
    { utterance: 'Are you tired of learning?', class: 'conversational' },
    { utterance: 'What is your favorite word?', class: 'conversational' },
    { utterance: 'Can you say hello?', class: 'operator' },
    { utterance: 'What time is it?', class: 'operator' },
    { utterance: 'How many words do you know?', class: 'operator' },
    { utterance: 'Say water.', class: 'operator' },
    { utterance: 'Do you know water?', class: 'operator' },
    { utterance: 'What is water?', class: 'operator' },
    { utterance: 'Does golf have rules?', class: 'operator' },
    { utterance: 'What is a bird?', class: 'operator' },
    { utterance: 'Is water a person?', class: 'operator' },
    { utterance: 'Where does a bird live?', class: 'operator' },
    { utterance: 'What color is water?', class: 'operator' },
    { utterance: 'Do I know water?', class: 'operator' }
  ];

  console.log(`[7a] grading ${Math.min(ANSWERS, prompts.length)} answers (LLM teacher + student composite)…`);
  const byClass: Record<string, LoggedAnswer[]> = {};
  for (let round = 0; round < ANSWERS; round += 1) {
    const probe = prompts[round % prompts.length];
    const answer = teacher.chatAnswer(probe.utterance);
    // Every probe answer carries a composite — creative compositions AND
    // operator/ask answers. Skipping non-creative modes starved the
    // 'operator' class of samples entirely, so the per-class table always
    // read "too few samples". A declined answer has nothing to grade.
    if (answer.mode === 'decline' || !('response' in answer)) continue;
    const response = answer.response;

    // TEACHER: the LLM semantic grade.
    try {
      const gradeOutcome = await grader.grade(probe.utterance, response);
      if (gradeOutcome === null || gradeOutcome.score === null) continue;
      const teacherGrade = gradeOutcome.score;

      // STUDENT: its own composite, from its own machinery.
      const weights = teacher.getCompositionWeights();
      const seedMemories = teacher.recallSeedContents(response);
      const parts = compositeScore(response, probe.utterance, weights, seedMemories).parts;
      const composite = compositeScore(response, probe.utterance, weights, seedMemories).composite;
      const answerTokens = tokenizeText(response);
      const promptTokens = tokenizeText(probe.utterance);
      const semanticSimilarity = semanticRelatedness(answerTokens, promptTokens, semanticVocabulary);
      const hashSimilarity = semanticRelatedness(answerTokens, promptTokens, hashVocabulary);
      const semanticTwist = twistClosure(answerTokens, semanticVocabulary).score;
      const hashTwist = twistClosure(answerTokens, hashVocabulary).score;

      byClass[probe.class] = byClass[probe.class] ?? [];
      byClass[probe.class].push({
        mode: answer.mode,
        utterance: probe.utterance,
        answer: response,
        teacherGrade,
        parts,
        composite,
        semanticSimilarity,
        hashSimilarity,
        semanticTwist,
        hashTwist
      });
      console.log(`[7a]   [${probe.class}/${answer.mode}] grade ${teacherGrade.toFixed(2)} · composite ${composite.toFixed(2)} · semantic ${semanticSimilarity.toFixed(2)} · "${response.slice(0, 50)}"`);
    } catch (error) {
      console.error(`[7a]   teacher grade failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log('\n[7a] ==== PER-CLASS AGREEMENT (Spearman: student composite vs teacher grade) ====');
  for (const [className, entries] of Object.entries(byClass)) {
    if (entries.length < 4) {
      console.log(`[7a]   ${className.padEnd(16)} (${entries.length} samples — too few for correlation)`);
      continue;
    }
    const teacherGrades = entries.map((e) => e.teacherGrade);
    const composites = entries.map((e) => e.composite);
    const rho = spearman(teacherGrades, composites);
    console.log(`[7a]   ${className.padEnd(16)} n=${entries.length} · Spearman ρ=${rho.toFixed(2)} ${rho >= 0.7 ? '✓ (handover-ready)' : rho >= 0.5 ? '(partial)' : '(student still blind)'}`);
  }

  // Per-parts agreement — which component of the composite predicts best?
  if (Object.values(byClass).some((entries) => entries.length >= 4)) {
    const all = Object.values(byClass).flat();
    const teacherGrades = all.map((e) => e.teacherGrade);
    console.log('\n[7a] ==== PER-PART AGREEMENT (which signal predicts the teacher?) ====');
    for (const part of ['fluency', 'novelty', 'relevance', 'resonance'] as const) {
      const values = all.map((e) => e.parts[part]);
      const rho = spearman(teacherGrades, values);
      console.log(`[7a]   ${part.padEnd(10)} ρ=${rho.toFixed(2)}`);
    }
    const semanticRho = spearman(teacherGrades, all.map((entry) => entry.semanticSimilarity));
    const hashRho = spearman(teacherGrades, all.map((entry) => entry.hashSimilarity));
    const resonanceRho = spearman(teacherGrades, all.map((entry) => entry.parts.resonance));
    console.log('\n[H4] ==== SIGNATURE AGREEMENT (semantic vs controls) ====');
    console.log(`[H4]   semantic  ρ=${semanticRho.toFixed(2)}`);
    console.log(`[H4]   hash      ρ=${hashRho.toFixed(2)}`);
    console.log(`[H4]   resonance ρ=${resonanceRho.toFixed(2)}`);
    console.log(`[H4]   verdict: ${semanticRho > Math.max(hashRho, resonanceRho) ? 'confirmed' : 'not confirmed'} (semantic must beat both controls)`);
    const semanticTwistRho = spearman(teacherGrades, all.map((entry) => entry.semanticTwist));
    const hashTwistRho = spearman(teacherGrades, all.map((entry) => entry.hashTwist));
    console.log('\n[H7] ==== TWIST-CLOSURE AGREEMENT ====');
    console.log(`[H7]   semantic ρ=${semanticTwistRho.toFixed(2)}`);
    console.log(`[H7]   hash     ρ=${hashTwistRho.toFixed(2)}`);
    console.log(`[H7]   verdict: ${semanticTwistRho >= 0.3 && semanticTwistRho > hashTwistRho ? 'supported' : 'not supported'} (requires ρ≥0.3 and beating hash control)`);
  }

  session.dispose();
  console.log('\n[7a] done — this data drives the Phase 7c fading schedule.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});