import { describe, it, expect } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import { TeacherPanel } from './TeacherPanel';
import type { TeacherAgent } from '../teacher/TeacherAgent';
import type { ObserverSignal } from '@sschepis/sentient-core';

/** Minimal structural stand-in for the teacher — the panel only calls listWords(). */
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
  ]
} as unknown as TeacherAgent;

const memorySignal: ObserverSignal = {
  kind: 'memory',
  at: Date.now(),
  causeId: null,
  payload: { event: 'stored', traceId: 't1', content: 'apple: a fruit' }
};

describe('TeacherPanel', () => {
  it('asks the user to start the observer when no teacher exists', () => {
    render(<TeacherPanel teacher={null} diarySignals={[]} />);
    expect(screen.getByText(/Start the observer first/i)).toBeDefined();
  });

  it('renders the vocabulary list with honest states', () => {
    render(<TeacherPanel teacher={fakeTeacher} diarySignals={[]} />);
    expect(screen.getByText(/apple/)).toBeDefined();
    expect(screen.getByText('learning')).toBeDefined();
  });

  it("renders the observer's diary entries in the first person", () => {
    render(<TeacherPanel teacher={fakeTeacher} diarySignals={[memorySignal]} />);
    expect(screen.getByText(/I learned "apple: a fruit" today\./)).toBeDefined();
  });

  it('shows the empty diary prompt without signals', () => {
    render(<TeacherPanel teacher={fakeTeacher} diarySignals={[]} />);
    expect(screen.getByText(/The diary is empty/)).toBeDefined();
  });
});
