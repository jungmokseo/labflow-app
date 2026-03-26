/**
 * AuthProvider — Clerk 인증 + Dev Mode 병행 지원
 *
 * Clerk가 설정되면 ClerkProvider + expo-secure-store tokenCache로 감싸고,
 * 설정되지 않으면 dev mode로 동작 (X-Dev-User-Id 헤더 사용).
 *
 * 사용법:
 *   import { useAuth } from '../providers/AuthProvider';
 *   const { userId, isSignedIn, getToken } = useAuth();
 */

import React, { createContext, useContext, useMemo, ReactNode } from 'react';
import * as SecureStore from 'expo-secure-store';

// ── Clerk 설정 ──────────────────────────────────────
const CLERK_PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY || '';

interface AuthContextType {
  userId: string;
  isSignedIn: boolean;
  isLoaded: boolean;
  getToken: () => Promise<string | null>;
  mode: 'clerk' | 'dev';
}

const AuthContext = createContext<AuthContextType>({
  userId: 'dev-user-001',
  isSignedIn: true,
  isLoaded: true,
  getToken: async () => null,
  mode: 'dev',
});

export function useAuth() {
  return useContext(AuthContext);
}

// ── expo-secure-store 기반 tokenCache ────────────────
const tokenCache = {
  async getToken(key: string) {
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  },
  async saveToken(key: string, value: string) {
    try {
      await SecureStore.setItemAsync(key, value);
    } catch {
      // SecureStore 실패 시 무시 (시뮬레이터 등)
    }
  },
  async clearToken(key: string) {
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {
      // 무시
    }
  },
};

// ── Dev Mode Provider (Clerk 미설정 시) ──────────────
function DevAuthProvider({ children }: { children: ReactNode }) {
  const value = useMemo<AuthContextType>(() => ({
    userId: 'dev-user-001',
    isSignedIn: true,
    isLoaded: true,
    getToken: async () => null,
    mode: 'dev',
  }), []);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

// ── Main Auth Provider ──────────────────────────────
export function AuthProvider({ children }: { children: ReactNode }) {
  // Clerk 키가 없으면 dev mode
  if (!CLERK_PUBLISHABLE_KEY) {
    return <DevAuthProvider>{children}</DevAuthProvider>;
  }

  // Clerk 키가 있으면 Clerk Provider 사용
  try {
    // @ts-ignore - Clerk가 설치되지 않았을 수 있음
    const { ClerkProvider, useAuth: useClerkAuth } = require('@clerk/clerk-expo');

    function ClerkAuthBridge({ children: c }: { children: ReactNode }) {
      const clerkAuth = useClerkAuth();
      const value = useMemo<AuthContextType>(() => ({
        userId: clerkAuth.userId || 'anonymous',
        isSignedIn: clerkAuth.isSignedIn ?? false,
        isLoaded: clerkAuth.isLoaded ?? false,
        getToken: async () => {
          try { return await clerkAuth.getToken(); }
          catch { return null; }
        },
        mode: 'clerk',
      }), [clerkAuth.userId, clerkAuth.isSignedIn, clerkAuth.isLoaded]);
      return <AuthContext.Provider value={value}>{c}</AuthContext.Provider>;
    }

    return (
      <ClerkProvider
        publishableKey={CLERK_PUBLISHABLE_KEY}
        tokenCache={tokenCache}
      >
        <ClerkAuthBridge>{children}</ClerkAuthBridge>
      </ClerkProvider>
    );
  } catch {
    console.warn('⚠️ @clerk/clerk-expo not installed. Using dev mode.');
    return <DevAuthProvider>{children}</DevAuthProvider>;
  }
}
