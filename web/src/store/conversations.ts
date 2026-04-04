import { create } from 'zustand';
import type { BrainMessage } from '@/lib/api';

type Conversation = {
  channelId: string;
  messages: BrainMessage[];
  isStreaming: boolean;
};

type ConversationsStore = {
  conversations: Record<string, Conversation>;
  activeChannelId: string | null;
  setActive: (id: string | null) => void;
  setMessages: (channelId: string, messages: BrainMessage[]) => void;
  addMessage: (channelId: string, message: BrainMessage) => void;
  setStreaming: (channelId: string, streaming: boolean) => void;
  getConversation: (channelId: string) => Conversation | undefined;
};

export const useConversationsStore = create<ConversationsStore>((set, get) => ({
  conversations: {},
  activeChannelId: null,
  setActive: (id) => set({ activeChannelId: id }),
  setMessages: (channelId, messages) => set((s) => ({
    conversations: {
      ...s.conversations,
      [channelId]: { channelId, messages, isStreaming: s.conversations[channelId]?.isStreaming ?? false }
    }
  })),
  addMessage: (channelId, message) => set((s) => {
    const conv = s.conversations[channelId] || { channelId, messages: [], isStreaming: false };
    return {
      conversations: {
        ...s.conversations,
        [channelId]: { ...conv, messages: [...conv.messages, message] }
      }
    };
  }),
  setStreaming: (channelId, streaming) => set((s) => {
    const conv = s.conversations[channelId];
    if (!conv) return s;
    return {
      conversations: {
        ...s.conversations,
        [channelId]: { ...conv, isStreaming: streaming }
      }
    };
  }),
  getConversation: (channelId) => get().conversations[channelId],
}));
