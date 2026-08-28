/**
 * Safety Monitor
 *
 * Typed constraint checking for observer actions and runtime metrics.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Fix relative to `lib/safety.js` (flagged critical by review)
 * ──────────────────────────────────────────────────────────────────────────
 *
 *   checkConstraints(metrics)          { return { safe: true, ... }; }
 *   isActionPermissible(action, ctx)   { return { permissible: true, ... }; }
 *
 * The legacy fallback was FAIL-OPEN: it approved every action and reported
 * `safe: true` for every metric set, unconditionally, with no rule evaluation
 * at all. Because the real library never loaded (see `tinyaleph.ts`), that
 * fallback WAS the safety layer.
 *
 * This implementation is FAIL-CLOSED. An action is allowed only if all of the
 * following hold:
 *
 *   - its `type` has been explicitly registered (an unregistered type denies),
 *   - every constraint id it declares in `requires` is registered,
 *   - every attached metric is a finite number,
 *   - every applicable constraint evaluates, without throwing, to exactly
 *     `true`.
 *
 * Anything else - unknown action, unknown constraint, throwing predicate,
 * non-boolean return, NaN metric, missing metric - denies.
 */

import { clampRange, requireFinite, safeDivide } from './numeric';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type SafetySeverity = 'low' | 'medium' | 'high' | 'critical';

/** Reasons a check can deny. Every one of them is a denial, never a warning. */
export type SafetyDenialReason =
  | 'unknown_action_type'
  | 'unknown_constraint'
  | 'unevaluable_metric'
  | 'constraint_failed'
  | 'evaluation_error'
  | 'non_boolean_result';

/** An action submitted for approval. */
export interface SafetyAction {
  /** Registered action type. An unregistered type is denied. */
  type: string;
  /** Constraint ids this action asserts it satisfies; each must be registered. */
  requires?: readonly string[];
  /** Numeric context evaluated by bound constraints. */
  metrics?: Readonly<Record<string, number>>;
  /** Non-numeric context, passed through to constraint predicates. */
  payload?: Readonly<Record<string, unknown>>;
}

/** A recorded violation. */
export interface SafetyViolation {
  constraintId: string;
  reason: SafetyDenialReason;
  severity: SafetySeverity;
  detail: string;
  at: number;
}

/** Result of a check. `allowed` is true only when `violations` is empty. */
export interface SafetyCheckResult {
  allowed: boolean;
  violations: readonly SafetyViolation[];
  /** Ids of constraints that were actually evaluated. */
  evaluated: readonly string[];
  /** Highest severity among the violations, or null when allowed. */
  maxSeverity: SafetySeverity | null;
}

/**
 * A constraint rule.
 *
 * `evaluate` must return a boolean. Throwing, or returning anything else, is
 * treated as a denial - an unevaluable constraint is never an approval.
 */
export interface SafetyConstraint {
  id: string;
  description: string;
  severity: SafetySeverity;
  /** Action types this constraint governs, or 'all'. */
  appliesTo: readonly string[] | 'all';
  evaluate(action: SafetyAction): boolean;
}

/** Bounds specification for `boundsConstraint`. */
export interface MetricBounds {
  min?: number;
  max?: number;
}

/** Monitor statistics. */
export interface SafetyStats {
  constraintCount: number;
  registeredActionTypes: readonly string[];
  checks: number;
  denials: number;
  denialRate: number;
  violationsBySeverity: Record<SafetySeverity, number>;
  historySize: number;
}

const SEVERITY_ORDER: Record<SafetySeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3
};

// ═══════════════════════════════════════════════════════════════════════════
// MONITOR
// ═══════════════════════════════════════════════════════════════════════════

/** Action type used by `checkMetrics`. Registered automatically. */
export const METRIC_ACTION_TYPE = 'metrics.evaluate';

export interface SafetyMonitorOptions {
  /** Retained violation history length (default 256). */
  maxHistory?: number;
}

export class SafetyMonitor {
  private readonly constraints = new Map<string, SafetyConstraint>();
  private readonly actionTypes = new Set<string>();
  private readonly history: SafetyViolation[] = [];
  private readonly maxHistory: number;

  private checks = 0;
  private denials = 0;
  private readonly severityCounts: Record<SafetySeverity, number> = {
    low: 0,
    medium: 0,
    high: 0,
    critical: 0
  };

