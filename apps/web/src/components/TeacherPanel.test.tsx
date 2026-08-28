import { describe, it, expect } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import { TeacherPanel } from './TeacherPanel';
import type { TeacherAgent } from '../teacher/TeacherAgent';
import type { ObserverSignal } from '@sschepis/sentient-core';

/** Minimal structural stand-in for the teacher — the panel calls listWords()
 * and the auto-loop subscription methods. */
const fakeTeacher = {
  listWords: () => [
    {
      word: { word: 'apple', definition: 'a fruit', example: 'I eat an apple.' },
      traceId: 't1',
      taughtAt: 1,
      lastAskedAt: null,
      lastGrade: null,
      successes: 0,
      failures: 0,
      strength: 0.8,
      status: 'learning'
    }
  ],
  nextReview: () => null as string | null,
  nextLearnedWord: () => 'apple' as string | null,
  nextNewWord: () => null as string | null,
  teach: () => ({ word: { word: 'apple', definition: 'a fruit', example: '' }, traceId: 't1', note: '' }),
  ask: () => ({ word: { word: 'apple', definition: 'a fruit', example: '' }, cue: 'apple', answer: '', recall: null }),
  grade: () => ({
    word: { word: 'apple', definition: 'a fruit', example: '' },
    verdict: 'correct' as const,
    answer: '',
    expected: 'a fruit',
    confidence: 0.5
  }),
  onAutoStep: () => () => {},
  stopAutoLoop: () => {},
  isAutoLoopRunning: () => false,
  getAutoStep: () => null,
  startAutoLoop: () => ({ stop: () => {}, running: false })
} as unknown as TeacherAgent;

const memorySignal: ObserverSignal = {
  kind: 'memory',
  at: Date.now(),
  causeId: null,
  payload: { event: 'stored', traceId: 't1', content: 'apple: a fruit' }
};

describe('TeacherPanel', () => {
  it('asks the user to start the observer when no teacher exists', () => {
    render(<TeacherPanel teacher={null} diarySignals={[]} persistenceKind="memory" restoredCount={0} staleCount={0} />);
    expect(screen.getByText(/Start the observer first/i)).toBeDefined();
  });

  it('renders the vocabulary list with honest states', () => {
    render(<TeacherPanel teacher={fakeTeacher} diarySignals={[]} persistenceKind="memory" restoredCount={0} staleCount={0} />);
    expect(screen.getByText(/apple/)).toBeDefined();
    expect(screen.getByText('learning')).toBeDefined();
  });

  it("renders the observer's diary entries in the first person", () => {
    render(<TeacherPanel teacher={fakeTeacher} diarySignals={[memorySignal]} persistenceKind="memory" restoredCount={0} staleCount={0} />);
    expect(screen.getByText(/I learned "apple: a fruit" today\./)).toBeDefined();
  });

  it('shows the empty diary prompt without signals', () => {
    render(<TeacherPanel teacher={fakeTeacher} diarySignals={[]} persistenceKind="memory" restoredCount={0} staleCount={0} />);
    expect(screen.getByText(/The diary is empty/)).toBeDefined();
  });
});
