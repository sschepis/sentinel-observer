# TeacherAgent split — execution rails

Goal: split `apps/web/src/teacher/TeacherAgent.ts` (~6,200 lines, one class) into
a categorized set of files with **zero behavior change** and **zero public-API
change**. This document is the complete rails: the invariants, the pattern, the
member→module map, the loop to run per step, and the failure protocol. Follow
it in order. Do not improvise beyond it.

---

## 0. Invariants (never break these)

1. **No logic changes.** Method bodies move verbatim. You may only change:
   `private` → `protected`, `import` lines, and the file a thing lives in.
   If you think a body needs fixing, leave a `// TODO` and keep moving.
2. **No renames.** Every class member keeps its exact name and signature.
3. **The public module surface of `./TeacherAgent` is frozen.** Everything
   currently exported from `TeacherAgent.ts` (types, constants, functions,
   the class) must still be importable from `./TeacherAgent` afterward —
   re-export from the new homes.
4. **Green gates between steps.** After every step run:
   ```bash
   cd apps/web && npx tsc --noEmit && npx jest
   ```
   Both must pass (91+ suites, 1,110+ tests). If red and you cannot see the
   fix within a few minutes, `git checkout -- .` the step and redo it smaller.
5. **Commit after each green step** with message
   `refactor(teacher): <step> — no behavior change (tsc + jest green)`.
   Never batch multiple steps into one commit.

---

## 1. Target architecture

```
apps/web/src/teacher/
  TeacherAgent.ts          ← shrinks to: composition + constructor + chatAnswer
                             + setTuning + re-exports (~700 lines)
  agent/
    support.ts             ← module-scope types/constants/helpers (no class code)
    base.ts                ← TeacherAgentCore: ALL shared state (protected) +
                             CrossFacultyApi interface + tiny core helpers
    wordloop.ts            ← teach/ask/grade/retention/report        (mixin)
    curriculum.ts          ← review queues + curriculum ranking      (mixin)
    relations.ts           ← graph, hypothesis tier, negations, hologram (mixin)
    rules.ts               ← rewrite engine + compiled DSL rules     (mixin)
    operators.ts           ← learned-operator lifecycle              (mixin)
    motivation.ts          ← drives, gaps, curiosity, verify         (mixin)
    conversation.ts        ← exchanges, beliefs, working/episodic    (mixin)
    creative.ts            ← creative reply, grading, world feedback,
                             fade/handover                           (mixin)
    goals.ts               ← goal store + goal loop                  (mixin)
    autoloop.ts            ← the autonomous teach loop               (mixin)
    persistence.ts         ← persist/restore/bootstrap import-export (mixin)
```

State lives centrally in `base.ts` (protected fields). Behavior lives in the
faculty files. This is deliberate: fields are cross-referenced everywhere, so
central state + modular behavior is the safe cut.

### The mixin pattern (copy this shape exactly)

```ts
// agent/autoloop.ts
import { TeacherAgentCore, type Constructor, type CrossFacultyApi } from './base';

export function AutoLoopMixin<TBase extends Constructor<TeacherAgentCore & CrossFacultyApi>>(Base: TBase) {
  return class AutoLoopFaculty extends Base {
    startAutoLoop(options: AutoLoopOptions = {}): AutoLoopHandle {
      /* body moved verbatim from TeacherAgent.ts */
    }
    // ...the rest of this faculty's methods
  };
}
```

