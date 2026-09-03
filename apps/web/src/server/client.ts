import type {
  ObserverSignal,
  SemanticObserverState,
  StimulusResult
} from '@sschepis/sentient-core';
import type {
  ChatAnswerWithMemory,
  CreativeReply,
  TeacherAgent
} from '../teacher/TeacherAgent';
import type { HybridCapableTeacher } from '../teacher/hybrid';

/**
 * Browser client for the observer server (server/main.ts).
 *
 * The observer and teacher live on the server; this module is the thin
 * remote surface the web app drives them through: JSON POST for actions,
 * an SSE stream for live metrics/signals, and snapshot downloads for the
 * trained model.
 */

export interface RemoteServerState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  running: boolean;
  restored: number;
  freshTrained: boolean;
  learned: number;
  total: number;
  competency: number;
  creativeUnlocked: boolean;
  savedAt: number | null;
  lastSaveMs: number | null;
  modelPath: string | null;
  tracesInModel: number;
  tickCount: number;
}

export interface RemoteWordEntry {
  word: string;
  definition: string;
  example: string;
  traceId: string | null;
  taughtAt: number | null;
  lastAskedAt: number | null;
  lastGrade: 'correct' | 'wrong' | null;
  successes: number;
  failures: number;
  stability: number;
  difficulty: number;
  dueAt: number | null;
  lastIntervalDays: number | null;
  reviewHistory: Array<'correct' | 'wrong'>;
  strength: number | null;
  status: 'new' | 'learning' | 'consolidated';
}

export type RemoteEvent =
  | { kind: 'metrics'; at: number; state: SemanticObserverState }
  | { kind: 'signal'; signal: ObserverSignal }
  | { kind: 'snapshot'; snapshot: { at: number; traces: number; deck: string; bytes: number } }
  | { kind: 'lifecycle'; at: number; event: string; detail: string }
  | { kind: 'state'; status: string };

export class RemoteClient {
  private readonly base: string;
  private eventSource: EventSource | null = null;

  constructor(base: string) {
    this.base = base.replace(/\/$/, '');
  }

