import { describe, it, expect } from '@jest/globals';
import { render, screen, fireEvent } from '@testing-library/react';
import { Dashboard } from './Dashboard';

const noop = () => {};

const baseProps = {
  error: null,
  metrics: null as never,
  lastStimulus: null as never,
  signals: [] as never[],
  onStart: noop,
  onStop: noop
};

describe('Dashboard', () => {
  it('renders the degraded banner and never fabricates metrics', () => {
    render(<Dashboard status="degraded" {...baseProps} />);
    expect(screen.getByRole('alert').textContent).toMatch(/degraded mode/i);
    // All six metric cards render placeholders — none fabricate numbers.
    expect(screen.getAllByText('—')).toHaveLength(6);
  });

  it('shows real metric values when the observer is running', () => {
    const metrics = {
      tickCount: 10,
      time: 2.5,
      coherence: 0.834,
      entropy: 2.1,
      orderParameter: 0.6,
      smf: new Array(16).fill(0.1),
      smfNormalizedEntropy: 0.9,
      holographicEnergy: 4.2,
      holographicEntropy: 2.0,
      holographicDrift: 0.01,
      activePrimes: [2, 3, 5],
      activePrimeCount: 3,
      totalAmplitude: 1.0,
      momentCount: 2,
      lastMomentId: null,
      memoryTraceCount: 1,
      safety: { allowed: true, violations: [] },
      kernel: { loaded: true, degraded: false }
    } as never;
    render(<Dashboard status="ready" {...baseProps} metrics={metrics} />);
    expect(screen.getByText('0.834')).toBeDefined();
    expect(screen.getByText('2.100')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('explains the latest stimulus in the "why" panel', () => {
    const lastStimulus = {
      stimulusId: '11111111-2222-4333-8444-555555555555',
      kind: 'text' as const,
      excitedPrimes: [2, 3, 5],
      touchedAxes: ['coherence'],
      coherenceDelta: 0.04,
      activePrimeCount: 12
    };
    render(<Dashboard status="ready" {...baseProps} lastStimulus={lastStimulus} />);
    expect(screen.getByText(/excited primes \[2, 3, 5\]/)).toBeDefined();
    expect(screen.getByText(/Coherence moved/)).toBeDefined();
  });

  it('renders interpreted signals in the stream', () => {
    const signals = [
      {
        kind: 'drift' as const,
        at: Date.now(),
        causeId: null,
        payload: {
          axis: 'coherence',
          direction: 'down' as const,
          durationMs: 120000,
          coherenceStart: 0.5,
          coherenceEnd: 0.3
        }
      }
    ];
    render(<Dashboard status="ready" {...baseProps} signals={signals} />);
    expect(screen.getByText('Focus drift')).toBeDefined();
    expect(screen.getByText(/coherence fell 0\.200/)).toBeDefined();
  });
});
