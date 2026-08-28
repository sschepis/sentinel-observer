/**
 * Semantic Engine
 *
 * TypeScript port of the legacy JS semantic stack (lib/prsc.js, lib/smf.js,
 * lib/hqe.js, lib/temporal.js, lib/entanglement.js, lib/sentient-core.js,
 * lib/sentient-memory.js, lib/safety.js).
 *
 * The legacy implementation was broken in ways that made its output
 * meaningless (and sometimes dangerous); this port re-implements the ideas
 * correctly. The headline fixes, cross-referenced by the review:
 *
 *   - ESM loading: `@aleph-ai/tinyaleph` is ESM-only. The legacy code
 *     `require()`d it (crash) AND destroyed its own lazy loading by
 *     destructuring getters at require time, so the real library never ran and
 *     every metric was a hardcoded stub value. `tinyaleph.ts` provides an
 *     async, memoized, surface-validating loader with an explicit degraded
 *     mode - no silent substitutions, ever.
 *
 *   - Inverted damping sign in `lib/hqe.js` evolve(): high-energy cells were
 *     damped LESS, so the field grew without bound. `HolographicMemory.evolve`
 *     uses the correct sign and ASSERTS the non-increasing-energy invariant.
 *
 *   - Fake "inverse DFT": `lib/hqe.js` reconstruct() applied an orthogonal
 *     kernel to golden-ratio/log-prime frequencies that are not an orthogonal
 *     basis, so it never round-tripped. `HolographicMemory` uses integer
 *     wavenumbers (k = 2π·n/N multiples), making encode→reconstruct exact.
 *
 *   - Phase-blind similarity: `lib/hqe.js` correlated |H|², so a pattern and
 *     its phase-inverse scored 1.0. `HolographicMemory.similarity` is the
 *     signed real part of the complex correlation.
 *
 *   - Dead entropy lock: `lib/sentient-memory.js` hardwired trace entropy to
 *     1.0 against a 0.8 threshold, so `locked` was permanently empty.
 *     `SemanticMemoryBank` implements a working consolidation rule over real
 *     normalized SMF entropy, and a prune pass that no longer double-counts
 *     weak removals.
 *
 *   - Fail-open safety: `lib/safety.js` returned `safe: true` unconditionally.
 *     `SafetyMonitor` is fail-closed: unknown action types, unknown
 *     constraints, non-finite metrics and evaluation errors all deny.
 *
 *   - EventEmitter crash: `lib/sentient-core.js` emitted 'error' with no
 *     listener from inside a catch block. `SemanticObserver` publishes on
 *     typed Subjects (`src/common/patterns/Observable.ts`), which is safe
 *     without subscribers.
 */

// Loading & wrappers around @aleph-ai/tinyaleph
export {
  SemanticKernel,
  TinyalephLoadError,
  TinyalephNotReadyError,
  loadTinyaleph,
  getTinyaleph,
  isTinyalephLoaded,
  describeTinyalephStatus,
  resetTinyalephLoader,
  getSharedKernel,
  initializeSemanticKernel,
  resetSharedKernel
} from './tinyaleph';
export type {
  TinyalephModule,
  TinyalephStatus,
  TinyalephLoaderFns,
  TAHypercomplex,
  TAOscillator,
  TAOscillatorBank,
  TAKuramotoModel,
  TASemanticBackend,
  TAAlephEngine,
  TAMultiplyIndex,
  TAStabilityClass,
  TABornOutcome
} from './tinyaleph';

// Prime oscillator field
export { PrimeOscillatorField } from './PrimeOscillatorField';
export type {
  PrimeOscillatorFieldOptions,
  OscillatorFieldTick,
  OscillatorFieldState,
  PrimeOscillatorSnapshot
} from './PrimeOscillatorField';

// Sedenion memory field
export {
  SedenionMemoryField,
  UnknownSMFAxisError,
  SMF_DIMENSION
} from './SedenionMemoryField';
export type {
  SMFAxisRef,
  DominantAxis,
  SMFSnapshot,
  PrimeActivitySample,
  PrimeActivityOptions
} from './SedenionMemoryField';

// Holographic memory
export { HolographicMemory } from './HolographicMemory';
export type {
  ComplexAmplitude,
  HoloCorrelation,
  HoloEvolution,
  HolographicMemoryOptions,
  HolographicSnapshot
} from './HolographicMemory';

// Semantic memory bank
export { SemanticMemoryBank } from './SemanticMemoryBank';
export type {
  MemoryTrace,
  StoreOptions,
  RecallQuery,
  RecallResult,
  MemoryBankStats,
  SemanticMemoryBankOptions
} from './SemanticMemoryBank';

// Safety
export { SafetyMonitor, METRIC_ACTION_TYPE } from './SafetyMonitor';
export type {
  SafetySeverity,
  SafetyDenialReason,
  SafetyAction,
  SafetyViolation,
  SafetyCheckResult,
  SafetyConstraint,
  MetricBounds,
  SafetyStats,
  SafetyMonitorOptions
} from './SafetyMonitor';

// Observer
export { SemanticObserver, safetyScore } from './SemanticObserver';
export type {
  SemanticObserverOptions,
  SemanticMoment,
  SemanticObserverState,
  SemanticObserverTickEvent,
  SemanticInput
} from './SemanticObserver';

// Numeric guards
export {
  NonFiniteValueError,
  requireFinite,
  requireAllFinite,
  safeDivide,
  clampRange,
  shannonEntropyBits,
  toDistribution,
  normalizedEntropy,
  stableCosineSimilarity
} from './numeric';

// Configuration & lifecycle errors
export {
  ConfigurationLimitError,
  NotInitializedError,
  SemanticObserverConfigError,
  MAX_GRID_SIZE,
  MAX_PRIME_COUNT
} from './errors';
