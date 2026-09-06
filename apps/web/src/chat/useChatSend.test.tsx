/**
 * The chat send path, validated end to end: clicking a sample prompt must
 * create the conversation, append the user message AND the observer reply,
 * and render them in the content area — the regression the UI hit where a
 * new conversation appeared in the sidebar but the transcript stayed empty.
 *
 * @jest-environment jsdom
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useChat } from './useChat';
import { ChatView } from '../components/ChatView';
import type { ChatTeacher } from '../server/client';
import type { ChatAnswerWithMemory } from '../teacher/TeacherAgent';

const cannedAnswer = (response: string, mode: ChatAnswerWithMemory['mode'] = 'memorized'): ChatAnswerWithMemory =>
  ({
    mode,
    response,
    confidence: null,
    provenance: { traceIds: [], edges: [] }
  }) as ChatAnswerWithMemory;

/** A fake remote-capable teacher: answers with a canned memorized reply,
 *  never intercepts as a teach-reply. */
function fakeTeacher(response: string): ChatTeacher {
  return {
    chatAnswer: async (utterance: string) => cannedAnswer(response),
    creativeReply: async () => ({
      sentence: response,
      seedCount: 0,
      seedTraceIds: [],
      confidence: null,
      grounded: false,
      hedged: false,
      edges: [],
      provenance: { traceIds: [], edges: [] },
      templateIds: [],
      ruleIds: []
    }),
    gradeCreativeWithReliability: () => ({
      stored: false,
      weight: 1,
      disagreement: false,
      regradeId: null
    }),
    tryTeachReply: () => null
  };
}

const VOICE = { sttAvailable: false, ttsAvailable: () => false, speak: () => false, stopSpeaking: () => {}, configure: () => {}, startListening: () => () => {}, recognize: async () => null } as never;

describe('chat send path (chip → transcript)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('send() appends the exchange to the active conversation and the messages state', async () => {
    const teacher = fakeTeacher('Hello! I am learning English.');
    let controller!: ReturnType<typeof useChat>;
    function Host() {
      controller = useChat(teacher, { endpoint: '', apiKey: '', model: '' }, () => {});
      return null;
    }
    render(<Host />);

    await act(async () => {
      controller.send('hello');
    });

    expect(controller.conversations).toHaveLength(1);
    expect(controller.activeId).toBe(controller.conversations[0].id);
    expect(controller.messages).toHaveLength(2);
    expect(controller.messages[0].role).toBe('user');
    expect(controller.messages[0].text).toBe('hello');
    expect(controller.messages[1].role).toBe('observer');
    expect(controller.messages[1].text).toBe('Hello! I am learning English.');
  });

  it('clicking a sample chip renders the exchange in the content area', async () => {
    const teacher = fakeTeacher('Hello! I am learning English.');
    let controller!: ReturnType<typeof useChat>;
    function Host() {
      controller = useChat(teacher, { endpoint: '', apiKey: '', model: '' }, () => {});
      return <ChatView chat={controller} ready={true} creativeUnlocked={false} voice={VOICE} />;
    }
    render(<Host />);

    // The empty state shows the sample prompts; clicking one sends it.
    const chip = screen.getByText('hello');
    await act(async () => {
      fireEvent.click(chip);
    });

    // The content area must now show the user message and the observer's
    // reply — NOT the empty-state prompt list anymore.
    expect(controller.messages).toHaveLength(2);
    expect(screen.getAllByText('hello').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Hello! I am learning English.')).toBeDefined();
    // A second send continues in the SAME conversation (no sidebar churn).
    await act(async () => {
      controller.send('hi');
    });
    expect(controller.conversations).toHaveLength(1);
    expect(controller.messages).toHaveLength(4);
  });
});

describe('chat send path under failure (the empty-content regression)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('a failing teacher still renders the user message plus a visible error bubble', async () => {
    const failingTeacher: ChatTeacher = {
      chatAnswer: async () => {
        throw new Error('observer server unreachable at http://localhost:8787');
      },
      creativeReply: async () => {
        throw new Error('observer server unreachable');
      },
      gradeCreativeWithReliability: () => ({
        stored: false,
        weight: 1,
        disagreement: false,
        regradeId: null
      }),
      tryTeachReply: () => null
    };

    let controller!: ReturnType<typeof useChat>;
    function Host() {
      controller = useChat(failingTeacher, { endpoint: '', apiKey: '', model: '' }, () => {});
      return <ChatView chat={controller} ready={true} creativeUnlocked={false} voice={VOICE} />;
    }
    render(<Host />);

    const chip = screen.getByText('hello');
    await act(async () => {
      fireEvent.click(chip);
    });

    // The content area must NOT stay empty: the user message is there and
    // the error bubble explains what happened.
    expect(controller.messages.length).toBeGreaterThanOrEqual(2);
    expect(controller.messages[0].role).toBe('user');
    expect(controller.messages[0].text).toBe('hello');
    expect(controller.messages[1].text).toContain('observer server unreachable');
    expect(screen.getByText('hello')).toBeDefined();
    expect(screen.getByText(/observer server unreachable/)).toBeDefined();
  });
});