  constructor(options: SafetyMonitorOptions = {}) {
    this.maxHistory = Math.max(1, Math.floor(options.maxHistory ?? 256));
    // Metric evaluation is an intrinsic, vetted action type.
    this.actionTypes.add(METRIC_ACTION_TYPE);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Registration
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Register a constraint. Registration is EXPLICIT on both sides: the
   * constraint is stored, and the action types it governs must be vetted
   * separately via `registerActionType()` - `addConstraint` does NOT
   * auto-register them, so a constraint can never silently widen the set of
   * checkable action types.
   */
  addConstraint(constraint: SafetyConstraint): this {
    if (!constraint.id) throw new Error('SafetyConstraint requires a non-empty id');
    if (typeof constraint.evaluate !== 'function') {
      throw new Error(`SafetyConstraint "${constraint.id}" requires an evaluate() function`);
    }
    this.constraints.set(constraint.id, constraint);
    return this;
  }

  /**
   * Explicitly vet an action type. Required: an unregistered type is denied,
   * so this call is the audit point where a human decided the type is legal.
   */
  registerActionType(type: string): this {
    if (!type) throw new Error('Action type must be a non-empty string');
    this.actionTypes.add(type);
    return this;
  }

  removeConstraint(id: string): boolean {
    return this.constraints.delete(id);
  }

  hasConstraint(id: string): boolean {
    return this.constraints.has(id);
  }

  isActionTypeRegistered(type: string): boolean {
    return this.actionTypes.has(type);
  }

  listConstraints(): readonly SafetyConstraint[] {
    return Array.from(this.constraints.values());
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Checking
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Evaluate an action. Fail-closed at every branch.
   */
  checkAction(action: SafetyAction): SafetyCheckResult {
    this.checks += 1;

    const violations: SafetyViolation[] = [];
    const evaluated: string[] = [];

    if (!action || typeof action.type !== 'string' || action.type.length === 0) {
      violations.push(
        this.violation('<malformed>', 'unknown_action_type', 'critical', 'Action is missing a type')
      );
      return this.finish(violations, evaluated);
    }

    // 1. Unregistered action types deny.
    if (!this.actionTypes.has(action.type)) {
      violations.push(
        this.violation(
          action.type,
          'unknown_action_type',
          'critical',
          `Action type "${action.type}" is not registered; fail-closed denial`
        )
      );
    }

    // 2. Declared prerequisites must exist.
    for (const id of action.requires ?? []) {
      if (!this.constraints.has(id)) {
        violations.push(
          this.violation(
            id,
            'unknown_constraint',
            'critical',
            `Action requires unregistered constraint "${id}"; cannot be evaluated`
          )
        );
      }
    }

    // 3. Metrics must be finite. A NaN metric is unevaluable, not neutral.
    for (const [name, value] of Object.entries(action.metrics ?? {})) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        violations.push(
          this.violation(
            `metric:${name}`,
            'unevaluable_metric',
            'high',
            `Metric "${name}" is not a finite number (${String(value)})`
          )
        );
      }
    }

    // 4. Applicable constraints must evaluate to exactly true.
    for (const constraint of this.constraints.values()) {
      if (!this.applies(constraint, action.type)) continue;
      evaluated.push(constraint.id);

      let outcome: unknown;
      try {
        outcome = constraint.evaluate(action);
      } catch (err) {
        violations.push(
          this.violation(
            constraint.id,
            'evaluation_error',
            constraint.severity,
            `Constraint threw: ${err instanceof Error ? err.message : String(err)}`
          )
        );
        continue;
      }

      if (typeof outcome !== 'boolean') {
        violations.push(
          this.violation(
            constraint.id,
            'non_boolean_result',
            constraint.severity,
            `Constraint returned ${typeof outcome}; only a literal true permits the action`
          )
        );
        continue;
      }

      if (!outcome) {
        violations.push(
          this.violation(constraint.id, 'constraint_failed', constraint.severity, constraint.description)
        );
      }
    }

    return this.finish(violations, evaluated);
  }

  /**
   * Convenience wrapper for runtime metric gating. Any non-finite metric denies.
   */
  checkMetrics(metrics: Readonly<Record<string, number>>): SafetyCheckResult {
    return this.checkAction({ type: METRIC_ACTION_TYPE, metrics });
  }

  private applies(constraint: SafetyConstraint, actionType: string): boolean {
    return constraint.appliesTo === 'all' || constraint.appliesTo.includes(actionType);
  }

