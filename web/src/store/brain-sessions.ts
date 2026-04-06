import { create } from 'zustand';

export type BrainSession = {
  id: string;
  name: string;
  lastMessageAt?: string;
  createdAt: string;
};

type BrainSessionsStore = {
  sessions: BrainSession[];
  setSessions: (sessions: BrainSession[]) => void;
  removeSession: (id: string) => void;
};

export const useBrainSessionsStore = create<BrainSessionsStore>((set) => ({
  sessions: [],
  setSessions: (sessions) => set({ sessions }),
  removeSession: (id) => set((s) => ({
    sessions: s.sessions.filter((sess) => sess.id !== id),
  })),
}));
