/**
 * Semantic engine configuration & lifecycle errors.
 *
 * Every constructor-side misconfiguration and every pre-initialization
 * access surfaces as one of these typed errors instead of a silently
 * coerced value or a fabricated metric.
 */

/** Hard cap on holographic grid allocations (cells), enforced at construction. */
export const MAX_GRID_SIZE = 4096;

/** Hard cap on the prime basis size, enforced at construction. */
export const MAX_PRIME_COUNT = 256;

/**
 * Raised when a constructor argument exceeds a hard allocation cap.
 *
 * The caps exist because the allocation is proportional to
 * `gridSize * primeCount`; without them a hostile or corrupted config can
 * exhaust memory before any computation happens.
 */
export class ConfigurationLimitError extends Error {
  readonly parameter: string;
  readonly limit: number;
  readonly actual: number;

  constructor(parameter: string, limit: number, actual: number) {
    super(`Configuration limit exceeded: ${parameter} (${actual}) must not exceed ${limit}`);
    this.name = 'ConfigurationLimitError';
    this.parameter = parameter;
    this.limit = limit;
    this.actual = actual;
  }
}

/**
 * Raised when a readout is requested before the component's async
 * `initialize()` has completed. Pre-init zeros are fabricated metrics, not
 * readings, so they are refused instead of returned.
 */
export class NotInitializedError extends Error {
  readonly component: string;

  constructor(component: string) {
    super(`${component} is not initialized; initialize() must be awaited before use`);
    this.name = 'NotInitializedError';
    this.component = component;
  }
}

/**
 * Raised when SemanticObserver construction options are contradictory or
 * unsupported.
 */
export class SemanticObserverConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SemanticObserverConfigError';
  }
}