  private finish(violations: SafetyViolation[], evaluated: string[]): SafetyCheckResult {
    let maxSeverity: SafetySeverity | null = null;
    for (const v of violations) {
      this.severityCounts[v.severity] += 1;
      this.history.push(v);
      if (maxSeverity === null || SEVERITY_ORDER[v.severity] > SEVERITY_ORDER[maxSeverity]) {
        maxSeverity = v.severity;
      }
    }
    while (this.history.length > this.maxHistory) this.history.shift();

    const allowed = violations.length === 0;
    if (!allowed) this.denials += 1;

    return { allowed, violations, evaluated, maxSeverity };
  }

  private violation(
    constraintId: string,
    reason: SafetyDenialReason,
    severity: SafetySeverity,
    detail: string
  ): SafetyViolation {
    return { constraintId, reason, severity, detail, at: Date.now() };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Introspection
  // ─────────────────────────────────────────────────────────────────────────

  getViolationHistory(): readonly SafetyViolation[] {
    return [...this.history];
  }

  clearHistory(): void {
    this.history.length = 0;
  }

  stats(): SafetyStats {
    return {
      constraintCount: this.constraints.size,
      registeredActionTypes: Array.from(this.actionTypes).sort(),
      checks: this.checks,
      denials: this.denials,
      denialRate: requireFinite(safeDivide(this.denials, this.checks, 0), 'denialRate'),
      violationsBySeverity: { ...this.severityCounts },
      historySize: this.history.length
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Constraint factories
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Bound a named metric to an inclusive range.
   * A missing or non-finite metric fails the constraint (fail-closed).
   */
  static boundsConstraint(
    id: string,
    metric: string,
    bounds: MetricBounds,
    severity: SafetySeverity = 'high',
    appliesTo: readonly string[] | 'all' = 'all'
  ): SafetyConstraint {
    const min = bounds.min ?? Number.NEGATIVE_INFINITY;
    const max = bounds.max ?? Number.POSITIVE_INFINITY;
    const range = `[${bounds.min ?? '-inf'}, ${bounds.max ?? '+inf'}]`;

    return {
      id,
      description: `Metric "${metric}" must be present, finite and within ${range}`,
      severity,
      appliesTo,
      evaluate: (action: SafetyAction): boolean => {
        const value = action.metrics?.[metric];
        if (typeof value !== 'number' || !Number.isFinite(value)) return false;
        return value >= min && value <= max;
      }
    };
  }

  /**
   * Require a predicate over the action payload. A throwing predicate is caught
   * by `checkAction` and denies.
   */
  static predicateConstraint(
    id: string,
    description: string,
    predicate: (action: SafetyAction) => boolean,
    severity: SafetySeverity = 'medium',
    appliesTo: readonly string[] | 'all' = 'all'
  ): SafetyConstraint {
    return { id, description, severity, appliesTo, evaluate: predicate };
  }

  /**
   * Default constraint set for the semantic observer: coherence and order
   * parameter must be real probabilities, entropy must be non-negative and
   * bounded, and field energy must stay finite and non-negative.
   */
  static defaultObserverConstraints(maxEntropyBits = 16, maxFieldEnergy = 1e9): SafetyConstraint[] {
    return [
      SafetyMonitor.boundsConstraint('coherence.range', 'coherence', { min: 0, max: 1 }, 'high', [
        METRIC_ACTION_TYPE
      ]),
      SafetyMonitor.boundsConstraint(
        'orderParameter.range',
        'orderParameter',
        { min: 0, max: 1 },
        'high',
        [METRIC_ACTION_TYPE]
      ),
      SafetyMonitor.boundsConstraint(
        'entropy.range',
        'entropy',
        { min: 0, max: clampRange(maxEntropyBits, 0, 1024) },
        'medium',
        [METRIC_ACTION_TYPE]
      ),
      SafetyMonitor.boundsConstraint(
        'fieldEnergy.range',
        'fieldEnergy',
        { min: 0, max: maxFieldEnergy },
        'high',
        [METRIC_ACTION_TYPE]
      )
    ];
  }

  /** A monitor preloaded with `defaultObserverConstraints`. */
  static forObserver(options: SafetyMonitorOptions = {}): SafetyMonitor {
    const monitor = new SafetyMonitor(options);
    for (const constraint of SafetyMonitor.defaultObserverConstraints()) {
      monitor.addConstraint(constraint);
    }
    return monitor;
  }
}