```ts
// base.ts (shape)
export type Constructor<T = object> = new (...args: any[]) => T;

export class TeacherAgentCore {
  // Constructor-injected (assigned by TeacherAgent's constructor; `!` because
  // the base has no constructor of its own):
  protected session!: ObserverSession;
  protected persistence: PersistenceStore | null = null;
  protected persistEvery = 1;
  protected settleSteps = RECALL_SETTLE_STEPS;
  protected episodic!: EpisodicMemory;
  protected operatorLearner!: OperatorLearner;
  protected knownWords!: ReadonlySet<string>;
  protected compositionRng!: () => number;
  protected hiddenRelationKeys: ReadonlySet<string> | null = null;
  protected curriculumConfig: CurriculumConfig = {};
  protected rewriteInduction = false;

  // Every other field from the old class, verbatim, with `private` → `protected`.
  protected readonly states = new Map<string, WordState>();
  // ... (see the field table in §3)
}

/**
 * Methods one faculty calls on another. STARTS EMPTY. When tsc says
 * "Property 'x' does not exist on type ...", add x's signature here —
 * nothing else. At the end this interface documents the internal coupling.
 */
export interface CrossFacultyApi {}
```

```ts
// TeacherAgent.ts (final shape)
import { TeacherAgentCore } from './agent/base';
import { WordLoopMixin } from './agent/wordloop';
// ...
const TeacherAgentComposed =
  PersistenceMixin(AutoLoopMixin(GoalsMixin(CreativeMixin(ConversationMixin(
  MotivationMixin(OperatorsMixin(RulesMixin(RelationsMixin(CurriculumMixin(
  WordLoopMixin(TeacherAgentCore)))))))))));

export class TeacherAgent extends TeacherAgentComposed {
  constructor(session, deck, persistence = null, persistEvery = 1, /* … keep the
    exact current parameter list and defaults … */) {
    super();
    this.session = session;
    this.persistence = persistence;
    // …assign the rest exactly as the old constructor body does…
  }

  setTuning(/* unchanged */) { /* unchanged */ }
  chatAnswer(/* unchanged */) { /* unchanged, stays here */ }
}

// Public surface frozen — re-export everything that used to be exported here:
export * from './agent/support';
```

---

## 2. Known pitfalls (read before starting)

- **`plan.ts` is typed against the concrete `TeacherAgent`.** `LearningGoal.describe(teacher: TeacherAgent)` etc. A goals faculty must therefore call `goal.describe(this as unknown as TeacherAgent)` with a TYPE-ONLY import of the composed class (`import type { TeacherAgent } from '../TeacherAgent'`) — never a value import, which would close a runtime cycle. `plan.ts` itself imports the value `REVIEW_STRENGTH_THRESHOLD` from `./TeacherAgent`; to keep the module graph acyclic when goals/rules faculties move out, repoint that one import to `./agent/support` (which re-exports it via TeacherAgent, so external behavior is unchanged) and keep `import type { TeacherAgent }` there.
- **Runtime cycles already exist and are fine.** `TeacherAgent.ts` ↔ `plan.ts` already cycle today. Moving methods into mixins adds `index → mixin → X` edges; keep every faculty's import of the index file type-only and reuse the existing cycle shape rather than creating new value cycles.- **Constructor parameter properties.** The old constructor declares
  `private readonly session` / `private readonly persistence` as parameter
  properties. These become plain parameters; the fields are declared in
  `TeacherAgentCore` and assigned in the constructor body (`this.session =
  session`). Do not leave the parameter-property modifiers in place.
- **`private` → `protected`.** Any member referenced from more than one file
  must be `protected`. The simple rail: make ALL moved fields protected in
  base.ts, and make every moved method `protected` if it was `private`,
  public otherwise. Never leave `private` on something a mixin touches.
- **Import cycles.** Faculties may import from `./base`, `./support`, and any
  non-teacher module. They must NOT import values from `../TeacherAgent` or
  from each other. If a faculty needs another faculty's method, that goes
  through `CrossFacultyApi` (type-level only — zero runtime import).
  Type-only imports (`import type`) between files are always safe.
- **Module-scope helpers.** Lines ~1–620 of the current file are module-scope
  types/constants/functions. They move to `agent/support.ts` FIRST (step 1),
  because every faculty imports them. `TeacherAgent.ts` then does
  `export * from './agent/support'` so external importers see no change.
  Note: some names there are NOT currently exported (e.g. `edgeKey`,
  `matchesCue`, `sleep`, `EMPTY_PROVENANCE`, cap constants). Export them from
  support.ts (they must be importable by faculties) but do NOT add them to the
  `export *` — instead re-export from TeacherAgent.ts only the names that were
  exported before. Practical rail: in TeacherAgent.ts use explicit
  `export { ... } from './agent/support'` listing exactly the previously
  exported names (grep `^export` in the pre-refactor file to build the list).
