/**
 * Mobile Sign-In Screen
 *
 * Clerk 모드에서만 사용됩니다.
 * @clerk/clerk-expo의 useSignIn 훅을 동적으로 로드합니다.
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { colors, spacing, fontSize, borderRadius } from '../constants/theme';

export function SignInScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn');

  // Clerk 동적 로드
  let useSignIn: any, useSignUp: any;
  try {
    const clerk = require('@clerk/clerk-expo');
    useSignIn = clerk.useSignIn;
    useSignUp = clerk.useSignUp;
  } catch {
    // Clerk 미설치
  }

  const signInHook = useSignIn?.();
  const signUpHook = useSignUp?.();

  const handleSignIn = useCallback(async () => {
    if (!signInHook?.signIn) {
      Alert.alert('Error', 'Clerk is not configured');
      return;
    }
    if (!email || !password) {
      Alert.alert('입력 오류', '이메일과 비밀번호를 입력해주세요.');
      return;
    }

    setLoading(true);
    try {
      const result = await signInHook.signIn.create({
        identifier: email,
        password,
      });
      if (result.status === 'complete') {
        await signInHook.setActive({ session: result.createdSessionId });
      }
    } catch (err: any) {
      const msg = err?.errors?.[0]?.longMessage || err?.message || '로그인 실패';
      Alert.alert('로그인 실패', msg);
    } finally {
      setLoading(false);
    }
  }, [email, password, signInHook]);

  const handleSignUp = useCallback(async () => {
    if (!signUpHook?.signUp) {
      Alert.alert('Error', 'Clerk is not configured');
      return;
    }
    if (!email || !password) {
      Alert.alert('입력 오류', '이메일과 비밀번호를 입력해주세요.');
      return;
    }

    setLoading(true);
    try {
      const result = await signUpHook.signUp.create({
        emailAddress: email,
        password,
      });

      // 이메일 인증이 필요할 수 있음
      if (result.status === 'complete') {
        await signUpHook.setActive({ session: result.createdSessionId });
      } else {
        // 이메일 인증 등 추가 단계 필요
        Alert.alert('확인 필요', '이메일 인증을 완료해주세요.');
      }
    } catch (err: any) {
      const msg = err?.errors?.[0]?.longMessage || err?.message || '회원가입 실패';
      Alert.alert('회원가입 실패', msg);
    } finally {
      setLoading(false);
    }
  }, [email, password, signUpHook]);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.container}
    >
      <View style={styles.content}>
        {/* Logo */}
        <View style={styles.logoSection}>
          <Text style={styles.logoIcon}>🧪</Text>
          <Text style={styles.logoText}>LabFlow</Text>
          <Text style={styles.tagline}>Research Lab AI OS</Text>
        </View>

        {/* Form */}
        <View style={styles.form}>
          <Text style={styles.title}>
            {mode === 'signIn' ? '로그인' : '회원가입'}
          </Text>

          <TextInput
            style={styles.input}
            placeholder="이메일"
            placeholderTextColor={colors.textMuted}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            textContentType="emailAddress"
          />

          <TextInput
            style={styles.input}
            placeholder="비밀번호"
            placeholderTextColor={colors.textMuted}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            textContentType="password"
          />

          <TouchableOpacity
            style={[styles.button, loading && styles.buttonDisabled]}
            onPress={mode === 'signIn' ? handleSignIn : handleSignUp}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color={colors.white} />
            ) : (
              <Text style={styles.buttonText}>
                {mode === 'signIn' ? '로그인' : '회원가입'}
              </Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.switchMode}
            onPress={() => setMode(mode === 'signIn' ? 'signUp' : 'signIn')}
          >
            <Text style={styles.switchText}>
              {mode === 'signIn'
                ? '계정이 없으신가요? 회원가입'
                : '이미 계정이 있으신가요? 로그인'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  logoSection: {
    alignItems: 'center',
    marginBottom: spacing.xxl + spacing.lg,
  },
  logoIcon: {
    fontSize: 48,
    marginBottom: spacing.sm,
  },
  logoText: {
    fontSize: fontSize.title,
    fontWeight: '800',
    color: colors.primary,
  },
  tagline: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },
  form: {
    gap: spacing.md,
  },
  title: {
    fontSize: fontSize.xl,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  input: {
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.bgInput,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md + 2,
    fontSize: fontSize.md,
    color: colors.text,
  },
  button: {
    backgroundColor: colors.primary,
    borderRadius: borderRadius.md,
    paddingVertical: spacing.md + 2,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: colors.white,
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  switchMode: {
    alignItems: 'center',
    paddingVertical: spacing.md,
  },
  switchText: {
    color: colors.primary,
    fontSize: fontSize.sm,
  },
});
