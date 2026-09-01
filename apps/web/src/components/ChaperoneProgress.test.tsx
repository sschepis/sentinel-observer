import { describe, it, expect } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import { ChaperoneProgress, type ChaperoneProgressState } from './ChaperoneProgress';

const runningState: ChaperoneProgressState = {
  phase: 'running',
  batchIndex: 2,
  totalBatches: 305,
  wordsDone: 16,
  wordsTotal: 2437,
  generated: 14,
  skipped: 2,
  errors: 0,
  lastError: null,
  currentWords: ['the', 'be', 'and', 'of', 'a', 'in', 'to', 'have'],
  startedAt: Date.now() - 60_000,
  elapsedMs: 60_000,
  feed: [
    { word: 'apple', definition: 'a round red or green fruit' },
    { word: 'water', definition: 'the clear liquid we drink' }
  ]
};

describe('ChaperoneProgress', () => {
  it('shows live activity while the model works: batch, counters, words, feed', () => {
    render(<ChaperoneProgress progress={runningState} result={null} onCancel={() => {}} />);
    expect(screen.getByText(/generating batch 3\/305/)).toBeDefined();
    expect(screen.getByText(/16\/2437 words · 14 generated · 2 skipped/)).toBeDefined();
    expect(screen.getByText(/asking the model about:/)).toBeDefined();
    expect(screen.getByText(/apple — a round red or green fruit/)).toBeDefined();
    expect(screen.getByText(/water — the clear liquid we drink/)).toBeDefined();
    expect(screen.getByText(/elapsed 60s/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDefined();
  });

  it('reports an ETA once at least one batch has completed', () => {
    render(<ChaperoneProgress progress={runningState} result={null} onCancel={() => {}} />);
    // 60s elapsed / 2 batches * 303 remaining = 9090s ≈ 2h 31m.
    expect(screen.getByText(/ETA 2h 31m/)).toBeDefined();
  });

  it('shows the completion state without the cancel button', () => {
    render(
      <ChaperoneProgress
        progress={{ ...runningState, phase: 'done', currentWords: [] }}
        result={null}
        onCancel={() => {}}
      />
    );
    expect(screen.getByText('run complete')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('shows the latest batch failure and the server error immediately', () => {
    render(
      <ChaperoneProgress
        progress={{
          ...runningState,
          errors: 1,
          lastError: {
            batch: 3,
            words: ['the', 'be'],
            message: 'LLM endpoint returned 400: structured output unavailable'
          }
        }}
        result={null}
        onCancel={() => {}}
      />
    );

    expect(screen.getByRole('alert').textContent).toContain('Batch 3 failed for the, be.');
    expect(screen.getByRole('alert').textContent).toContain('LLM endpoint returned 400: structured output unavailable');
  });

  it('renders nothing before a run starts', () => {
    const { container } = render(<ChaperoneProgress progress={null} result={null} onCancel={() => {}} />);
    expect(container.textContent).toBe('');
  });
});
