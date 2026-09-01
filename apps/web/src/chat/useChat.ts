import { useCallback, useEffect, useRef, useState } from 'react';
import type { EdgeRef, TeacherAgent } from '../teacher/TeacherAgent';
import {
  Chaperone,
  OpenAICompatProvider,
  semanticGrader,
  type ChaperoneSettings
} from '../teacher/chaperone';
import { hybridAnswer } from '../teacher/hybrid';
import {
  loadConversations,
  loadActiveConversationId,
  saveActiveConversationId,
  createConversation,
  appendMessage,
  deleteConversation,
  type Conversation,
  type ConversationMessage
} from '../teacher/conversations';

export interface ChatController {
  conversations: Conversation[];
  activeId: string | null;
  messages: ConversationMessage[];
  /** Transient one-line status under the transcript ("the observer is asking…"). */
  status: string;
  /** True while an LLM escalation or grading round-trip is in flight. */
  pending: boolean;
  send: (text: string) => void;
  compose: (text: string) => void;
  selectConversation: (id: string) => void;
  newConversation: () => void;
  removeConversation: (id: string) => void;
}

/**
 * Chat with the observer.
 *
 * Owned by the app shell rather than the chat view, so an in-flight LLM
 * escalation survives navigating to the training stream and back.
 */
export function useChat(
  teacher: TeacherAgent | null,
  settings: ChaperoneSettings,
  onTeacherChanged: () => void,
  speak?: (text: string) => void
): ChatController {
  const [conversations, setConversations] = useState<Conversation[]>(() => loadConversations());
  const [activeId, setActiveId] = useState<string | null>(() => {
    const saved = loadActiveConversationId();
    const list = loadConversations();
    return saved !== null && list.some((c) => c.id === saved) ? saved : (list.slice(-1)[0]?.id ?? null);
  });
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState(false);

  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

  const sync = useCallback((preferredId: string | null) => {
    const list = loadConversations();
    setConversations(list);
    const wanted = preferredId ?? activeIdRef.current;
    const conversation = list.find((c) => c.id === wanted) ?? list.slice(-1)[0] ?? null;
    setActiveId(conversation?.id ?? null);
    setMessages(conversation?.messages ?? []);
  }, []);

  useEffect(() => {
    sync(null);
  }, [sync, teacher]);

  const ensureConversation = useCallback((): string => {
    const current = activeIdRef.current;
    if (current !== null && conversationsRef.current.some((c) => c.id === current)) return current;
    const conversation = createConversation();
    setConversations((prev) => [...prev, conversation]);
    setActiveId(conversation.id);
    return conversation.id;
  }, []);

  /**
   * Append the exchange to an EXPLICIT conversation. The id is captured at
   * SEND time by every caller: the creative/hybrid/grade paths resolve after
   * an LLM round-trip, so routing by the then-current active conversation
   * would land the exchange in whatever conversation the user switched to.
   */
  const pushExchange = useCallback(
    (
      userText: string,
      reply: {
        text: string;
        mode?: ConversationMessage['mode'];
        confidence?: number | null;
        score?: number | null;
        feedback?: string | null;
      },
      conversationId: string
    ) => {
      appendMessage(conversationId, { role: 'user', text: userText });
      appendMessage(conversationId, {
        role: 'observer',
        text: reply.text,
        mode: reply.mode,
        confidence: reply.confidence ?? null,
        score: reply.score ?? null,
        feedback: reply.feedback ?? null
      });
      sync(conversationId);
    },
    [sync]
  );

  /** Compose + LLM-grade + reinforce a creative answer. */
  const gradeCreative = useCallback(
    async (
      utterance: string,
      reply: { sentence: string; confidence: number | null; seedTraceIds: string[]; edges?: EdgeRef[] },
      conversationId: string
    ) => {
      if (teacher === null) return;
      setPending(true);
      setStatus('the observer is composing from its own memories…');
      let score: number | null = null;
      let feedback: string | null = null;
      if (settings.endpoint.trim().length > 0) {
        const grader = semanticGrader(new OpenAICompatProvider(settings));
        if (grader !== null) {
          try {
            const outcome = await grader.grade(utterance, reply.sentence);
            score = outcome?.score ?? null;
            feedback = outcome?.feedback ?? null;
          } catch (reason) {
            feedback = `grading unavailable: ${reason instanceof Error ? reason.message : String(reason)}`;
          }
        }
      } else {
        feedback = 'grading unavailable — configure a teacher model in Settings';
      }

      // GRADER RELIABILITY: the grade is bucketed (creative × seed
      // difficulty band × template × provider), cross-checked against the
      // composition grounding check, and applied with the bucket's feedback
      // weight. A disagreement schedules a re-grade — the confirmation UI
      // reads teacher.graderReliability().pendingRegrades(). P14: the cited
      // edges ride along so the world-feedback class is credited on them.
      const graded = teacher.gradeCreativeWithReliability(
        { traceIds: reply.seedTraceIds, edges: reply.edges ?? [] },
        score,
        utterance,
        reply.sentence,
        settings.model || settings.endpoint
      );
      if (graded.regradeId !== null) {
        feedback = `${feedback !== null && feedback.length > 0 ? feedback : `graded ${score?.toFixed(2)}`} — the internal check disagrees (re-grade pending)`;
      }
      pushExchange(
        utterance,
        {
          text: reply.sentence,
          mode: 'creative',
          confidence: reply.confidence,
          score,
          feedback
        },
        conversationId
      );
      setStatus(
        score !== null && score >= 0.7
          ? 'good answer — the observer reinforced those memories'
          : score !== null && score <= 0.3
            ? 'weak answer — those memories were slightly weakened'
            : ''
      );
      setPending(false);
      onTeacherChanged();
    },
    [teacher, settings, pushExchange, onTeacherChanged]
  );

  const send = useCallback(
    (raw: string) => {
      const utterance = raw.trim();
      if (teacher === null || utterance.length === 0) return;
      // The exchange's home is fixed at SEND time — the grade/hybrid paths
      // below resolve after an LLM round-trip, during which the user may
      // switch conversations. Routing by the push-time active conversation
      // would strand the exchange in the wrong thread.
      const conversationId = ensureConversation();
      const answer = teacher.chatAnswer(utterance);

      if (answer.mode === 'creative') {
        void gradeCreative(utterance, {
          sentence: answer.response,
          confidence: answer.confidence,
          seedTraceIds: answer.seedTraceIds,
          edges: answer.provenance.edges
        }, conversationId);
        return;
      }

      const text = answer.mode === 'decline' ? "I haven't learned that yet." : answer.response;
      if (answer.mode !== 'decline') speak?.(text);
      pushExchange(utterance, {
        text,
        mode: answer.mode,
        confidence: answer.mode === 'memorized' ? answer.confidence : null
      }, conversationId);
      setStatus('');
      onTeacherChanged();

      // HYBRID ESCALATION: when the observer had to ask, the LLM drafts an
      // answer conditioned on the observer's OWN memories; a strong draft
      // becomes a memory so no LLM is needed next time.
      if (answer.mode === 'ask' && settings.endpoint.trim().length > 0) {
        setPending(true);
        setStatus('the observer is asking its teacher…');
        void (async () => {
          try {
            const provider = new OpenAICompatProvider(settings);
            const hybrid = await hybridAnswer(
              teacher,
              new Chaperone(provider),
              semanticGrader(provider),
              utterance
            );
            if (hybrid !== null) {
              pushExchange(utterance, {
                text: hybrid.answer,
                mode: 'hybrid',
                score: hybrid.score,
                feedback: hybrid.feedback
              }, conversationId);
              setStatus(
                hybrid.stored
                  ? 'learned from the teacher — the observer can answer this from memory now'
                  : 'suggested by the teacher (not strong enough to memorize)'
              );
            }
          } catch (reason) {
            setStatus(reason instanceof Error ? reason.message : String(reason));
          } finally {
            setPending(false);
            onTeacherChanged();
          }
        })();
      }
    },
    [teacher, settings, gradeCreative, pushExchange, onTeacherChanged, speak]
  );

  /** Force a composed (creative) answer regardless of what recall would do. */
  const compose = useCallback(
    (raw: string) => {
      if (teacher === null) return;
      const utterance = raw.trim().length > 0 ? raw.trim() : 'tell me something new';
      const conversationId = ensureConversation();
      const reply = teacher.creativeReply(utterance);
      if (reply.sentence.trim().length === 0) {
        setStatus('the observer has no words to compose with yet');
        return;
      }
      void gradeCreative(utterance, reply, conversationId);
    },
    [teacher, gradeCreative, ensureConversation]
  );

  const selectConversation = useCallback(
    (id: string) => {
      saveActiveConversationId(id);
      setStatus('');
      sync(id);
    },
    [sync]
  );

  const newConversation = useCallback(() => {
    const conversation = createConversation();
    setConversations((prev) => [...prev, conversation]);
    setActiveId(conversation.id);
    setMessages([]);
    setStatus('');
  }, []);

  const removeConversation = useCallback(
    (id: string) => {
      deleteConversation(id);
      sync(null);
    },
    [sync]
  );

  return {
    conversations,
    activeId,
    messages,
    status,
    pending,
    send,
    compose,
    selectConversation,
    newConversation,
    removeConversation
  };
}