- **Composed-class type inference.** If tsc struggles to name the composed
  class type in the declaration of `TeacherAgent`, do not fight it — the app
  is `noEmit`, and jest transpiles per-file. If you hit TS4094-style errors
  about private members in exported class expressions, change those members
  to `protected`.
- **Field initialization order.** Field initializers in base.ts and in mixin
  classes run before the `TeacherAgent` constructor body — same as today
  (all initializers ran before the ctor body in the single class). Keep every
  field initializer exactly as it is; move them, don't rewrite them.
- **`jest` needs no config change.** Mixins are plain TS. Do not touch
  jest.config or tsconfig.
- **Do not touch** `teacher/index.ts`, tests, or any consumer file. If a
  consumer breaks, you broke invariant 3 — fix the re-exports instead.

---

## 3. Member → module map

### Fields (all move to `base.ts`, all `protected`)

Every field currently declared in the class body or as a constructor parameter
property. From the current file (names, not line numbers — lines will drift):

`states, autoLoopToken, autoLoopRunning, autoStep, autoListeners,
conversationTraceIds, taughtConversationCues, producedConversationCues,
creativeUtteredKeys, beliefsStored, lastRecallConfidence, behaviorWeights,
behaviorOutcomes, compositionWeights, compositionWeightMeta, behaviorOutcomeAt,
calibration, creativeMemoryIds, gapUtterances, gapTraceIds, gapMissCounts,
encounterCounts, exposureCounts, cueConfidence, curiosityAsked, modeCounts,
groundingTotal, workingMemory, episodic, operatorLearner, knownWords,
relationsCache, chaperoneRelations, edgeConfidence, edgeSources,
hypothesisEdges, exampleIndex, persistedConversationTexts, negations,
resolvedSweepConflicts, relationalHologram, learnedFrames, compiledRules,
ruleStore, compositionRules, ruleResolutions, pendingRuleQuestions,
rewriteInduction, compositionRng, arbitrationRng, compositionCost,
hiddenRelationKeys, answerGrades, reliabilityModel, persistCounter,
persistEvery, settleSteps, persistChain, persistTimer, dirtySince, tuning,
curriculumConfig, drillFailures, curriculumVocabCache, goals, goalLoopToken,
goalLoopRunning, authoredAnswers, fadeAgreementTelemetry, lambdaTraffic,
bootstrapImportedMeta, goalHistory, session, persistence`

### Small core helpers (move to `base.ts` as methods of TeacherAgentCore)

`noteAnswerMode, answerModeCounts, groundingAttribution, noteGrounding,
traceOf, requiredState, tryState, getMemoryBank, observerState`

### `agent/support.ts` (module scope, verbatim)

Everything above `export class TeacherAgent` in the current file:
`CompiledRule, WordStatus, PERSIST_DEBOUNCE_MS, PERSIST_MAX_DELAY_MS,
WordState, isTouchedWordState, TeachResult, QuizAnswer, GradeVerdict,
GradeResult, ConversationAnswer, ConversationReport, EdgeRef,
AnswerGradeEntry, ANSWER_GRADES_CAP, SWEEP_RESOLVED_CAP, AnswerProvenance,
ChatAnswer, ChatAnswerWithMemory, CreativeReply, EMPTY_PROVENANCE, edgeKey,
operatorEdges, CREATIVE_REINFORCE_SCORE, VERIFY_UNLOCK_THRESHOLD,
RETENTION_FRACTION, CREATIVE_WEAKEN_SCORE, CREATIVE_GRADE_DELTA,
creativeGradeDelta, QUIZ_GRADE_DELTA, QUIZ_WEAKEN_FLOOR, CONTENT_RECALL_FLOOR,
CONTENT_RECALL_MARGIN, meaningCueOf, normalizedContentTokens,
CONVERSATION_HIGH_CONFIDENCE, CONVERSATION_MIN_MARGIN, READING_WORD_BUDGET,
authoritativeRecall, AutoLoopPhase, AutoLoopStep, AutoLoopHandle,
AutoLoopOptions, sleep, REVIEW_STRENGTH_THRESHOLD, SOON_STRENGTH_THRESHOLD,
RECALL_SETTLE_STEPS, SETTLE_DT, matchesCue, WordDueStatus, WordReport,
RetentionReport, isStaleEncoding`
…plus the existing re-export block
(`export { retentionProbability, … } from './retention'` and the fsrs block) —
keep those re-exports in TeacherAgent.ts itself.

