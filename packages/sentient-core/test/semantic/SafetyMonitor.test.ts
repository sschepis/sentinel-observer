/**
 * SafetyMonitor tests.
 *
 * The legacy lib/safety.js fallback was FAIL-OPEN: `checkConstraints()` and
 * `isActionPermissible()` returned `safe: true` / `permissible: true`
 * unconditionally, without evaluating a single rule. Because the ESM library
 * never loaded, that fallback WAS the safety layer.
 *
 * These tests pin down the fail-closed contract.
 */
import { describe, it, expect } from '@jest/globals';
import { METRIC_ACTION_TYPE, SafetyMonitor } from '../../src/semantic';

describe('SafetyMonitor (fail-closed)', () => {
  it('denies an unregistered action type', () => {
    const monitor = new SafetyMonitor();
    const result = monitor.checkAction({ type: 'exfiltrate.keys' });

    expect(result.allowed).toBe(false);
    expect(result.violations[0].reason).toBe('unknown_action_type');
    expect(result.violations[0].severity).toBe('critical');
    expect(result.maxSeverity).toBe('critical');
  });

  it('denies a malformed action with no type', () => {
    const monitor = new SafetyMonitor();
    const result = monitor.checkAction({ type: '' });
    expect(result.allowed).toBe(false);
    expect(result.violations[0].reason).toBe('unknown_action_type');
  });

  it('denies an action requiring an unknown constraint', () => {
    const monitor = new SafetyMonitor().registerActionType('emit.output');
    const result = monitor.checkAction({ type: 'emit.output', requires: ['no_such_rule'] });

    expect(result.allowed).toBe(false);
    expect(result.violations.map(v => v.reason)).toContain('unknown_constraint');
    expect(result.violations[0].constraintId).toBe('no_such_rule');
  });

  it('denies when a constraint predicate throws', () => {
    const monitor = new SafetyMonitor()
      .registerActionType('emit.output')
      .addConstraint(
        SafetyMonitor.predicateConstraint(
          'explodes',
          'always throws',
          () => {
            throw new Error('boom');
          },
          'high',
          ['emit.output']
        )
      );

    const result = monitor.checkAction({ type: 'emit.output' });
    expect(result.allowed).toBe(false);
    expect(result.violations[0].reason).toBe('evaluation_error');
    expect(result.violations[0].detail).toContain('boom');
  });

  it('denies when a constraint returns a non-boolean (truthy is not enough)', () => {
    const monitor = new SafetyMonitor()
      .registerActionType('emit.output')
      .addConstraint({
        id: 'sloppy',
        description: 'returns a truthy string',
        severity: 'medium',
        appliesTo: ['emit.output'],
        evaluate: () => 'yes' as unknown as boolean
      });

    const result = monitor.checkAction({ type: 'emit.output' });
    expect(result.allowed).toBe(false);
    expect(result.violations[0].reason).toBe('non_boolean_result');
  });

  it('denies non-finite metrics instead of treating them as neutral', () => {
    const monitor = SafetyMonitor.forObserver();

    for (const bad of [NaN, Infinity, -Infinity]) {
      const result = monitor.checkMetrics({
        coherence: bad,
        orderParameter: 0.5,
        entropy: 1,
        fieldEnergy: 1
      });
      expect(result.allowed).toBe(false);
      expect(result.violations.some(v => v.reason === 'unevaluable_metric')).toBe(true);
    }
  });

  it('denies a missing metric that a bound constraint requires', () => {
    const monitor = SafetyMonitor.forObserver();
    // `coherence` is absent entirely: unevaluable, therefore denied.
    const result = monitor.checkAction({ type: METRIC_ACTION_TYPE, metrics: { entropy: 1 } });

    expect(result.allowed).toBe(false);
    expect(result.violations.some(v => v.constraintId === 'coherence.range')).toBe(true);
    expect(result.violations.some(v => v.reason === 'constraint_failed')).toBe(true);
  });

  it('denies out-of-range metrics', () => {
    const monitor = SafetyMonitor.forObserver();
    const result = monitor.checkMetrics({
      coherence: 1.5,
      orderParameter: -0.2,
      entropy: 2,
      fieldEnergy: 10
    });

    expect(result.allowed).toBe(false);
    const failed = result.violations.map(v => v.constraintId);
    expect(failed).toContain('coherence.range');
    expect(failed).toContain('orderParameter.range');
  });

  it('allows only a fully-evaluated, fully-satisfied action', () => {
    const monitor = SafetyMonitor.forObserver();
    const result = monitor.checkMetrics({
      coherence: 0.4,
      orderParameter: 0.2,
      entropy: 1.5,
      fieldEnergy: 12.5
    });

    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.maxSeverity).toBeNull();
    expect(result.evaluated).toEqual(
      expect.arrayContaining(['coherence.range', 'orderParameter.range', 'entropy.range', 'fieldEnergy.range'])
    );
  });

  it('addConstraint does NOT auto-register action types; registration is explicit', () => {
    const monitor = new SafetyMonitor();
    expect(monitor.isActionTypeRegistered('tool.invoke')).toBe(false);

    // Adding a constraint that governs 'tool.invoke' must not silently vet
    // the type: only an explicit registerActionType call is the audit point.
    monitor.addConstraint(
      SafetyMonitor.predicateConstraint('always-ok', 'permits', () => true, 'low', ['tool.invoke'])
    );

    expect(monitor.isActionTypeRegistered('tool.invoke')).toBe(false);
    expect(monitor.checkAction({ type: 'tool.invoke' }).allowed).toBe(false);

    monitor.registerActionType('tool.invoke');
    expect(monitor.isActionTypeRegistered('tool.invoke')).toBe(true);
    expect(monitor.checkAction({ type: 'tool.invoke' }).allowed).toBe(true);
    // ...but a sibling type is still unknown and therefore denied.
    expect(monitor.checkAction({ type: 'tool.delete' }).allowed).toBe(false);
  });

  it("'all' constraints apply to every registered type", () => {
    const monitor = new SafetyMonitor()
      .registerActionType('a')
      .registerActionType('b')
      .addConstraint(
        SafetyMonitor.predicateConstraint('global-deny', 'denies everything', () => false, 'critical', 'all')
      );

    expect(monitor.checkAction({ type: 'a' }).allowed).toBe(false);
    expect(monitor.checkAction({ type: 'b' }).allowed).toBe(false);
  });

  it('records violation history and stats', () => {
    const monitor = new SafetyMonitor({ maxHistory: 4 });
    for (let i = 0; i < 6; i++) monitor.checkAction({ type: `unknown-${i}` });

    expect(monitor.getViolationHistory()).toHaveLength(4);

    const stats = monitor.stats();
    expect(stats.checks).toBe(6);
    expect(stats.denials).toBe(6);
    expect(stats.denialRate).toBe(1);
    expect(stats.violationsBySeverity.critical).toBe(6);

    monitor.clearHistory();
    expect(monitor.getViolationHistory()).toHaveLength(0);
  });

  it('rejects malformed constraint registration', () => {
    const monitor = new SafetyMonitor();
    expect(() => monitor.addConstraint({ ...SafetyMonitor.boundsConstraint('x', 'm', {}), id: '' })).toThrow();
    expect(() =>
      monitor.addConstraint({
        id: 'no-eval',
        description: 'missing evaluate',
        severity: 'low',
        appliesTo: 'all'
      } as never)
    ).toThrow();
    expect(() => monitor.registerActionType('')).toThrow();
  });

  it('removeConstraint drops the rule', () => {
    const monitor = SafetyMonitor.forObserver();
    expect(monitor.hasConstraint('coherence.range')).toBe(true);
    expect(monitor.removeConstraint('coherence.range')).toBe(true);
    expect(monitor.hasConstraint('coherence.range')).toBe(false);
    expect(monitor.removeConstraint('coherence.range')).toBe(false);
  });
});
