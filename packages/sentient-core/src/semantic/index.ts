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
export {
  PrimeOscillatorField,
  phaseClusterMetrics,
  PHASE_CLUSTER_DEFAULTS
} from './PrimeOscillatorField';
export type {
  PrimeOscillatorFieldOptions,
  CompetitionConfig,
  OscillatorFieldTick,
  OscillatorFieldState,
  PrimeOscillatorSnapshot,
  PhaseClusterMetrics,
  PhaseClusterOptions
} from './PrimeOscillatorField';

// Sedenion memory field
export {
  SedenionMemoryField,
  UnknownSMFAxisError,
  SMF_DIMENSION,
  MAX_SMF_WIDTH
} from './SedenionMemoryField';
export type {
  SMFAxisRef,
  DominantAxis,
  SMFSnapshot,
  PrimeActivitySample,
  PrimeActivityOptions,
  SedenionMemoryFieldOptions
} from './SedenionMemoryField';

// Signed random projection (the SMF imprint's JL sketch)
export { SignedRandomProjection, mulberry32 } from './SketchProjection';
export type { SignedRandomProjectionOptions } from './SketchProjection';

// Relational VSA/HRR binding (role–filler traces for graded inference)
export { RelationalHologram, fnv1a } from './RelationalHologram';
export type { RelationalHologramOptions, RoleFillerPair, HologramCandidate } from './RelationalHologram';

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
export { SemanticMemoryBank, type SerializedTrace } from './SemanticMemoryBank';
export {
  CompactMemoryBank,
  type CompactMemoryBankOptions,
  type CompactTrace,
  type TraceLike,
  type MemoryBank,
  type RecallResultLike,
  type SerializedTraceData
} from './CompactMemoryBank';
export {
  ShardedMemoryBank,
  type ShardedMemoryBankOptions,
  retrievalInterferenceEntropy,
  jaccardPrimeSimilarity,
  partitionByPrimeJaccard
} from './ShardedMemoryBank';
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
export { SemanticObserver, safetyScore, CLUSTER_MOMENT_DEFAULTS } from './SemanticObserver';
export type { Stimulus, StimulusContext, StimulusResult, AttentionFocus, LearningEventType } from './stimulus';
export {
  SignalStream,
  type ObserverSignal,
  type ObserverSignalKind,
  type MetricSignalPayload,
  type InsightSignalPayload,
  type DriftSignalPayload,
  type MemorySignalPayload
} from './ObserverSignals';
export type {
  SemanticObserverOptions,
  SemanticMoment,
  SemanticObserverState,
  SemanticObserverTickEvent,
  SemanticInput,
  MomentCriterion,
  ClusterMomentCriterionOptions
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
