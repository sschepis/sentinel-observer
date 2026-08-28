/**
 * Tinyaleph Loader
 *
 * `@aleph-ai/tinyaleph` is an ESM-only package (`"type": "module"`). The legacy
 * `lib/*.js` shims got this wrong twice over:
 *
 *   1. Some modules (`lib/sentient-core.js`, `lib/sentient-memory.js`) did a
 *      synchronous `require('@aleph-ai/tinyaleph')`, which throws
 *      `ERR_REQUIRE_ESM` on Node < 20.19.
 *   2. The modules that *did* start an `import()` (`lib/prsc.js`, `lib/smf.js`,
 *      `lib/safety.js`, `lib/temporal.js`) exposed the library through
 *      `module.exports` getters, and every consumer destructured those getters
 *      at require time - i.e. before the promise resolved. The real library was
 *      therefore never observed and the whole engine ran on stub classes that
 *      returned hardcoded `0.5` / `1.0` / `NaN`.
 *
 * This module fixes both problems:
 *
 *   - Loading is explicitly asynchronous and memoized (`loadTinyaleph()`).
 *   - The runtime surface is validated after load; a missing or wrongly-typed
 *     export is a hard, typed failure (`TinyalephLoadError`).
 *   - There are NO stubs and NO fallback values. If the library cannot be
 *     loaded the loader records a degraded state (`isDegraded`) and every
 *     accessor throws. A fabricated metric is strictly worse than an exception.
 *
 * The declared types below mirror the *verified runtime* API, not the shipped
 * `types/index.d.ts`, which is out of date in several places (e.g. `Oscillator`
 * takes positional args and exposes `freq`, not an options object with
 * `frequency`; `orderParameter` lives on `KuramotoModel`, not `OscillatorBank`).
 */

import type { Initializable } from '../common/types';

// ═══════════════════════════════════════════════════════════════════════════
// RUNTIME SURFACE TYPES
// ═══════════════════════════════════════════════════════════════════════════

/** [index, sign] tuple returned by the Fano-plane multiplication tables. */
export type TAMultiplyIndex = [index: number, sign: number];

/** Stability classes produced by `classifyStability` (lowercase since 1.8.0). */
export type TAStabilityClass = 'stable' | 'marginal' | 'chaotic';

/** Dominant-axis descriptor returned by `Hypercomplex.dominantAxes`. */
export interface TADominantAxis {
  i: number;
  v: number;
}

/**
 * Hypercomplex (quaternion / octonion / sedenion) state.
 * Runtime note: components live in the `c` Float64Array and the dimension is
 * exposed as `dim`.
 */
export interface TAHypercomplex {
  readonly dim: number;
  readonly c: Float64Array;
  readonly components: number[];
  add(other: TAHypercomplex): TAHypercomplex;
  sub(other: TAHypercomplex): TAHypercomplex;
  mul(other: TAHypercomplex): TAHypercomplex;
  scale(scalar: number): TAHypercomplex;
  dot(other: TAHypercomplex): number;
  norm(): number;
  normalize(): TAHypercomplex;
  conjugate(): TAHypercomplex;
  entropy(): number;
  coherence(other: TAHypercomplex): number;
  dominantAxes(n?: number): TADominantAxis[];
  toArray(): number[];
  clone(): TAHypercomplex;
}

/** Static factory surface of the `Hypercomplex` class. */
export interface TAHypercomplexStatics {
  zero(dim: number): TAHypercomplex;
  basis(dim: number, index: number, value?: number): TAHypercomplex;
  fromArray(arr: readonly number[]): TAHypercomplex;
}

export type TAHypercomplexCtor = (new (dim?: number) => TAHypercomplex) & TAHypercomplexStatics;

/** A single phase oscillator. Constructor is positional: (freq, phase, amplitude). */
export interface TAOscillator {
  freq: number;
  phase: number;
  amplitude: number;
  baseAmplitude: number;
  tick(dt: number, coupling?: number): void;
  excite(amount?: number): void;
  decay(rate?: number, dt?: number): void;
  reset(): void;
}

