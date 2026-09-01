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
    '<rootDir>/src/teacher/semanticRecall.test.ts'
  ],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { jsx: 'react-jsx' } }]
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1'
  },
  setupFilesAfterEnv: ['<rootDir>/src/test/setup.ts']
};
