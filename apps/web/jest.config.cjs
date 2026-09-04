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
    // The server parity gate: a deliberate ~70s training + reload control.
    '<rootDir>/src/server/serverParity.test.ts'
  ],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { jsx: 'react-jsx' } }]
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1'
  },
  setupFilesAfterEnv: ['<rootDir>/src/test/setup.ts']
};
