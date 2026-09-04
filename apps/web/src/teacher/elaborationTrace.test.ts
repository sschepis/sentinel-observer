/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { elaborate, ElaborationTraceMemory } from './elaboration';
import { retentionProbability, STABILITY_PRESETS } from './retention';
import type { Relation } from './relations';

const RELATIONS: Relation[] = [
  { subject: 'robin', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex', strength: 1.2 },
  { subject: 'robin', predicate: 'is-a', object: 'animal', source: 'def', origin: 'regex', strength: 0.9 },
  { subject: 'bird', predicate: 'is-a', object: 'animal', source: 'def', origin: 'regex', strength: 1.4 }
];

const DAY = 24 * 60 * 60 * 1000;

describe('elaboration-trace-bench (§8.4)', () => {
  it('a graded elaboration is stored as a trace whose content is the edges it drew on', () => {
    const memory = new ElaborationTraceMemory();
    const result = elaborate('robin', RELATIONS, { traceMemory: memory, grade: 0.95 });
    expect(result.storedTraceId).not.toBeNull();
    const trace = memory.traceOf('robin');
    expect(trace).not.toBeNull();
    expect(trace!.metadata.kind).toBe('elaboration');
    // The trace content IS the edges the elaboration drew on — a memory
    // whose content is other memories.
    expect(trace!.traceIds).toContain('robin:is-a:bird');
    expect(trace!.traceIds).toContain('bird:is-a:animal');
    expect(trace!.traceIds.length).toBe(result.citedEdges.length);
  });

  it('re-asking the same subject recalls the stored elaboration instead of re-searching', () => {
    const memory = new ElaborationTraceMemory();
    const first = elaborate('robin', RELATIONS, { traceMemory: memory, grade: 1.0 });
    const again = elaborate('robin', RELATIONS, { traceMemory: memory });
    expect(again.recalled).toBe(true);
    expect(again.sentences).toEqual(first.sentences);
    expect(again.claims.map((c) => c.sentence)).toEqual(first.claims.map((c) => c.sentence));
    expect(again.stopReason).toBe(first.stopReason);
    expect(again.groundingProduct).toBe(first.groundingProduct);
  });

  it('a below-floor grade is never cached — the next ask re-searches', () => {
    const memory = new ElaborationTraceMemory();
    const first = elaborate('robin', RELATIONS, { traceMemory: memory, grade: 0.4 });
    expect(first.storedTraceId).toBeNull();
    const again = elaborate('robin', RELATIONS, { traceMemory: memory });
    expect(again.recalled).toBe(false);
  });

  it('stored elaborations decay under the one retention law like ordinary traces', () => {
    let now = Date.parse('2026-01-01T00:00:00Z');
    const memory = new ElaborationTraceMemory({ now: () => now });
    elaborate('robin', RELATIONS, { traceMemory: memory, grade: 1.0 });
    const trace = memory.traceOf('robin')!;

    // Fresh: full strength, recalls.
    expect(memory.traceStrength(trace)).toBeCloseTo(1, 6);
    expect(elaborate('robin', RELATIONS, { traceMemory: memory }).recalled).toBe(true);

    // 30 days later the trace has decayed under the ONE law — exactly the
    // ordinary non-word-trace curve — but still recalls.
    now += 30 * DAY;
    expect(memory.traceStrength(trace)).toBeCloseTo(
      retentionProbability(STABILITY_PRESETS.nonWordTraceDays, 30),
      6
    );
    expect(memory.traceStrength(trace)).toBeLessThan(1);
    expect(elaborate('robin', RELATIONS, { traceMemory: memory }).recalled).toBe(true);

    // The access refreshed the clock, like an ordinary trace access.
    expect(memory.traceStrength(trace)).toBeCloseTo(1, 6);

    // Unpracticed for two years, the trace decays below the recall floor —
    // pruned like an ordinary weak trace — and the ask re-searches.
    now += 730 * DAY;
    expect(memory.traceStrength(trace)).toBeLessThan(memory.recallFloor);
    const fresh = elaborate('robin', RELATIONS, { traceMemory: memory });
    expect(fresh.recalled).toBe(false);
    expect(fresh.stopReason).toBe('frontier-empty');
  });

  it('a stored elaboration whose edges no longer validate is re-searched', () => {
    const memory = new ElaborationTraceMemory();
    elaborate('robin', RELATIONS, { traceMemory: memory, grade: 1.0 });
    const changed: Relation[] = [
      { subject: 'robin', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex', strength: 1.2 }
    ];
    const again = elaborate('robin', changed, { traceMemory: memory });
    expect(again.recalled).toBe(false);
  });
});