export type TAOscillatorCtor = new (frequency: number, phase?: number, amplitude?: number) => TAOscillator;

/** Bank of independent oscillators. */
export interface TAOscillatorBank {
  readonly oscillators: TAOscillator[];
  readonly primeList: number[];
  tick(dt: number, couplingFn?: (osc: TAOscillator, all: TAOscillator[]) => number): void;
  exciteByIndices(indices: readonly number[], amount?: number): void;
  decayAll(rate?: number, dt?: number): void;
  getPhases(): number[];
  getAmplitudes(): number[];
  reset(): void;
}

export type TAOscillatorBankCtor = new (
  sizeOrFrequencies: number | readonly number[],
  defaultPrimes?: readonly number[] | null
) => TAOscillatorBank;

/**
 * Kuramoto-coupled oscillator bank.
 *
 * `orderParameter()` is the real amplitude-weighted Kuramoto order parameter
 * `|Σ aⱼ e^{iφⱼ}| / N`. It is 0 for a fully quiescent bank, so the legacy
 * hardcoded `0.5` was never a real reading.
 */
export interface TAKuramotoModel extends TAOscillatorBank {
  K: number;
  tick(dt: number): void;
  step(dt: number): void;
  orderParameter(): number;
  meanPhase(): number;
  synchronization(): number;
  pairwiseCoherence(): number;
  exciteByPrimes(primes: readonly number[], primeList: readonly number[], amount?: number): void;
  getWeightedAmplitudes(): number[];
}

export type TAKuramotoModelCtor = new (
  frequencies: readonly number[],
  coupling?: number
) => TAKuramotoModel;

/** Token produced by `SemanticBackend.tokenize`. */
export interface TAToken {
  word: string;
  primes: number[];
  known: boolean;
  isStop: boolean;
  position: number;
}

/** Backend configuration. An empty object is valid and uses built-in defaults. */
export interface TABackendConfig {
  dimension?: number;
  vocabulary?: Record<string, number[]>;
  ontology?: Record<number, string>;
  stopWords?: readonly string[];
}

/** Text -> primes semantic backend. */
export interface TASemanticBackend {
  tokenize(text: string, filterStopWords?: boolean): TAToken[];
  encode(text: string): number[];
  decode(primes: readonly number[]): string;
  primesToState(primes: readonly number[]): TAHypercomplex;
  hasWord(word: string): boolean;
  getVocabularySize(): number;
}

export type TASemanticBackendCtor = new (config: TABackendConfig) => TASemanticBackend;

/** Result of a full `AlephEngine.run` (the real runtime shape). */
export interface TAEngineResult {
  input?: string;
  inputPrimes?: number[];
  resultPrimes?: number[];
  output?: string;
  entropy?: number;
  coherence?: number;
  lyapunov?: number;
  stability?: TAStabilityClass;
  collapsed?: boolean;
  steps?: number;
  evolutionSteps?: number;
  framesCollected?: number;
  bestFrameOrder?: number;
  bestDifferential?: number;
  fieldBased?: boolean;
  orderParameter?: number;
}

/** Reasoning engine over a backend (real runtime surface). */
export interface TAAlephEngine {
  run(input: string): TAEngineResult;
  runBatch(inputs: string[]): TAEngineResult[];
  tick(): TAEngineResult;
  excite(primes: number[], amplitude?: number): void;
  reason(): TAEngineResult;
  checkCollapse(): boolean;
  getPhysicsState(): Record<string, unknown>;
  setBackend(type: TAEngineBackendType, config?: TABackendConfig): void;
  getBackendInfo(): Record<string, unknown>;
  measure(): TABornOutcome;
  reset(): void;
  getHistory(limit?: number): TAEngineResult[];
  evolve(steps?: number): TAEngineResult;
}

export type TAEngineBackendType =
  | 'semantic'
  | 'cryptographic'
  | 'crypto'
  | 'scientific'
  | 'science'
  | 'quantum'
  | 'bioinformatics'
  | 'bio'
  | 'dna'
  | 'protein';

