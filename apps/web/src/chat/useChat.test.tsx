/**
 * THE SEND-TIME ROUTING CONTRACT: an exchange belongs to the conversation
 * that was active when it was SENT, even when the user switches
 * conversations while the grade is still in flight.
 *
 * The grade arrives asynchronously because THE SERVER computes it
 * (`gradeServerSide`) — the browser never grades and never calls an LLM, so
 * there is no fetch to mock here and no in-browser teacher internals to
 * stand up. That is the point: this suite used to prove the contract
 * through two browser-side model paths (an LLM grader and the hybrid
 * escalation), and both are gone. The contract is unchanged and still
 * worth pinning; only the thing that makes the answer late has moved to
 * where it belongs.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useChat } from './useChat';
import type { TeacherAgent } from '../teacher/TeacherAgent';
import type { ChaperoneSettings } from '../teacher/chaperone';
import { loadConversations } from '../teacher/conversations';

/** What App passes: the chaperone lives on the server, so this is empty. */
const SETTINGS: ChaperoneSettings = { endpoint: '', apiKey: '', model: '' };

/** A gate the test opens when it wants the server's grade to come back. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return { promise, release: () => release?.() };
}

/**
 * A remote-teacher stand-in: it composes, and its grade comes back only
 * when the test releases the gate — exactly the shape of a server round
 * trip, with no provider and no memory internals (the remote teacher has
 * neither, which is why the browser cannot escalate on its own).
 */
function serverTeacher(gate: Promise<void>): TeacherAgent {
  return {
    chatAnswer: () => ({
      mode: 'creative' as const,
      response: 'the sky remembers the rain.',
      confidence: 0.8,
      seedTraceIds: ['trace-1'],
      seedCount: 1,
      grounded: false,
      provenance: { traceIds: ['trace-1'], edges: [] }
    }),
    creativeGradeFeedback: () => true,
    gradeServerSide: async () => {
      await gate;
      return {
        score: 0.9,
        feedback: 'good answer',
        graded: { stored: true, weight: 1, disagreement: false, regradeId: null }
      };
    },
    gradeCreativeWithReliability: () => ({ stored: true, weight: 1, disagreement: false, regradeId: null })
  } as unknown as TeacherAgent;
}

describe('useChat async conversation routing', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('routes an answer graded mid-flight to the send-time conversation', async () => {
    const gate = deferred();
    const teacher = serverTeacher(gate.promise);
    const { result } = renderHook(() => useChat(teacher, SETTINGS, jest.fn(), jest.fn()));

    act(() => {
      result.current.send('hello');
    });
    const originalId = result.current.activeId;
    expect(originalId).not.toBeNull();

    // The user switches conversations while the server's grade is in flight.
    act(() => {
      result.current.newConversation();
    });
    expect(result.current.activeId).not.toBe(originalId);

    await act(async () => {
      gate.release();
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

  it('never grades in the browser: with no server-side grader it says so instead of calling one', async () => {
    // The regression this pins: the hook used to build an
    // OpenAI-compatible provider and grade the answer HERE whenever a
    // chaperone endpoint was configured. A page that scores the model's
    // answers is a page doing the model's work.
    const fetchSpy = jest.fn(async () => {
      throw new Error('the browser must not call an LLM');
    });
    global.fetch = fetchSpy as unknown as typeof fetch;
    const teacher = {
      chatAnswer: () => ({
        mode: 'creative' as const,
        response: 'the sky remembers the rain.',
        confidence: 0.8,
        seedTraceIds: ['trace-1'],
        seedCount: 1,
        grounded: false,
        provenance: { traceIds: ['trace-1'], edges: [] }
      }),
      creativeGradeFeedback: () => true,
      gradeCreativeWithReliability: () => ({ stored: true, weight: 1, disagreement: false, regradeId: null })
    } as unknown as TeacherAgent;

    // A configured endpoint is exactly the condition that used to trigger it.
    const { result } = renderHook(() =>
      useChat(teacher, { endpoint: 'https://llm.test/v1/chat/completions', apiKey: 'k', model: 'test' }, jest.fn(), jest.fn())
    );

    act(() => {
      result.current.send('hello');
    });

    await waitFor(() => {
      const original = loadConversations().find((c) => c.id === result.current.activeId);
      expect(original?.messages.some((m) => m.role === 'observer' && m.mode === 'creative')).toBe(true);
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