### Faculty method map

| File | Methods (verbatim moves) |
|---|---|
| `wordloop.ts` | `applyRetention, decayLearnedWeights, applyDefinitions, report, teach, ask, askCue, recallWithCue, contentRecall, identifyMeaning, grade, recordAnswerGrade, answerGradeLedger, graderReliability, reliabilityOf, reliabilityOfUtterance, difficultyBandOfSeeds, listWords, phraseStrength, recallStrengthOf, consolidatedWords, recallSeedContents, recallMemories, exciteAndSettle, calibrationReport, calibrationGates` |
| `curriculum.ts` | `nextReview, legacyNextReview, nextLearnedWord, nextNewWord, curriculumContext, curriculumVocabulary, curriculumQueue, curriculumItems, recordDrillResult, drillFailuresSnapshot, legacyQueue` |
| `relations.ts` | `invalidateRelations, authoredRelationPool, framesForSubject, speakFromFrames, readFrom, applyRelations, buildRelationsCache, relations, classesFor, exampleCorroborates, addEdgeSource, refreshHypothesisEdges, promoteHypothesisIfCorroborated, hypothesisEdgeList, hypothesisAnswerFor, removeEdgeSource, edgeSourcesOf, noteConversationEvidence, rebuildRelationalHologram, edgesOf, relationalScore, edgeStrengthOf, bumpEdge, storeNegation, negationOf, negationsList, retractNegation, sweepResolutionLedger, markSweepConflictResolved, noteConflictBelief` |
| `rules.ts` | `compiledRuleCount, compiledRulesView, registerCompiledRule, applyCompiledRule, rewriteRuleStore, rewriteInductionEnabled, registerLearnedRules, registerInducedRules, teachRewriteRule, applyRewriteRules, weakenRule, ruleResolutionsView, notePendingRuleQuestion, pendingRuleQuestionsView, tryTeachReply, forgetPendingRuleQuestion, decayRuleCorroboration, consolidateLearnedRules, compositionRuleStore` |
| `operators.ts` | `rebuildLearnedOperators, learnedTemplateAudit, operatorAuditView, learnedPatternCount` |
| `motivation.ts` | `curiosityPressure, exposureOf, conservationPressure, noveltyOf, recallCoherence, driveSignals, driveSignalsStatic, drives, chooseNext, driveWeights, behaviorOutcomeCounts, noteBehaviorOutcome, recordGap, listGaps, forgetGap, teachGap, gapList, gapClusters, curiosityQuestion, beliefContradictions, verifyCandidate, verifyUnlocked, availableBehaviors` |
| `conversation.ts` | `teachResponse, teachConversationDeck, respond, conversationReport, listConversationPairs, storeBelief, beliefsOf, latestBelief, beliefAboutForOperator, deficitBeliefs, noteTurn, perturb, getWorkingMemory, episodicFacts, episodicRecall` |
| `creative.ts` | `creativeReply, creativeMemoryCount, creativeGradeFeedback, gradeCreativeWithReliability, noteAuthoredAnswer, previousAnswerFor, worldFeedbackCriteria, creditReAsk, creditRetention, noteFadeAgreement, seedLegacyFadeState, fadeAgreements, fadeLambdas, teacherDependenceRate, fadeReward, getCompositionWeights, getCompositionWeightMeta` |
| `goals.ts` | `storeGoalTrace, storeGoalIfNew, storeGoalIfNewInStatic, noteGoalFailure, adoptGoals, goalList, startGoalLoop, stopGoalLoop, stalledGoals, goalHistorySnapshot, noteGoalOutcome, noteGoalSuccess, noteGoalAbandon, activeGoalView` |
| `autoloop.ts` | `startAutoLoop, stopAutoLoop, onAutoStep, getAutoStep, isAutoLoopRunning` |
| `persistence.ts` | `maybePersist, schedulePersist, runScheduledPersist, flush, persistAll, restoreFromPersistence, restoreProducedCues, recoverProducedCuesFromTraces, rebuildCompositionWeightsFromMemory, importBootstrap, exportBootstrap, lastBootstrapImported, markBootstrapImported` |
| stays in `TeacherAgent.ts` | `constructor, setTuning, chatAnswer` |

