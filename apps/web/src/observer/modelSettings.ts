/**
 * MODEL SETTINGS — the knobs that are safe to turn at runtime.
 *
 * A hard line runs through the observer's configuration. The prime basis
 * (primeCount, gridSize, the vocabulary table) is NOT tunable: a bootstrap
 * record is trained and restored against exactly those numbers, and changing
 * one would decode every stored trace against a mismatched basis with no
 * error and no warning. Those live in observer/options.ts and stay there.
 *
 * Everything here is different: each value is read at the point of use, so
 * changing it affects what happens next and never invalidates what is
 * already stored.
 */

const STORAGE_KEY = 'sentinel.model.settings.v1';

export interface ModelSettings {
  /**
   * Multiplier on every forgetting half-life. 1 is the measured default
   * (7 days unreinforced, 30 practised, 120 consolidated); 2 forgets half
   * as fast; 0.5 twice as fast.
   */
  forgettingRate: number;
  /** Strength below which a word is scheduled for review. */
  reviewThreshold: number;
  /** New words introduced per learning cycle. */
  wordsPerCycle: number;
  /** Spaced-repetition reviews per learning cycle. */
  reviewsPerCycle: number;
  /** Pause between learning cycles, in milliseconds. */
  cyclePauseMs: number;
}

export const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  forgettingRate: 1,
  reviewThreshold: 0.6,
  wordsPerCycle: 3,
  reviewsPerCycle: 2,
  cyclePauseMs: 400
};

export interface SettingBound {
  min: number;
  max: number;
  step: number;
}

/** Ranges the UI offers and the loader enforces. */
export const MODEL_SETTING_BOUNDS: Record<keyof ModelSettings, SettingBound> = {
  forgettingRate: { min: 0.25, max: 4, step: 0.25 },
  reviewThreshold: { min: 0.3, max: 0.9, step: 0.05 },
  wordsPerCycle: { min: 0, max: 20, step: 1 },
  reviewsPerCycle: { min: 0, max: 20, step: 1 },
  cyclePauseMs: { min: 0, max: 5000, step: 100 }
};

function clamp(value: unknown, bound: SettingBound, fallback: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(bound.max, Math.max(bound.min, numeric));
}

/** Coerce anything into a usable settings object — corrupt values degrade to defaults. */
export function normalizeModelSettings(raw: unknown): ModelSettings {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Record<keyof ModelSettings, unknown>>;
  const settings = { ...DEFAULT_MODEL_SETTINGS };
  for (const key of Object.keys(DEFAULT_MODEL_SETTINGS) as Array<keyof ModelSettings>) {
    settings[key] = clamp(source[key], MODEL_SETTING_BOUNDS[key], DEFAULT_MODEL_SETTINGS[key]);
  }
  // Integer-valued knobs must stay integral.
  settings.wordsPerCycle = Math.round(settings.wordsPerCycle);
  settings.reviewsPerCycle = Math.round(settings.reviewsPerCycle);
  settings.cyclePauseMs = Math.round(settings.cyclePauseMs);
  return settings;
}

export function loadModelSettings(): ModelSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return normalizeModelSettings(raw === null ? {} : JSON.parse(raw));
  } catch {
    return { ...DEFAULT_MODEL_SETTINGS };
  }
}

export function saveModelSettings(settings: ModelSettings): ModelSettings {
  const normalized = normalizeModelSettings(settings);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // A full quota must not break the app.
  }
  return normalized;
}

/** The half-lives, in days, that a given forgetting rate produces. */
export function halfLivesFor(forgettingRate: number): { fresh: number; practised: number; consolidated: number } {
  const rate = Math.max(0.01, forgettingRate);
  return { fresh: 7 * rate, practised: 30 * rate, consolidated: 120 * rate };
}