/** Born-rule measurement outcome. */
export interface TABornOutcome {
  index: number;
  probability: number;
}

/**
 * The subset of the tinyaleph module surface this package binds to.
 * Every member is validated at load time.
 */
export interface TinyalephModule {
  // Core algebra
  readonly Hypercomplex: TAHypercomplexCtor;
  readonly sedenionMultiplyIndex: (i: number, j: number) => TAMultiplyIndex;

  // Physics: oscillators
  readonly Oscillator: TAOscillatorCtor;
  readonly OscillatorBank: TAOscillatorBankCtor;
  readonly KuramotoModel: TAKuramotoModelCtor;

  // Physics: entropy
  readonly shannonEntropy: (probabilities: readonly number[]) => number;
  readonly stateEntropy: (state: TAHypercomplex) => number;
  readonly coherence: (a: TAHypercomplex, b: TAHypercomplex) => number;
  readonly oscillatorEntropy: (bank: { getAmplitudes(): number[] }) => number;

  // Physics: stability
  readonly estimateLyapunov: (series: readonly number[], windowSize?: number) => number;
  readonly classifyStability: (lambda: number) => TAStabilityClass;

  // Physics: collapse
  readonly collapseProbability: (state: unknown, threshold?: number) => number;
  readonly shouldCollapse: (state: unknown, threshold?: number) => boolean;
  readonly measureState: (state: TAHypercomplex, basis?: TAHypercomplex | null) => unknown;
  readonly bornMeasurement: (state: TAHypercomplex) => TABornOutcome;

  // Primes
  readonly firstNPrimes: (n: number) => number[];
  readonly nthPrime: (n: number) => number;
  readonly primesUpTo: (max: number) => number[];
  readonly isPrime: (n: number) => boolean;
  /**
   * Runtime note: the shipped types claim `number[]`, but the actual
   * implementation returns a prime -> exponent record (verified at runtime).
   */
  readonly factorize: (n: number) => Record<number, number>;
  readonly primeToFrequency: (p: number, base?: number, logScale?: number) => number;
  readonly primeToAngle: (p: number) => number;
  readonly DEFAULT_PRIMES: readonly number[];

  // Backends / engine
  readonly SemanticBackend: TASemanticBackendCtor;
  readonly AlephEngine: unknown;
  readonly createEngine: (backendType: TAEngineBackendType, config?: TABackendConfig) => TAAlephEngine;
}

// ═══════════════════════════════════════════════════════════════════════════
// ERRORS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Raised when `@aleph-ai/tinyaleph` cannot be loaded or does not expose the
 * expected runtime surface. Never swallowed, never replaced by a stub.
 */
export class TinyalephLoadError extends Error {
  readonly attempts: readonly string[];
  override readonly cause?: unknown;

  constructor(message: string, attempts: readonly string[] = [], cause?: unknown) {
    super(message);
    this.name = 'TinyalephLoadError';
    this.attempts = attempts;
    this.cause = cause;
  }
}

/**
 * Raised when a caller touches the tinyaleph-backed surface before
 * `initialize()` has resolved, or after a load failure.
 */
