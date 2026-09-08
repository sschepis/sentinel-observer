import { describe, it, expect, jest } from '@jest/globals';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatView, groupDerivation } from './ChatView';
import type { ChatController } from '../chat/useChat';
import { VoiceService } from '../speech/voice';

const voice = new VoiceService();

function chatStub(overrides: Partial<ChatController> = {}): ChatController {
  return {
    conversations: [],
    activeId: null,
    messages: [],
    status: '',
    pending: false,
    send: () => {},
    compose: () => {},
  appendAssistant: () => {},
    selectConversation: () => {},
    newConversation: () => {},
    removeConversation: () => {},
    ...overrides
  };
}

describe('ChatView', () => {
  it('asks the user to wake the observer when it is asleep', () => {
    const onStartObserver = jest.fn();
    render(
      <ChatView
        chat={chatStub()}
        ready={false}
        creativeUnlocked={false}
        voice={voice}
        onStartObserver={onStartObserver}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Wake the observer' }));
    expect(onStartObserver).toHaveBeenCalled();
  });

  it('sends the composed message on Enter and clears the composer', () => {
    const send = jest.fn();
    render(<ChatView chat={chatStub({ send })} ready creativeUnlocked={false} voice={voice} />);
    const field = screen.getByLabelText('Message the observer') as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: 'hello' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(send).toHaveBeenCalledWith('hello');
    expect(field.value).toBe('');
  });

  it('keeps the newline when Shift+Enter is pressed', () => {
    const send = jest.fn();
    render(<ChatView chat={chatStub({ send })} ready creativeUnlocked={false} voice={voice} />);
    const field = screen.getByLabelText('Message the observer');
    fireEvent.change(field, { target: { value: 'hello' } });
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });
    expect(send).not.toHaveBeenCalled();
  });

  it('renders the transcript with the observer\'s answer mode', () => {
    render(
      <ChatView
        chat={chatStub({
          messages: [
            { id: 1, role: 'user', text: 'what is an apple?', at: 1 },
            { id: 2, role: 'observer', text: 'a fruit', mode: 'creative', score: 0.9, at: 2 }
          ]
        })}
        ready
        creativeUnlocked
        voice={voice}
      />
    );
    expect(screen.getByText('what is an apple?')).toBeDefined();
    expect(screen.getByText('a fruit')).toBeDefined();
    expect(screen.getByText('composed')).toBeDefined();
    expect(screen.getByText('graded 0.90')).toBeDefined();
  });

  it('locks composing until recall competency unlocks it', () => {
    render(<ChatView chat={chatStub()} ready creativeUnlocked={false} voice={voice} />);
    expect(screen.getByRole('button', { name: 'Compose' }).hasAttribute('disabled')).toBe(true);
  });

  it('R8: unfolds the rewrite derivation ("show the work")', () => {
    render(
      <ChatView
        chat={chatStub({
          messages: [
            { id: 1, role: 'user', text: 'what is 7 + 5?', at: 1 },
            {
              id: 2,
              role: 'observer',
              text: 'The answer is 12.',
              mode: 'operator',
              at: 2,
              steps: 3,
              derivation: [
                { ruleId: 'nat.add-s', after: 's(add(s^6, s^5))' },
                { ruleId: 'nat.add-s', after: 's(s(add(s^5, s^5)))' },
                { ruleId: 'nat.add-z', after: 's(s(s(s(s(s(s(s(s(s(s(s(z))))))))))))' }
              ]
            }
          ]
        })}
        ready
        creativeUnlocked
        voice={voice}
      />
    );
    expect(screen.getByText('The answer is 12.')).toBeDefined();
    expect(screen.getByText('computed')).toBeDefined();
    const toggle = screen.getByRole('button', { name: /show the work/ });
    expect(toggle).toBeDefined();
    fireEvent.click(toggle);
    // Consecutive applications of one rule are ONE row: "1–2. nat.add-s ×2 → <last term>".
    expect(screen.getAllByText(/nat.add-s/).length).toBe(1);
    expect(screen.getByText(/×2/)).toBeDefined();
    expect(screen.getByText('1–2.')).toBeDefined();
    expect(screen.getByText('s(s(add(s^5, s^5)))')).toBeDefined();
    expect(screen.queryByText('s(add(s^6, s^5))')).toBeNull();
    expect(screen.getByText('3.')).toBeDefined();
  });

  it('groupDerivation collapses runs of the same rule and keeps the last term of each run', () => {
    expect(
      groupDerivation([
        { ruleId: 'a', after: '1' },
        { ruleId: 'a', after: '2' },
        { ruleId: 'b', after: '3' },
        { ruleId: 'a', after: '4' }
      ])
    ).toEqual([
      { first: 1, ruleId: 'a', count: 2, after: '2' },
      { first: 3, ruleId: 'b', count: 1, after: '3' },
      { first: 4, ruleId: 'a', count: 1, after: '4' }
    ]);
  });

  it('R8: hides the derivation toggle when the answer did not derive', () => {
    render(
      <ChatView
        chat={chatStub({
          messages: [{ id: 1, role: 'observer', text: 'I think so.', mode: 'creative', at: 1 }]
        })}
        ready
        creativeUnlocked
        voice={voice}
      />
    );
    expect(screen.queryByRole('button', { name: /show the work/ })).toBeNull();
  });
});
