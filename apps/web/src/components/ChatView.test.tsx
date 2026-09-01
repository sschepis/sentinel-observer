import { describe, it, expect, jest } from '@jest/globals';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatView } from './ChatView';
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
});