export class TinyalephNotReadyError extends Error {
  constructor(detail: string) {
    super(`Tinyaleph kernel is not ready: ${detail}`);
    this.name = 'TinyalephNotReadyError';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SURFACE VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

const REQUIRED_FUNCTIONS = [
  'sedenionMultiplyIndex',
  'shannonEntropy',
  'stateEntropy',
  'coherence',
  'oscillatorEntropy',
  'estimateLyapunov',
  'classifyStability',
  'collapseProbability',
  'shouldCollapse',
  'measureState',
  'bornMeasurement',
  'firstNPrimes',
  'nthPrime',
  'primesUpTo',
  'isPrime',
  'factorize',
  'primeToFrequency',
  'primeToAngle',
  'createEngine'
] as const;

const REQUIRED_CONSTRUCTORS = [
  'Hypercomplex',
  'Oscillator',
  'OscillatorBank',
  'KuramotoModel',
  'SemanticBackend',
  'AlephEngine'
] as const;

/**
 * Verify that a freshly-imported namespace really is tinyaleph.
 *
 * Validation is two-tier:
 *   1. Every required export must exist with the right typeof.
 *   2. A few cheap behavioral probes must actually work: `firstNPrimes(5)`
 *      must return 5 primes, `new Hypercomplex(16)` must construct, and
 *      `shannonEntropy` of a uniform 4-way distribution must be 2 bits.
 *
 * A partially-shaped OR stub-shaped module is treated as a load failure
 * rather than being papered over at call time.
 */
function assertModuleSurface(candidate: Record<string, unknown>): TinyalephModule {
  const missing: string[] = [];

  for (const name of REQUIRED_FUNCTIONS) {
    if (typeof candidate[name] !== 'function') missing.push(`${name} (function)`);
  }
  for (const name of REQUIRED_CONSTRUCTORS) {
    if (typeof candidate[name] !== 'function') missing.push(`${name} (class)`);
  }
  if (!Array.isArray(candidate.DEFAULT_PRIMES) || candidate.DEFAULT_PRIMES.length === 0) {
    missing.push('DEFAULT_PRIMES (non-empty array)');
  }

  if (missing.length > 0) {
    throw new TinyalephLoadError(
      `@aleph-ai/tinyaleph loaded but is missing expected exports: ${missing.join(', ')}`
    );
  }

  // typeof-only checks accept a surface that is complete but stubbed. Probe
  // the actual behavior so a stub library is rejected, not silently accepted.
  const probeProblems = runSurfaceProbes(candidate);
  if (probeProblems.length > 0) {
    throw new TinyalephLoadError(
      `@aleph-ai/tinyaleph loaded but failed behavioral surface probes: ${probeProblems.join('; ')}`
    );
  }

  return candidate as unknown as TinyalephModule;
}

/**
 * Cheap behavioral probes run against a candidate module surface. Each probe
 * reports a problem string (or null when it passes) and never throws: probe
 * exceptions are converted to problem strings by the caller.
 */
function runSurfaceProbes(candidate: Record<string, unknown>): string[] {
  const problems: string[] = [];

  try {
    const primes = (candidate.firstNPrimes as (n: number) => number[])(5);
    if (!Array.isArray(primes) || primes.length !== 5 || !primes.every(p => Number.isFinite(p))) {
      problems.push(`firstNPrimes(5) returned ${JSON.stringify(primes)} (expected an array of 5 primes)`);
    }
  } catch (err) {
    problems.push(`firstNPrimes(5) threw: ${describeError(err)}`);
  }

  try {
    const Hypercomplex = candidate.Hypercomplex as new (dim?: number) => unknown;
    const state = new Hypercomplex(16);
    if (!state || typeof state !== 'object') {
      problems.push('new Hypercomplex(16) returned a non-object');
    }
  } catch (err) {
    problems.push(`new Hypercomplex(16) threw: ${describeError(err)}`);
  }

  try {
    const entropy = (candidate.shannonEntropy as (probabilities: readonly number[]) => number)([
      0.25, 0.25, 0.25, 0.25
    ]);
    if (!Number.isFinite(entropy) || Math.abs(entropy - 2) > 1e-6) {
      problems.push(`shannonEntropy([0.25, 0.25, 0.25, 0.25]) returned ${String(entropy)} (expected 2 bits)`);
    }
  } catch (err) {
    problems.push(`shannonEntropy([0.25, 0.25, 0.25, 0.25]) threw: ${describeError(err)}`);
  }

  return problems;
}

// ═══════════════════════════════════════════════════════════════════════════
// MODULE LOADING
// ═══════════════════════════════════════════════════════════════════════════

const PACKAGE_SPECIFIER = '@aleph-ai/tinyaleph';

/**
 * A bundler-visible dynamic import.
 *
 * The specifier below is deliberately a LITERAL so that bundlers (Vite,
 * Rollup, webpack) can see and rewrite it. This is what makes the kernel load
 * in browsers: `new Function('return import(s)')` is opaque to bundlers and
 * the browser's native import resolver cannot handle a bare package
 * specifier.
 *
 * In the CommonJS build TypeScript downlevels this to `require()`, which
 * rejects for the ESM-only package — that failure is recorded as a strategy
 * attempt and the next strategy takes over. In the ESM build (browsers) it
 * survives as a genuine dynamic import.
 */
async function staticDynamicImport(specifier: string): Promise<Record<string, unknown>> {
  if (specifier === PACKAGE_SPECIFIER) {
    return import('@aleph-ai/tinyaleph') as Promise<Record<string, unknown>>;
  }
  return nativeDynamicImport(specifier);
}

/**
 * A genuine dynamic `import()`.
 *
 * Built with `new Function` on purpose: this file is compiled to CommonJS
 * (`tsconfig.json` -> `"module": "commonjs"`), and TypeScript would otherwise
 * downlevel `await import(...)` into `Promise.resolve().then(() => require(...))`,
 * reintroducing the exact `ERR_REQUIRE_ESM` crash we are fixing.
 */
const nativeDynamicImport = new Function(
  'specifier',
  'return import(specifier);'
) as (specifier: string) => Promise<Record<string, unknown>>;

// `node:vm` is NOT imported at module top level: a host without Node's vm
// module must still be able to load this file. The require happens lazily,
// guarded, inside the vm fallback strategy only (see `loadVmModule`).
type NodeVmModule = typeof import('node:vm');
let vmModule: NodeVmModule | null | undefined;

function loadVmModule(): NodeVmModule | null {
  if (vmModule !== undefined) return vmModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    vmModule = require('node:vm') as NodeVmModule;
  } catch {
    vmModule = null;
  }
  return vmModule;
}

/**
 * Import through Node's main-context ESM loader.
 *
 * Some CommonJS hosts (notably Jest's `vm`-based runtime without
 * `--experimental-vm-modules`) intercept dynamic `import()` and cannot evaluate
 * ESM. `vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER` delegates to the real
 * host loader, so the *actual* library is loaded rather than a stub.
 *
 * On hosts where `node:vm` (or the constant) is unavailable the loader throws;
 * the caller records that failure and moves on.
 */
async function importViaMainContextLoader(specifier: string): Promise<Record<string, unknown>> {
  const vm = loadVmModule();
  if (!vm) {
    throw new Error('node:vm is unavailable in this host; the vm fallback loader cannot run');
  }
  if (vm.constants?.USE_MAIN_CONTEXT_DEFAULT_LOADER === undefined) {
    throw new Error('node:vm constants.USE_MAIN_CONTEXT_DEFAULT_LOADER is unavailable in this host');
  }
  const script = new vm.Script(`import(${JSON.stringify(specifier)})`, {
    importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER
  });
  const namespace = (await script.runInThisContext()) as Record<string, unknown>;
  return namespace;
}

/**
 * Injectable loader functions (test seam / alternative hosts).
 *
 * Production callers pass nothing and get the two built-in strategies. Tests
 * inject fakes to exercise surface-mismatch, vm-unavailable and race paths.
 * All fields are additive; the default behavior is unchanged.
 */
export interface TinyalephLoaderFns {
  /** Override for the dynamic import() strategy. */
  dynamicImport?: (specifier: string) => Promise<Record<string, unknown>>;
  /** Override for the vm main-context ESM loader strategy. */
  vmImport?: (specifier: string) => Promise<Record<string, unknown>>;
  /** Override for the package specifier (tests / vendored copies). */
  specifier?: string;
}

interface LoaderStrategy {
  name: string;
  run: () => Promise<Record<string, unknown>>;
}

interface LoaderState {
  promise: Promise<TinyalephModule> | null;
  module: TinyalephModule | null;
  error: TinyalephLoadError | null;
  /**
   * Monotonic generation counter. Incremented whenever a load starts or the
   * loader is reset, so an in-flight load from an older generation can never
   * commit its success or clear a newer load's promise (see loadTinyaleph).
   */
  generation: number;
}

const state: LoaderState = { promise: null, module: null, error: null, generation: 0 };

/**
 * Run every loading strategy in order. A failure in ANY strategy - including
 * a module that loads but fails surface validation - is recorded in
 * `attempts` and the NEXT strategy is tried. `TinyalephLoadError` is thrown
 * only after every strategy has failed.
 */
async function performLoad(generation: number, loaderFns: TinyalephLoaderFns): Promise<TinyalephModule> {
  const attempts: string[] = [];
  let firstCause: unknown;

  const specifier = loaderFns.specifier ?? PACKAGE_SPECIFIER;
  const strategies: LoaderStrategy[] = [
    {
      name: 'dynamic import()',
      run: () => (loaderFns.dynamicImport ?? staticDynamicImport)(specifier)
    },
    {
      name: 'native import via new Function',
      run: () => nativeDynamicImport(specifier)
    },
    {
      name: 'vm main-context ESM loader',
      run: () => (loaderFns.vmImport ?? importViaMainContextLoader)(specifier)
    }
  ];

  for (const strategy of strategies) {
    try {
      const namespace = await strategy.run();
      const resolved = assertModuleSurface(unwrapNamespace(namespace));
      if (generation === state.generation) {
        state.module = resolved;
        state.error = null;
      }
      return resolved;
    } catch (err) {
      const detail =
        err instanceof TinyalephLoadError ? err.message : describeError(err);
      attempts.push(`${strategy.name}: ${detail}`);
      if (firstCause === undefined) firstCause = err;
    }
  }

  const error = new TinyalephLoadError(
    `Unable to load ${specifier}. All import strategies failed.`,
    attempts,
    firstCause
  );
  if (generation === state.generation) state.error = error;
  throw error;
}

/**
 * Some hosts hand back `{ default: namespace }` for ESM interop. Prefer the
 * namespace that actually carries the exports.
 */
function unwrapNamespace(namespace: Record<string, unknown>): Record<string, unknown> {
  if (typeof namespace.firstNPrimes === 'function') return namespace;
  const inner = namespace.default;
  if (inner && typeof inner === 'object' && typeof (inner as Record<string, unknown>).firstNPrimes === 'function') {
    return inner as Record<string, unknown>;
  }
  return namespace;
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ? `${code} ${err.message.split('\n')[0]}` : err.message.split('\n')[0];
  }
  return String(err);
}

