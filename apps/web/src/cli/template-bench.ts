#!/usr/bin/env node
/**
 * TEMPLATE ACCEPTANCE BENCH (P5 extension) — fixed frames vs. fixed +
 * learned relation-hole templates, head to head.
 *
 * Runs a deterministic probe corpus through composeGrounded twice: once with
 * the fixed frames only, once with a LearnedFrameStore that induces
 * templates from the surrogate world's accepted answers (warmup), then
 * measures acceptance on both arms. The world model is a scripted surrogate
 * for an LLM grader (grounded + 2-3 clauses + a part-of clause) so the
 * numbers are reproducible — see templateAcceptance.ts.
 *
 * GATE: the learned arm must match or beat the fixed baseline — the same
 * criterion the admission gate enforces per template.
 *
 * Usage: npm run template-bench
 */
import { templateAcceptanceBench } from '../teacher/templateAcceptance';
import type { Relation } from '../teacher/relations';

const RELATIONS: Relation[] = [
  { subject: 'robin', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex' },
  { subject: 'robin', predicate: 'has-part', object: 'wings', source: 'def', origin: 'regex' },
  { subject: 'robin', predicate: 'capable-of', object: 'fly', source: 'def', origin: 'regex' },
  { subject: 'sparrow', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex' },
  { subject: 'sparrow', predicate: 'has-part', object: 'wings', source: 'def', origin: 'regex' },
  { subject: 'sparrow', predicate: 'capable-of', object: 'sing', source: 'def', origin: 'regex' },
  { subject: 'penguin', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex' },
  { subject: 'penguin', predicate: 'has-part', object: 'wings', source: 'def', origin: 'regex' },
  { subject: 'penguin', predicate: 'capable-of', object: 'swim', source: 'def', origin: 'regex' },
  { subject: 'duck', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex' },
  { subject: 'duck', predicate: 'has-part', object: 'bill', source: 'def', origin: 'regex' },
  { subject: 'duck', predicate: 'capable-of', object: 'swim', source: 'def', origin: 'regex' },
  { subject: 'canary', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex' },
  { subject: 'canary', predicate: 'has-part', object: 'wings', source: 'def', origin: 'regex' },
  { subject: 'canary', predicate: 'capable-of', object: 'sing', source: 'def', origin: 'regex' },
  { subject: 'wren', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex' },
  { subject: 'wren', predicate: 'has-part', object: 'wings', source: 'def', origin: 'regex' },
  { subject: 'wren', predicate: 'capable-of', object: 'hop', source: 'def', origin: 'regex' }
];

const PROBES = ['robin', 'sparrow', 'penguin', 'duck', 'canary', 'wren'];

const result = templateAcceptanceBench(RELATIONS, [], { rounds: 200, warmup: 80, seed: 0x5eed, probes: PROBES });

console.log('TEMPLATE ACCEPTANCE BENCH (P5 extension)');
console.log('world model: grounded + 2-3 clauses + a has-part clause (surrogate for an LLM grader)');
console.log('─'.repeat(72));
console.log(`baseline (fixed frames):      ${result.baselineAccepted}/${result.rounds} = ${(result.baselineRate * 100).toFixed(1)}%`);
console.log(`learned (fixed + learned):    ${result.learnedAccepted}/${result.rounds} = ${(result.learnedRate * 100).toFixed(1)}%`);
console.log(`delta:                        ${((result.learnedRate - result.baselineRate) * 100).toFixed(1)} points`);
console.log('─'.repeat(72));
console.log(`learned templates: ${result.admitted} admitted, ${result.exploring} exploring, ${result.dropped} dropped`);
for (const entry of result.learnedTemplates) {
  console.log(
    `  [${entry.status.padEnd(9)}] ev=${entry.evidence} uses=${entry.uses} acc=${entry.accepted} rej=${entry.rejected} "${entry.text}"`
  );
}
console.log('─'.repeat(72));
for (const sample of result.samples) {
  console.log(`  ${sample.arm.padEnd(8)} ${sample.accepted ? 'accept' : 'reject'}  "${sample.sentence}"`);
}
console.log('─'.repeat(72));
const gate = result.learnedRate >= result.baselineRate;
console.log(`GATE: learned acceptance >= baseline acceptance → ${gate ? 'PASS' : 'FAIL'}`);
