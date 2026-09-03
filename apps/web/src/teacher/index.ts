/**
 * The teacher's curriculum API — the difficulty-targeted lesson queue:
 * scoring signals, ranking, and queue construction (curriculum.ts) plus
 * the TeacherAgent wiring (nextReview / nextNewWord / plan.ts priority).
 */
export * from './curriculum';
export * from './rules/terms';
export * from './rules/types';
export * from './rules/engine';
export * from './rules/parse';
export * from './rules/peano';
export * from './rules/digits';
export * from './rules/int';
export * from './rules/logic';
export * from './rules/induction';
export * from './rules/compositionSeeds';
