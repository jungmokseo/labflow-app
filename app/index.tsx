/**
 * Root index — Auth Gate
 *
 * Clerk 모드: 로그인 상태면 (tabs)로, 아니면 sign-in 화면 표시
 * Dev 모드: 바로 (tabs)로 리다이렉트
 */

import { Redirect } from 'expo-router';
import { useAuth } from '../src/providers/AuthProvider';
import { SignInScreen } from '../src/screens/SignInScreen';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { colors } from '../src/constants/theme';

export default function Index() {
  const { isSignedIn, isLoaded, mode } = useAuth();

  // Dev mode — 바로 탭으로
  if (mode === 'dev') {
    return <Redirect href="/(tabs)" />;
  }

  // Clerk 로딩 중
  if (!isLoaded) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  // 로그인 완료 — 탭으로
  if (isSignedIn) {
    return <Redirect href="/(tabs)" />;
  }

  // 미로그인 — 로그인 화면
  return <SignInScreen />;
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.bg,
  },
});
