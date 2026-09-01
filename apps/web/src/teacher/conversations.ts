/**
 * Conversations: named chat threads persisted to localStorage so the
 * transcript survives reloads — exactly as left, with no retraining.
 *
 * The observer's MEMORY lives in IndexedDB (traces, word states,
 * definitions) via the teacher's persistAll; this module persists only the
 * human↔observer chat transcript. A conversation is the durable context the
 * working memory window reads on each reload.
 */

export type ConversationRole = 'user' | 'observer';

export interface ConversationMessage {
  id: number;
  role: ConversationRole;
  text: string;
  mode?: 'memorized' | 'operator' | 'creative' | 'ask' | 'hybrid' | 'decline';
  confidence?: number | null;
  score?: number | null;
  feedback?: string | null;
  at: number;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ConversationMessage[];
}

const STORAGE_KEY = 'sentinel.conversations.v1';
const ACTIVE_KEY = 'sentinel.conversations.active.v1';
const MAX_CONVERSATIONS = 50;
const MAX_MESSAGES = 400;

function read(): Conversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as Conversation[]) : [];
  } catch {
    return [];
  }
}

function write(conversations: Conversation[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations.slice(-MAX_CONVERSATIONS)));
  } catch {
    // Storage full or unavailable — the transcript degrades gracefully.
  }
}

export function loadConversations(): Conversation[] {
  return read();
}

export function loadActiveConversationId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function saveActiveConversationId(id: string): void {
  try {
    localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    // Non-fatal.
  }
}

let messageCounter = Date.now() % 100000;

export function createConversation(title = 'New conversation'): Conversation {
  const conversation: Conversation = {
    id: `conv-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: []
  };
  const conversations = read();
  conversations.push(conversation);
  write(conversations);
  saveActiveConversationId(conversation.id);
  return conversation;
}

/** Append a message to a conversation and persist. Returns the saved message. */
export function appendMessage(
  conversationId: string,
  message: Omit<ConversationMessage, 'id' | 'at'>
): ConversationMessage | null {
  const conversations = read();
  const conversation = conversations.find((c) => c.id === conversationId);
  if (conversation === undefined) return null;
  const saved: ConversationMessage = { ...message, id: messageCounter++, at: Date.now() };
  conversation.messages.push(saved);
  if (conversation.messages.length > MAX_MESSAGES) {
    conversation.messages = conversation.messages.slice(-MAX_MESSAGES);
  }
  conversation.updatedAt = Date.now();
  if (conversation.title === 'New conversation' && saved.role === 'user') {
    conversation.title = saved.text.slice(0, 48);
  }
  write(conversations);
  return saved;
}

export function deleteConversation(conversationId: string): void {
  const conversations = read().filter((c) => c.id !== conversationId);
  write(conversations);
}

/** Persist a full conversation (title/rename, reorder, etc.). */
export function updateConversation(conversation: Conversation): void {
  const conversations = read();
  const index = conversations.findIndex((c) => c.id === conversation.id);
  if (index >= 0) {
    conversations[index] = conversation;
  } else {
    conversations.push(conversation);
  }
  write(conversations);
}