/**
 * Load (once) and return the real tinyaleph module.
 *
 * The module promise is memoized so concurrent callers share a single import.
 * A failed load is NOT cached as a success: the rejection is surfaced to every
 * awaiting caller and a retry is permitted via `resetTinyalephLoader()`.
 *
 * `loaderFns` is a test seam: injectable strategy overrides. Production
 * callers pass nothing.
 */
export function loadTinyaleph(loaderFns: TinyalephLoaderFns = {}): Promise<TinyalephModule> {
  if (state.module) return Promise.resolve(state.module);
  if (!state.promise) {
    const generation = ++state.generation;
    state.promise = performLoad(generation, loaderFns).catch((err: unknown) => {
      // Generation guard: a failure from a load that was reset away must not
      // clear a newer in-flight load's memoized promise.
      if (generation === state.generation) state.promise = null;
      throw err;
    });
  }
  return state.promise;
}

/** True once the real module has been loaded and validated. */
export function isTinyalephLoaded(): boolean {
  return state.module !== null;
}

/**
 * Synchronous access to the loaded module.
 * Throws instead of returning a stub when the module is not ready.
 */
export function getTinyaleph(): TinyalephModule {
  if (!state.module) {
    throw new TinyalephNotReadyError(
      state.error
        ? `previous load failed (${state.error.message})`
        : 'loadTinyaleph() has not completed yet'
    );
  }
  return state.module;
}

