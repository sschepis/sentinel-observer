import { describe, it, expect } from '@jest/globals';
import { classifyAutonomousEvent, fromObserverSignal, fromEpisodicFact, EVENT_FILTERS, EVENT_STYLES } from './events';
import type { ObserverSignal } from '@sschepis/sentient-core';

describe('learning events', () => {
  it('classifies each autonomous cycle event into a filterable kind', () => {
    expect(classifyAutonomousEvent({ role: 'system', text: '', meta: 'word' })).toBe('word');
    expect(classifyAutonomousEvent({ role: 'system', text: '', meta: 'review' })).toBe('review');
    expect(classifyAutonomousEvent({ role: 'system', text: '', meta: 'pair' })).toBe('phrase');
    expect(classifyAutonomousEvent({ role: 'system', text: '', meta: 'gap' })).toBe('phrase');
    expect(classifyAutonomousEvent({ role: 'system', text: '', meta: 'grade' })).toBe('grade');
    expect(classifyAutonomousEvent({ role: 'system', text: '', meta: 'drives' })).toBe('drive');
    expect(classifyAutonomousEvent({ role: 'system', text: '', meta: 'error' })).toBe('error');
    expect(classifyAutonomousEvent({ role: 'llm', text: '' })).toBe('llm');
    expect(classifyAutonomousEvent({ role: 'observer', text: '' })).toBe('observer');
    expect(classifyAutonomousEvent({ role: 'observer', text: '', meta: 'curious' })).toBe('question');
  });

  it('folds memory signals into the stream and ignores everything else', () => {
    const stored: ObserverSignal = {
      kind: 'memory',
      at: 1000,
      causeId: null,
      payload: { event: 'stored', traceId: 't1', content: 'apple: a fruit' }
    };
    const event = fromObserverSignal(stored);
    expect(event).not.toBeNull();
    expect(event?.kind).toBe('memory');
    expect(event?.text).toContain('apple: a fruit');
    expect(event?.at).toBe(1000);

    const tick: ObserverSignal = {
      kind: 'metric',
      at: 2000,
      causeId: null,
      payload: { coherence: 0.5, entropy: 0.5 }
    } as ObserverSignal;
    expect(fromObserverSignal(tick)).toBeNull();
  });

  it('covers every event kind with the "Everything" filter', () => {
    const everything = EVENT_FILTERS.find((filter) => filter.key === 'all');
    expect(everything).toBeDefined();
    for (const kind of Object.keys(EVENT_STYLES)) {
      expect(everything?.kinds).toContain(kind);
    }
  });

  it('folds a new episodic fact into the stream as a "remembers" event', () => {
    const event = fromEpisodicFact(
      {
        id: 'user-fact:english|work',
        kind: 'user-fact',
        content: 'I am learning English for work.',
        topics: ['english', 'work'],
        probe: 'I am learning English for work.',
        firstSeenAt: 1,
        lastSeenAt: 2,
        timesSeen: 1,
        sessions: ['session-1'],
        sessionCount: 1
      },
      1234
    );
    expect(event.kind).toBe('episodic');
    expect(event.label).toBe('remembers');
    expect(event.text).toContain('learning English for work');
    expect(event.at).toBe(1234);
  });
});
