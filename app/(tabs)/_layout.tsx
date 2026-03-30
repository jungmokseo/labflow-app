import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../../src/constants/theme';

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarStyle: {
          backgroundColor: colors.bgCard,
          borderTopColor: colors.bgInput,
          borderTopWidth: 0.5,
          height: 85,
          paddingBottom: 28,
          paddingTop: 8,
        },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '600',
        },
        headerStyle: {
          backgroundColor: colors.bg,
        },
        headerTintColor: colors.text,
        headerShadowVisible: false,
      }}
    >
      {/* ── 4 Primary Tabs ── */}
      <Tabs.Screen
        name="briefing"
        options={{
          title: '브리핑',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="sunny-outline" size={size} color={color} />
          ),
          headerTitle: '📋 오늘의 브리핑',
          headerTitleStyle: { fontSize: 18, fontWeight: '700' },
        }}
      />
      <Tabs.Screen
        name="brain-chat"
        options={{
          title: '채팅',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="chatbubbles-outline" size={size} color={color} />
          ),
          headerTitle: '💬 AI 채팅',
          headerTitleStyle: { fontSize: 18, fontWeight: '700' },
        }}
      />
      <Tabs.Screen
        name="chatbot"
        options={{
          title: '보이스',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="mic-outline" size={size} color={color} />
          ),
          headerTitle: '🎙️ 논문 토론 · 영어 튜터',
          headerTitleStyle: { fontSize: 18, fontWeight: '700' },
        }}
      />
      <Tabs.Screen
        name="onboarding"
        options={{
          title: '프로필',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="person-outline" size={size} color={color} />
          ),
          headerTitle: '⚙️ 연구실 프로필',
          headerTitleStyle: { fontSize: 18, fontWeight: '700' },
        }}
      />

      {/* ── Hidden Tabs (accessible via chat, not shown in tab bar) ── */}
      <Tabs.Screen
        name="index"
        options={{
          href: null, // Hide from tab bar
          title: '미니브레인',
          headerTitle: '🧠 미니브레인',
        }}
      />
      <Tabs.Screen
        name="memo"
        options={{
          href: null,
          title: '캡처',
          headerTitle: '⚡ 빠른 캡처',
        }}
      />
      <Tabs.Screen
        name="paper-alerts"
        options={{
          href: null,
          title: '논문',
          headerTitle: '📚 논문 알림',
        }}
      />
      <Tabs.Screen
        name="knowledge-graph"
        options={{
          href: null,
          title: '그래프',
          headerTitle: '🕸️ 지식 그래프',
        }}
      />
      <Tabs.Screen
        name="email"
        options={{
          href: null,
          title: '이메일',
          headerTitle: '✉️ 이메일 브리핑',
        }}
      />
      <Tabs.Screen
        name="meeting"
        options={{
          href: null,
          title: '회의',
          headerTitle: '🗓️ 회의 노트',
        }}
      />
    </Tabs>
  );
}