If you find a method not listed here, put it in the faculty whose state it
touches most, and note it in the commit message.

---

## 4. Execution order (each numbered item = one commit)

1. **support.ts.** Move the module-scope block (everything above
   `export class TeacherAgent`) into `agent/support.ts`. TeacherAgent.ts
   imports what the class uses and re-exports the previously-public names.
   Gate, commit.
2. **base.ts.** Create `TeacherAgentCore` with ALL fields (protected) + the
   core helpers listed in §3 + the empty `CrossFacultyApi`. Change
   `class TeacherAgent` to `extends TeacherAgentCore`; delete the moved field
   declarations from TeacherAgent.ts; convert the constructor parameter
   properties to explicit assignments. All `this.x` references now resolve to
   protected members. Gate, commit. **This is the riskiest step — take it
   slowly and let tsc list what you missed.**
3. **autoloop.ts + goals.ts.** First two mixins (smallest). Compose them in
   TeacherAgent.ts. Whenever tsc reports a missing method on the mixin base,
   add its signature to `CrossFacultyApi`. Gate, commit.
4. **curriculum.ts + operators.ts.** Gate, commit.
5. **rules.ts.** Gate, commit.
6. **relations.ts.** Gate, commit.
7. **motivation.ts.** Gate, commit.
8. **conversation.ts.** Gate, commit.
9. **wordloop.ts.** Gate, commit.
10. **creative.ts.** Gate, commit.
11. **persistence.ts.** Gate, commit.
12. **Sweep.** TeacherAgent.ts should now be ~constructor + chatAnswer +
    setTuning + composition + re-exports. Run the full gates one more time
    plus the benches: `npx jest --testPathPatterns "ciGates" --testPathIgnorePatterns "/dev/null/"`.
    Update `TODO.md` (mark the W13 decomposition follow-up done, record final
    line counts: `wc -l src/teacher/TeacherAgent.ts src/teacher/agent/*.ts`).
    Commit.

## 5. Failure protocol

- A step goes red and the fix isn't obvious → `git checkout -- .` and redo the
  step in halves (move half the faculty's methods, gate, then the rest).
- jest fails but tsc passes → you changed behavior. Diff the moved method
  against `git show HEAD:apps/web/src/teacher/TeacherAgent.ts` and restore the
  body verbatim.
- A test imports something that vanished → restore it via the re-export list
  in TeacherAgent.ts; never edit the test.
- If the mixin typing fights you for more than ~15 minutes on a step, fall
  back for THAT faculty to: keep the methods in TeacherAgent.ts and move only
  what types cleanly; note it in the commit. Partial progress with green
  gates beats a clever red tree.

## 6. Definition of done

- `TeacherAgent.ts` ≤ ~800 lines; every faculty file ≤ ~900 lines.
- `npx tsc --noEmit` clean in apps/web; full jest green (1,110+ tests);
  ciGates 4/4.
- No test, consumer, or `teacher/index.ts` change.
- `git log` shows one commit per step, each gated.
