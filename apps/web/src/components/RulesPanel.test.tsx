import { describe, it, expect } from '@jest/globals';
import { render, screen, fireEvent } from '@testing-library/react';
import { RulesPanel, type RulesPanelSnapshot } from './RulesPanel';

function snapshot(overrides: Partial<RulesPanelSnapshot> = {}): RulesPanelSnapshot {
  return {
    rules: [
      {
        id: 'induced-nat.gcd-0',
        name: 'nat.gcd',
        origin: 'induced',
        strength: 1,
        sourceClasses: [],
        bits: 60,
        useCount: 4,
        stopped: false,
        hedged: true,
        denials: 0,
        schema: 'measure',
        evidence: 10
      },
      {
        id: 'authored nat.add-z',
        name: 'nat.add',
        origin: 'authored',
        strength: 1,
        sourceClasses: ['curriculum'],
        bits: 12,
        useCount: 120,
        stopped: false,
        hedged: false,
        denials: 0
      }
    ],
    compiledCount: 0,
    resolutions: [],
    ...overrides
  };
}

describe('RulesPanel', () => {
  it('R8: shows the learned rule with its state and hides the decks until asked', () => {
    render(<RulesPanel snapshot={snapshot()} />);
    expect(screen.getByText('nat.gcd')).toBeDefined();
    expect(screen.getByText('hedged')).toBeDefined();
    expect(screen.getByText(/1 learned · 1 authored deck rules/)).toBeDefined();
    // The decks are collapsed until asked.
    expect(screen.queryByText('authored nat.add-z')).toBeNull();
    expect(screen.getByRole('button', { name: /show the authored decks/ })).toBeDefined();
  });

  it('R8: reports a rule stopped by the world', () => {
    render(
      <RulesPanel
        snapshot={snapshot({
          rules: [
            {
              id: 'induced-nat.gcd-0',
              name: 'nat.gcd',
              origin: 'induced',
              strength: 0.1,
              sourceClasses: [],
              bits: 60,
              useCount: 4,
              stopped: true,
              hedged: true,
              denials: 2
            }
          ],
          resolutions: ['induced-nat.gcd-0']
        })}
      />
    );
    expect(screen.getByText('stopped by the world')).toBeDefined();
    expect(screen.getByText(/stopped by denial, never deleted: induced-nat.gcd-0/)).toBeDefined();
  });

  it('R8: prompts the user to drill when nothing is learned yet', () => {
    render(<RulesPanel snapshot={{ rules: [], compiledCount: 0, resolutions: [] }} />);
    expect(screen.getByText(/Nothing learned yet/)).toBeDefined();
    expect(screen.getByRole('button', { name: /show the authored decks/ })).toBeDefined();
  });

  it('R8: the decks collapse row lists every authored rule', () => {
    render(<RulesPanel snapshot={snapshot()} />);
    fireEvent.click(screen.getByRole('button', { name: /show the authored decks/ }));
    expect(screen.getByText('hide the authored decks (1)')).toBeDefined();
  });
});