  /** A reachability probe: resolves the server state, rejects when the
   *  server is not there (a short timeout so the app can fall back to
   *  running the observer locally). */
  static async probe(base: string, timeoutMs = 1500): Promise<RemoteServerState> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${base.replace(/\/$/, '')}/api/state`, { signal: controller.signal });
      if (!response.ok) throw new Error(`server responded ${response.status}`);
      return (await response.json()) as RemoteServerState;
    } finally {
      clearTimeout(timer);
    }
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const payload = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(payload.error ?? `server error ${response.status}`);
    return payload;
  }

  state(): Promise<RemoteServerState> {
    return fetch(`${this.base}/api/state`).then((r) => r.json() as Promise<RemoteServerState>);
  }

  words(): Promise<RemoteWordEntry[]> {
    return fetch(`${this.base}/api/words`)
      .then((r) => r.json())
      .then((payload) => (payload as { words: RemoteWordEntry[] }).words);
  }

  chat(utterance: string): Promise<ChatAnswerWithMemory> {
    return this.post<{ answer: ChatAnswerWithMemory }>('/api/chat', { utterance }).then((p) => p.answer);
  }

  compose(utterance: string): Promise<CreativeReply> {
    return this.post<{ reply: CreativeReply }>('/api/compose', { utterance }).then((p) => p.reply);
  }

  grade(provenance: {
    traceIds: string[];
    edges: unknown[];
    templateIds: string[];
    ruleIds?: string[];
  }, score: number | null, utterance: string, answer: string, provider: string): Promise<{
    stored: boolean;
    weight: number;
    disagreement: boolean;
    regradeId: string | null;
  }> {
    return this.post<{ graded: ReturnType<TeacherAgent['gradeCreativeWithReliability']> }>('/api/grade', {
      ...provenance,
      score,
      utterance,
      answer,
      provider
    }).then((p) => p.graded);
  }

  teachWord(word: string): Promise<{ traceId: string | null }> {
    return this.post<{ taught: { traceId: string | null } }>('/api/teach', { word }).then((p) => p.taught);
  }

  teachExchange(cue: string, response: string): Promise<number> {
    return this.post<{ exchanges: number }>('/api/teach', { cue, response }).then((p) => p.exchanges);
  }

  observe(text: string): Promise<boolean> {
    return this.post<{ observed: boolean }>('/api/observe', { text }).then((p) => p.observed);
  }

  wake(): Promise<void> {
    return this.post('/api/wake', {}).then(() => undefined);
  }

  sleep(): Promise<void> {
    return this.post('/api/sleep', {}).then(() => undefined);
  }

  save(): Promise<void> {
    return this.post('/api/save', {}).then(() => undefined);
  }

  /** The trained model as a browser download (bootstrap record). */
  downloadSnapshot(): void {
    const link = document.createElement('a');
    link.href = `${this.base}/api/snapshot`;
    link.download = 'observer-model.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  /** Subscribe to the live event stream (metrics, signals, saves). */
  connect(onEvent: (event: RemoteEvent) => void, onClose?: () => void): () => void {
    const source = new EventSource(`${this.base}/api/events`);
    const kinds = ['metrics', 'signal', 'snapshot', 'lifecycle', 'state'] as const;
    for (const kind of kinds) {
      source.addEventListener(kind, (message) => {
        try {
          onEvent({ ...(JSON.parse((message as MessageEvent<string>).data) as object), kind } as RemoteEvent);
        } catch {
          // A malformed event is skipped, never thrown into the UI.
        }
      });
    }
    source.onerror = () => {
      // The browser retries automatically; surface the state for the UI.
      onClose?.();
    };
    this.eventSource = source;
    return () => {
      source.close();
      if (this.eventSource === source) this.eventSource = null;
    };
  }

  disconnect(): void {
    this.eventSource?.close();
    this.eventSource = null;
  }
}

/** Structural subset of TeacherAgent the chat hook needs — satisfied by
 *  both the real teacher and the remote client (async). */
export interface ChatTeacher {
  chatAnswer(utterance: string): ChatAnswerWithMemory | Promise<ChatAnswerWithMemory>;
  creativeReply(utterance: string): CreativeReply | Promise<CreativeReply>;
  gradeCreativeWithReliability(
    provenance: Parameters<TeacherAgent['gradeCreativeWithReliability']>[0],
    score: number | null,
    utterance: string,
    answer: string,
    provider: string
  ): ReturnType<TeacherAgent['gradeCreativeWithReliability']> | Promise<ReturnType<TeacherAgent['gradeCreativeWithReliability']>>;
}

export function awaitable<T>(value: T | Promise<T>): Promise<T> {
  return value instanceof Promise ? value : Promise.resolve(value);
}

/** True when the teacher exposes the memory internals the hybrid escalation
 *  needs — the in-browser teacher does; the remote teacher does not (the
 *  server's observer answers exactly what it knows and asks otherwise). */
export function isHybridCapable(teacher: ChatTeacher | null): teacher is ChatTeacher & HybridCapableTeacher {
  if (teacher === null) return false;
  const candidate = teacher as Partial<Record<'recallMemories' | 'episodicRecall' | 'recordGap', unknown>>;
  return (
    typeof candidate.recallMemories === 'function' &&
    typeof candidate.episodicRecall === 'function' &&
    typeof candidate.recordGap === 'function'
  );
}

/** The remote chat teacher: answers come from the server's live observer. */
export function remoteChatTeacher(client: RemoteClient): ChatTeacher {
  return {
    chatAnswer: (utterance) => client.chat(utterance),
    creativeReply: (utterance) => client.compose(utterance),
    gradeCreativeWithReliability: (provenance, score, utterance, answer, provider) => {
      const traceIds = 'traceIds' in provenance ? provenance.traceIds : [...provenance];
      const edges = 'traceIds' in provenance ? (provenance.edges ?? []) : [];
      const templateIds = 'traceIds' in provenance ? (provenance.templateIds ?? []) : [];
      const ruleIds = 'traceIds' in provenance ? (provenance.ruleIds ?? []) : [];
      return client.grade({ traceIds, edges, templateIds, ruleIds }, score, utterance, answer, provider);
    }
  };
}
