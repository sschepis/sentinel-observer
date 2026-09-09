/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/src/**/*.test.tsx'],
  // The heavy scale/recall benchmarks are deliberate gates, not unit tests:
  // they run only via `npm run test:bench`.
  testPathIgnorePatterns: [
    '<rootDir>/src/teacher/recallBenchmark.test.ts',
    '<rootDir>/src/teacher/scaleBenchmark.test.ts',
    '<rootDir>/src/teacher/scale20kBenchmark.test.ts',
    '<rootDir>/src/teacher/fullDeckPruning.test.ts',
    '<rootDir>/src/teacher/ciGates.test.ts',
    '<rootDir>/src/teacher/semanticRecall.test.ts',
    '<rootDir>/src/teacher/clusterMomentBenchmark.test.ts',
    '<rootDir>/src/teacher/competitionBenchmark.test.ts',
    '<rootDir>/src/teacher/centerSketchesFalsifier.test.ts',
    // 4 observer arms x an elapsed-time sweep: the §4.2 experiment, not a unit test.
    '<rootDir>/src/teacher/phaseFrameBenchmark.test.ts',
    // 10 arms x (200 words + 728 pairs): a physics sweep, not a unit test.
    '<rootDir>/src/teacher/sparseExcitationBenchmark.test.ts',
    // Two arms x (24 primed + 8 unrelated) observer sessions: the §6.3
    // priming experiment, not a unit test.
    '<rootDir>/src/teacher/primingBenchmark.test.ts',
    // The server parity gate: a deliberate ~70s training + reload control.
    '<rootDir>/src/server/serverParity.test.ts',
    // Null-model arms for the memory substrate (IMPROVEMENT_PLAN §2.1): a
    // measurement that writes bench/null-arms/*.json, not a unit test.
    '<rootDir>/src/teacher/nullArmsBenchmark.test.ts',
    // Corpus ingestion at 5k–50k edges over the full deck: the number the
    // classroom's ingest budget is set from, not a unit test.
    '<rootDir>/src/curriculum/ingestScaleBenchmark.test.ts',
    // Reads the operator's corpus files (absent in CI): a measurement, not a unit test.
    '<rootDir>/src/curriculum/passageBenchmark.test.ts',
    // The person test (docs/SYNTHETIC_MIND.md task 43): a measurement whose
    // shapes are expected to fail until conversation is a learning channel.
    '<rootDir>/src/teacher/oneShotLearningBenchmark.test.ts',
    // Held-out ConceptNet recovery + the entropy prediction (tasks 40/41):
    // reads the operator's corpus and feeds for minutes — a measurement.
    '<rootDir>/src/curriculum/heldOutRecoveryBenchmark.test.ts',
    // Corpus-scale cost profile (tasks 60/61): reads the operator's corpus.
    '<rootDir>/src/curriculum/corpusProfile.test.ts',
    // Word-problem capability on the SVAMP/ASDiv corpus: reads the operator's corpus.
    '<rootDir>/src/curriculum/problemsBenchmark.test.ts',
    '<rootDir>/src/curriculum/corpusWiring.test.ts'
  ],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { jsx: 'react-jsx' } }]
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1'
  },
  setupFilesAfterEnv: ['<rootDir>/src/test/setup.ts']
};
