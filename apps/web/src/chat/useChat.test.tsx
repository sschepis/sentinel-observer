/**
 * The async chat paths (creative grading, hybrid escalation) resolve after an
 * LLM round-trip. This suite pins the routing contract: the exchange belongs
 * to the conversation that was active at SEND time, even when the user
 * switches conversations while the grade/draft is in flight.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useChat } from './useChat';
import type { TeacherAgent } from '../teacher/TeacherAgent';
import type { ChaperoneSettings } from '../teacher/chaperone';
import { loadConversations } from '../teacher/conversations';

const SETTINGS: ChaperoneSettings = {
  endpoint: 'https://llm.test/v1/chat/completions',
  apiKey: 'k',
  model: 'test'
};

/** A teacher stand-in that answers with the requested mode and nothing else. */
function fakeTeacher(kind: 'creative' | 'ask'): TeacherAgent {
  const creativeAnswer = {
    mode: 'creative' as const,
    response: 'the sky remembers the rain.',
    confidence: 0.8,
    seedTraceIds: ['trace-1'],
    seedCount: 1,
    grounded: false,
    provenance: { traceIds: ['trace-1'], edges: [] }
  };
  const askAnswer = {
    mode: 'ask' as const,
    response: 'what does that mean?',
    provenance: { traceIds: [], edges: [] }
  };
  return {
    chatAnswer: () => (kind === 'creative' ? creativeAnswer : askAnswer),
    creativeGradeFeedback: () => true,
    gradeCreativeWithReliability: () => ({ stored: true, weight: 1, disagreement: false, regradeId: null }),
    recallMemories: () => [{ content: 'the sky remembers the rain', id: 'trace-1', score: 0.9 }],
    episodicRecall: () => [],
    recordGap: () => {}
  } as unknown as TeacherAgent;
}

function gatedFetch(): { mock: typeof fetch; release: () => void } {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  const mock = jest.fn(async (_url: unknown, init: unknown) => {
    await gate;
    const body = JSON.parse((init as { body: string }).body) as { response_format?: unknown };
    if (body.response_format !== undefined) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ score: 0.9, feedback: 'good answer' }) } }]
        })
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'it is nice outside today.' } }] })
    };
  }) as unknown as typeof fetch;
  return { mock, release: () => release?.() };
}

describe('useChat async conversation routing', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('routes a creative answer graded mid-flight to the send-time conversation', async () => {
    const { mock, release } = gatedFetch();
    global.fetch = mock;

    const teacher = fakeTeacher('creative');
    const { result } = renderHook(() => useChat(teacher, SETTINGS, jest.fn(), jest.fn()));

    act(() => {
      result.current.send('hello');
    });
    const originalId = result.current.activeId;
    expect(originalId).not.toBeNull();

    // The user switches conversations while the grade is still in flight.
    act(() => {
      result.current.newConversation();
    });
    expect(result.current.activeId).not.toBe(originalId);

    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => {
      const conversations = loadConversations();
      const original = conversations.find((c) => c.id === originalId);
      const other = conversations.find((c) => c.id !== originalId);
      expect(original?.messages.some((m) => m.role === 'observer' && m.mode === 'creative')).toBe(true);
      expect(other?.messages.length ?? 0).toBe(0);
    });
    expect(result.current.activeId).toBe(originalId);
  });

  it('routes a hybrid escalation answer to the send-time conversation', async () => {
    const { mock, release } = gatedFetch();
    global.fetch = mock;

    const teacher = fakeTeacher('ask');
    const { result } = renderHook(() => useChat(teacher, SETTINGS, jest.fn(), jest.fn()));

    act(() => {
      result.current.send('what is the weather like?');
    });
    const originalId = result.current.activeId;
    expect(originalId).not.toBeNull();

    act(() => {
      result.current.newConversation();
    });
    expect(result.current.activeId).not.toBe(originalId);

    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => {
      const conversations = loadConversations();
      const original = conversations.find((c) => c.id === originalId);
      const other = conversations.find((c) => c.id !== originalId);
      expect(original?.messages.some((m) => m.role === 'observer' && m.mode === 'hybrid')).toBe(true);
      expect(other?.messages.length ?? 0).toBe(0);
    });
    expect(result.current.activeId).toBe(originalId);
  });
});
