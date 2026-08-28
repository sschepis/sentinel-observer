import { describe, it, expect } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import { Dashboard } from './Dashboard';

describe('Dashboard', () => {
  it('renders the degraded banner and never fabricates metrics', () => {
    render(
      <Dashboard status="degraded" error={null} metrics={null} onStart={() => {}} onStop={() => {}} />
    );
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
    render(
      <Dashboard status="ready" error={null} metrics={metrics} onStart={() => {}} onStop={() => {}} />
    );
    expect(screen.getByText('0.834')).toBeDefined();
    expect(screen.getByText('2.100')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