/** Loader status for diagnostics and health checks. */
export interface TinyalephStatus {
  loaded: boolean;
  degraded: boolean;
  specifier: string;
  error: string | null;
  attempts: readonly string[];
}

/** Describe the loader state without throwing. */
export function describeTinyalephStatus(): TinyalephStatus {
  return {
    loaded: state.module !== null,
    degraded: state.module === null && state.error !== null,
    specifier: PACKAGE_SPECIFIER,
    error: state.error ? state.error.message : null,
    attempts: state.error ? state.error.attempts : []
  };
}

/** Discard memoized loader state (test support / retry after failure). */
export function resetTinyalephLoader(): void {
  state.generation += 1;
  state.promise = null;
  state.module = null;
  state.error = null;
}

// ═══════════════════════════════════════════════════════════════════════════
// SEMANTIC KERNEL (typed wrappers)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Typed, async-initialized facade over the tinyaleph functions used by this
 * package.
 *
 * Contract:
 *   - `initialize()` must resolve before any other method is called.
 *   - Every method delegates to the real library. There is no stub path, so a
 *     value returned here is always a real computation.
 *   - `isDegraded` is true only after a failed `initialize()`; in that state
 *     every accessor throws `TinyalephNotReadyError`.
 */
export class SemanticKernel implements Initializable {
  private module: TinyalephModule | null = null;
  private failure: TinyalephLoadError | null = null;
  private primeRank: Map<number, number> | null = null;

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.module) return;
    try {
      this.module = await loadTinyaleph();
      this.failure = null;
    } catch (err) {
      this.failure =
        err instanceof TinyalephLoadError
          ? err
          : new TinyalephLoadError('Tinyaleph initialization failed', [], err);
      throw this.failure;
    }
  }

  isInitialized(): boolean {
    return this.module !== null;
  }

  /**
   * True when initialization was attempted and failed.
   * Explicitly labelled degraded mode: nothing works, nothing is faked.
   */
  get isDegraded(): boolean {
    return this.module === null && this.failure !== null;
  }

  /** Loader diagnostics for this kernel instance. */
  status(): TinyalephStatus {
    return {
      loaded: this.module !== null,
      degraded: this.isDegraded,
      specifier: PACKAGE_SPECIFIER,
      error: this.failure ? this.failure.message : null,
      attempts: this.failure ? this.failure.attempts : []
    };
  }

  private lib(): TinyalephModule {
    if (!this.module) {
      throw new TinyalephNotReadyError(
        this.failure ? `degraded after load failure (${this.failure.message})` : 'call initialize() first'
      );
    }
    return this.module;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Primes
  // ─────────────────────────────────────────────────────────────────────────

  firstNPrimes(n: number): number[] {
    return this.lib().firstNPrimes(n);
  }

  nthPrime(n: number): number {
    return this.lib().nthPrime(n);
  }

  primesUpTo(max: number): number[] {
    return this.lib().primesUpTo(max);
  }

  isPrime(n: number): boolean {
    return this.lib().isPrime(n);
  }

  factorize(n: number): Record<number, number> {
    return this.lib().factorize(n);
  }

  primeToFrequency(p: number): number {
    return this.lib().primeToFrequency(p);
  }

  primeToAngle(p: number): number {
    return this.lib().primeToAngle(p);
  }

  get defaultPrimes(): readonly number[] {
    return this.lib().DEFAULT_PRIMES;
  }

  /**
   * Zero-based rank of a prime (2 -> 0, 3 -> 1, ...), or -1 when `p` is not a
   * prime within the cached table. Used to fold arbitrary encoded primes into
   * a bounded oscillator index space deterministically.
   */
  primeRankOf(p: number): number {
    if (!this.primeRank) {
      const table = this.lib().primesUpTo(4096);
      this.primeRank = new Map(table.map((prime, index) => [prime, index]));
    }
    const rank = this.primeRank.get(p);
    return rank === undefined ? -1 : rank;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Information theory
  // ─────────────────────────────────────────────────────────────────────────

  shannonEntropy(probabilities: readonly number[]): number {
    return this.lib().shannonEntropy(probabilities);
  }

  stateEntropy(state: TAHypercomplex): number {
    return this.lib().stateEntropy(state);
  }

  hypercomplexCoherence(a: TAHypercomplex, b: TAHypercomplex): number {
    return this.lib().coherence(a, b);
  }

  oscillatorEntropy(bank: { getAmplitudes(): number[] }): number {
    return this.lib().oscillatorEntropy(bank);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Stability
  // ─────────────────────────────────────────────────────────────────────────

  estimateLyapunov(series: readonly number[], windowSize?: number): number {
    return this.lib().estimateLyapunov(series, windowSize);
  }

  classifyStability(lambda: number): TAStabilityClass {
    return this.lib().classifyStability(lambda);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Collapse / measurement
  // ─────────────────────────────────────────────────────────────────────────

  collapseProbability(state: unknown, threshold?: number): number {
    return this.lib().collapseProbability(state, threshold);
  }

  /**
   * Note: the library implementation of `shouldCollapse` consults
   * `Math.random()`. It is exposed for completeness but the observer uses a
   * deterministic threshold-crossing rule instead so that emitted moments are
   * reproducible.
   */
  shouldCollapse(state: unknown, threshold?: number): boolean {
    return this.lib().shouldCollapse(state, threshold);
  }

  measureState(state: TAHypercomplex, basis?: TAHypercomplex | null): unknown {
    return this.lib().measureState(state, basis ?? null);
  }

  bornMeasurement(state: TAHypercomplex): TABornOutcome {
    return this.lib().bornMeasurement(state);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Constructors
  // ─────────────────────────────────────────────────────────────────────────

  createKuramotoModel(frequencies: readonly number[], coupling: number): TAKuramotoModel {
    const { KuramotoModel } = this.lib();
    return new KuramotoModel(frequencies, coupling);
  }

  createOscillatorBank(frequencies: readonly number[]): TAOscillatorBank {
    const { OscillatorBank } = this.lib();
    return new OscillatorBank(frequencies);
  }

  createOscillator(frequency: number, phase = 0, amplitude = 0): TAOscillator {
    const { Oscillator } = this.lib();
    return new Oscillator(frequency, phase, amplitude);
  }

  createHypercomplex(dimension = 16): TAHypercomplex {
    const { Hypercomplex } = this.lib();
    return new Hypercomplex(dimension);
  }

  hypercomplexFromArray(values: readonly number[]): TAHypercomplex {
    return this.lib().Hypercomplex.fromArray(values);
  }

  createSemanticBackend(config: TABackendConfig = {}): TASemanticBackend {
    const { SemanticBackend } = this.lib();
    return new SemanticBackend(config);
  }

  createEngine(backendType: TAEngineBackendType, config: TABackendConfig = {}): TAAlephEngine {
    return this.lib().createEngine(backendType, config);
  }

  sedenionMultiplyIndex(i: number, j: number): TAMultiplyIndex {
    return this.lib().sedenionMultiplyIndex(i, j);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SHARED KERNEL
// ═══════════════════════════════════════════════════════════════════════════

let sharedKernel: SemanticKernel | null = null;

/**
 * Process-wide kernel instance. Not yet initialized; callers must await
 * `initializeSemanticKernel()` (or the owning component's `initialize()`).
 */
export function getSharedKernel(): SemanticKernel {
  if (!sharedKernel) sharedKernel = new SemanticKernel();
  return sharedKernel;
}

/** Convenience: get the shared kernel, initialized. */
export async function initializeSemanticKernel(): Promise<SemanticKernel> {
  const kernel = getSharedKernel();
  await kernel.initialize();
  return kernel;
}

/** Drop the shared kernel (test support). */
export function resetSharedKernel(): void {
  sharedKernel = null;
}
