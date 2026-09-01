import { describe, it, expect, jest } from '@jest/globals';
import { render, screen, fireEvent } from '@testing-library/react';
import { TrainingView } from './TrainingView';
import type { LearningEngine } from '../learning/useLearningEngine';
import { DEFAULT_MODEL_SETTINGS } from '../observer/modelSettings';
import { makeEvent } from '../learning/events';

function engineStub(overrides: Partial<LearningEngine> = {}): LearningEngine {
  return {
    settings: { endpoint: 'https://example.test/v1/chat/completions', apiKey: '', model: 'gpt-4o-mini' },
    saveSettings: () => {},
    configured: true,
    model: { ...DEFAULT_MODEL_SETTINGS },
    saveModel: () => {},
    events: [
      makeEvent({ kind: 'word', label: 'word', text: 'learned word: apple', at: 1000 }),
      makeEvent({ kind: 'llm', label: 'teacher', text: 'what is an apple?', at: 2000 }),
      makeEvent({ kind: 'question', label: 'asks', text: 'what does ripe mean?', at: 3000 })
    ],
    clearEvents: () => {},
    pushEvent: () => {},
    running: false,
    stats: {
      cycles: 4,
      wordsTaught: 12,
      wordsReviewed: 3,
      phrasesTaught: 2,
      llmCalls: 5,
      selfAnswered: 5,
      creativeScores: [],
      drillsRun: 0,
      drillsInduced: 0,
      drillsMemorized: 0,
      lastDrill: null
    },
    error: null,
    start: () => {},
    stop: () => {},
    definitionProgress: null,
    definitionResult: null,
    runDefinitions: () => {},
    cancelDefinitions: () => {},
    revision: 0,
    ...overrides
  };
}

describe('TrainingView', () => {
  it('renders every learning event in one stream', () => {
    render(<TrainingView engine={engineStub()} diarySignals={[]} ready onOpenSettings={() => {}} />);
    expect(screen.getByText('learned word: apple')).toBeDefined();
    expect(screen.getByText('what is an apple?')).toBeDefined();
    expect(screen.getByText('what does ripe mean?')).toBeDefined();
  });

  it('filters the stream down to a single event type', () => {
    render(<TrainingView engine={engineStub()} diarySignals={[]} ready onOpenSettings={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /^Words/ }));
    expect(screen.getByText('learned word: apple')).toBeDefined();
    expect(screen.queryByText('what is an apple?')).toBeNull();
  });

  it('searches the stream', () => {
    render(<TrainingView engine={engineStub()} diarySignals={[]} ready onOpenSettings={() => {}} />);
    fireEvent.change(screen.getByLabelText('Filter the stream'), { target: { value: 'ripe' } });
    expect(screen.getByText('what does ripe mean?')).toBeDefined();
    expect(screen.queryByText('learned word: apple')).toBeNull();
  });

  it('folds the observer\'s own memory signals into the stream', () => {
    render(
      <TrainingView
        engine={engineStub()}
        diarySignals={[
          { kind: 'memory', at: 1500, causeId: null, payload: { event: 'stored', traceId: 't1', content: 'apple' } }
        ]}
        ready
        onOpenSettings={() => {}}
      />
    );
    expect(screen.getByText(/remembered "apple"/)).toBeDefined();
  });

  it('starts and stops learning', () => {
    const start = jest.fn();
    render(<TrainingView engine={engineStub({ start })} diarySignals={[]} ready onOpenSettings={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start learning' }));
    expect(start).toHaveBeenCalled();

    const stop = jest.fn();
    render(
      <TrainingView engine={engineStub({ running: true, stop })} diarySignals={[]} ready onOpenSettings={() => {}} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop learning' }));
    expect(stop).toHaveBeenCalled();
  });

  it('says that learning survives navigation while it runs', () => {
    render(<TrainingView engine={engineStub({ running: true })} diarySignals={[]} ready onOpenSettings={() => {}} />);
    expect(screen.getByText(/safe to navigate away/)).toBeDefined();
  });

  it('points at settings when no teacher model is configured', () => {
    const onOpenSettings = jest.fn();
    render(
      <TrainingView
        engine={engineStub({ configured: false })}
        diarySignals={[]}
        ready
        onOpenSettings={onOpenSettings}
      />
    );
    expect(screen.getByRole('button', { name: 'Start learning' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Add one in Settings' }));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it('reports drill outcomes separately from memorization', () => {
    render(
      <TrainingView
        engine={engineStub({
          stats: {
            cycles: 9,
            wordsTaught: 0,
            wordsReviewed: 0,
            phrasesTaught: 0,
            llmCalls: 0,
            selfAnswered: 0,
            creativeScores: [],
            drillsRun: 9,
            drillsInduced: 1,
            drillsMemorized: 8,
            lastDrill: { concept: 'multiplication', testAccuracy: 0, verdict: 'memorized' }
          }
        })}
        diarySignals={[]}
        ready
        onOpenSettings={() => {}}
      />
    );
    expect(screen.getByText(/9 drills · 1 induced · 8 memorized/)).toBeDefined();
    expect(screen.getByText(/multiplication 0% unseen/)).toBeDefined();
  });

  it('shows drill events under their own filter', () => {
    render(
      <TrainingView
        engine={engineStub({
          events: [
            makeEvent({
              kind: 'drill',
              label: 'drill · memorized',
              text: 'multiplication was memorized, not generalized',
              at: 1000
            }),
            makeEvent({ kind: 'word', label: 'word', text: 'learned word: apple', at: 2000 })
          ]
        })}
        diarySignals={[]}
        ready
        onOpenSettings={() => {}}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /^Drills/ }));
    expect(screen.getByText(/multiplication was memorized/)).toBeDefined();
    expect(screen.queryByText('learned word: apple')).toBeNull();
  });
});
