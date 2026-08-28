import type {
  ObserverSignal,
  StimulusResult
} from '@sschepis/sentient-core';
import { SMF_AXES } from '@sschepis/sentient-core';

/**
 * Honest signal interpretation: every interpretation cites the signal it came
 * from, and signals with no template render as 'uninterpreted' — the app
 * never invents meaning for a metric it cannot explain.
 */
export type Interpretation =
  | { kind: 'explained'; title: string; detail: string }
  | { kind: 'uninterpreted'; title: string; detail: string };

/** Display name for an SMF axis (snake_case -> Title Case), from the core table. */
function axisDisplayName(name: string): string {
  return name
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

const axisNames: Record<string, string> = Object.fromEntries(
  Object.values(SMF_AXES).map((info) => [info.name, axisDisplayName(info.name)])
);

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour12: false });
}

/** Turn a raw signal into human language. */
export function interpretSignal(signal: ObserverSignal): Interpretation {
  switch (signal.kind) {
    case 'stimulus': {
      const { stimulus } = signal.payload;
      if (stimulus.kind === 'text') {
        return {
          kind: 'explained',
          title: 'Stimulus',
          detail: `text: "${truncate(stimulus.content, 60)}"${signal.causeId ? ` (from ${shortId(signal.causeId)})` : ''}`
        };
      }
      if (stimulus.kind === 'attention') {
        return {
          kind: 'explained',
          title: 'Attention',
          detail: `${stimulus.focus} at intensity ${stimulus.intensity}`
        };
      }
      if (stimulus.kind === 'event') {
        return {
          kind: 'explained',
          title: 'Event',
          detail: `${stimulus.type} → ${stimulus.outcome}${stimulus.detail ? ` (${truncate(stimulus.detail, 40)})` : ''}`
        };
      }
      return { kind: 'explained', title: 'Noise', detail: `ambient level ${stimulus.level}` };
    }

    case 'metric':
      return {
        kind: 'uninterpreted',
        title: 'Tick',
        detail: `coherence ${signal.payload.coherence.toFixed(3)} · entropy ${signal.payload.entropy.toFixed(3)}`
      };

    case 'insight':
      return {
        kind: 'explained',
        title: 'Insight moment',
        detail: `coherence ${signal.payload.coherence.toFixed(3)} on axis "${axisNames[signal.payload.axis] ?? signal.payload.axis}"${signal.causeId ? ` · caused by ${shortId(signal.causeId)}` : ''}`
      };

    case 'drift': {
      const p = signal.payload;
      return {
        kind: 'explained',
        title: 'Focus drift',
        detail: `coherence fell ${(p.coherenceStart - p.coherenceEnd).toFixed(3)} over ${(p.durationMs / 1000).toFixed(0)}s (${p.coherenceStart.toFixed(3)} → ${p.coherenceEnd.toFixed(3)})${signal.causeId ? ` · after ${shortId(signal.causeId)}` : ''}`
      };
    }

    case 'memory': {
      const p = signal.payload;
      if (p.event === 'stored') {
        return { kind: 'explained', title: 'Memory stored', detail: `"${truncate(p.content, 60)}"` };
      }
      if (p.event === 'decaying') {
        return {
          kind: 'explained',
          title: 'Memory decaying',
          detail: `"${truncate(p.content, 60)}" strength ${(p.strength ?? 0).toFixed(2)} — review soon`
        };
      }
      return { kind: 'explained', title: 'Memory consolidated', detail: `"${truncate(p.content, 60)}"` };
    }
  }
}

/** Human summary of a stimulus's immediate effect (the "why" line). */
export function describeStimulusResult(result: StimulusResult): string {
  const axes = result.touchedAxes.length > 0
    ? result.touchedAxes.slice(0, 3).map((a) => axisNames[a] ?? a).join(', ')
    : 'no axes';
  const primes = result.excitedPrimes.length > 0
    ? result.excitedPrimes.slice(0, 5).join(', ')
    : 'none';
  return `excited primes [${primes}] → ${axes} moved (Δcoherence ${result.coherenceDelta >= 0 ? '+' : ''}${result.coherenceDelta.toFixed(3)})`;
}

export function signalTimestamp(signal: ObserverSignal): string {
  return formatTime(signal.at);
}

/**
 * The observer's diary entry for a memory signal, written in the first
 * person: the observer is the learner, and the diary is its own record —
 * failures included.
 */
export function diaryEntry(signal: ObserverSignal): string | null {
  if (signal.kind !== 'memory') return null;
  const { event, content } = signal.payload;
  switch (event) {
    case 'stored':
      return `I learned "${content}" today.`;
    case 'decaying':
      return `I keep forgetting "${content}" — I should practice it again.`;
    case 'consolidated':
      return `"${content}" is now part of me.`;
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}
