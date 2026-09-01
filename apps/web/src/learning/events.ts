import type { ObserverSignal } from '@sschepis/sentient-core';
import type { AutonomousEvent } from '../teacher/autonomous';

/**
 * One integrated stream of everything the observer is doing while it learns.
 *
 * The training view renders this single list instead of a wall of panels:
 * words learned, reviews, definitions, the running dialogue with the LLM,
 * the questions the observer asks itself, grades, and its own memory
 * signals — all timestamped, all filterable.
 */
export type LearningEventKind =
  | 'word'
  | 'review'
  | 'definition'
  | 'phrase'
  | 'question'
  | 'llm'
  | 'observer'
  | 'grade'
  | 'drill'
  | 'drive'
  | 'memory'
  | 'system'
  | 'error';

export interface LearningEvent {
  id: number;
  at: number;
  kind: LearningEventKind;
  /** Gutter label — the speaker or the subject of the event. */
  label: string;
  text: string;
  /** Secondary line (grade feedback, definition body, …). */
  detail?: string | null;
  /** 0..1 when the event carries a grade. */
  score?: number | null;
}

export interface EventKindStyle {
  label: string;
  /** Tailwind text colour for the gutter label and dot. */
  tone: string;
  dot: string;
}

export const EVENT_STYLES: Record<LearningEventKind, EventKindStyle> = {
  word: { label: 'word', tone: 'text-emerald-300', dot: 'bg-emerald-400' },
  review: { label: 'review', tone: 'text-teal-300', dot: 'bg-teal-400' },
  definition: { label: 'definition', tone: 'text-lime-300', dot: 'bg-lime-400' },
  phrase: { label: 'phrase', tone: 'text-cyan-300', dot: 'bg-cyan-400' },
  question: { label: 'asks', tone: 'text-fuchsia-300', dot: 'bg-fuchsia-400' },
  llm: { label: 'teacher', tone: 'text-sky-300', dot: 'bg-sky-400' },
  observer: { label: 'observer', tone: 'text-emerald-200', dot: 'bg-emerald-300' },
  grade: { label: 'grade', tone: 'text-amber-300', dot: 'bg-amber-400' },
  drill: { label: 'drill', tone: 'text-orange-300', dot: 'bg-orange-400' },
  drive: { label: 'drives', tone: 'text-violet-300', dot: 'bg-violet-400' },
  memory: { label: 'memory', tone: 'text-indigo-300', dot: 'bg-indigo-400' },
  system: { label: 'system', tone: 'text-slate-400', dot: 'bg-slate-500' },
  error: { label: 'error', tone: 'text-rose-300', dot: 'bg-rose-500' }
};

export interface EventFilter {
  key: string;
  label: string;
  kinds: readonly LearningEventKind[];
}

/** Filter chips: each maps to the event kinds it admits. */
export const EVENT_FILTERS: readonly EventFilter[] = [
  {
    key: 'all',
    label: 'Everything',
    kinds: [
      'word',
      'review',
      'definition',
      'phrase',
      'question',
      'llm',
      'observer',
      'grade',
      'drill',
      'drive',
      'memory',
      'system',
      'error'
    ]
  },
  { key: 'vocabulary', label: 'Words', kinds: ['word', 'review', 'definition'] },
  { key: 'drills', label: 'Drills', kinds: ['drill'] },
  { key: 'dialogue', label: 'Dialogue', kinds: ['llm', 'observer', 'phrase'] },
  { key: 'questions', label: 'Questions', kinds: ['question'] },
  { key: 'grades', label: 'Grades', kinds: ['grade'] },
  { key: 'signals', label: 'Inner state', kinds: ['drive', 'memory'] },
  { key: 'problems', label: 'Problems', kinds: ['error'] }
];

let nextEventId = 1;

/** Stamp an event with a monotonic id and a timestamp. */
export function makeEvent(event: Omit<LearningEvent, 'id' | 'at'> & { at?: number }): LearningEvent {
  return { id: nextEventId++, at: event.at ?? Date.now(), ...event };
}

/**
 * Classify an autonomous-cycle event. The cycle reports `role` + a loose
 * `meta` tag; the stream needs a single kind so one filter can isolate, for
 * example, only the words being learned.
 */
export function classifyAutonomousEvent(event: AutonomousEvent): LearningEventKind {
  if (event.meta === 'error') return 'error';
  if (event.meta?.startsWith('drill') === true) return 'drill';
  if (event.meta === 'grade') return 'grade';
  if (event.meta === 'drives') return 'drive';
  if (event.meta === 'word') return 'word';
  if (event.meta === 'review') return 'review';
  if (event.meta === 'gap' || event.meta === 'pair') return 'phrase';
  if (event.role === 'llm') return 'llm';
  if (event.role === 'observer') return event.meta === 'curious' ? 'question' : 'observer';
  return 'system';
}

/** Gutter label for an autonomous-cycle event. */
function autonomousLabel(kind: LearningEventKind, event: AutonomousEvent): string {
  if (kind === 'drill') {
    return event.meta === 'drill-induced'
      ? 'drill · induced'
      : event.meta === 'drill-memorized'
        ? 'drill · memorized'
        : 'drill';
  }
  if (kind === 'observer' && event.meta === 'recalled') return 'observer · recalled';
  if (kind === 'observer' && event.meta !== undefined) return `observer · ${event.meta}`;
  if (kind === 'llm' && event.meta === 'teach') return 'teacher · answers';
  return EVENT_STYLES[kind].label;
}

export function fromAutonomousEvent(event: AutonomousEvent, at = Date.now()): LearningEvent {
  const kind = classifyAutonomousEvent(event);
  return makeEvent({ kind, label: autonomousLabel(kind, event), text: event.text, at });
}

/**
 * The observer's own memory signals, folded into the same stream so the
 * human sees what the observer committed to memory next to what it was
 * taught. Metric ticks never reach here (the app filters them upstream).
 */
export function fromObserverSignal(signal: ObserverSignal): LearningEvent | null {
  if (signal.kind !== 'memory') return null;
  const { event, content } = signal.payload;
  const text =
    event === 'stored'
      ? `remembered "${content}"`
      : event === 'decaying'
        ? `forgetting "${content}" — needs practice`
        : `"${content}" is consolidated`;
  return makeEvent({ kind: 'memory', label: `memory · ${event}`, text, at: signal.at });
}
