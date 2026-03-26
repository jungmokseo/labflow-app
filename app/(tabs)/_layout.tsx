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
      <Tabs.Screen
        name="index"
        options={{
          title: '미니브레인',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="bulb-outline" size={size} color={color} />
          ),
          headerTitle: '🧠 미니브레인',
          headerTitleStyle: { fontSize: 18, fontWeight: '700' },
        }}
      />
      <Tabs.Screen
        name="memo"
        options={{
          title: '캡처',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="flash-outline" size={size} color={color} />
          ),
          headerTitle: '📝 빠른 캡처',
          headerTitleStyle: { fontSize: 18, fontWeight: '700' },
        }}
      />
      <Tabs.Screen
        name="email"
        options={{
          title: '이메일',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="mail-outline" size={size} color={color} />
          ),
          headerTitle: '✉️ 이메일 브리핑',
          headerTitleStyle: { fontSize: 18, fontWeight: '700' },
        }}
      />
      <Tabs.Screen
        name="meeting"
        options={{
          title: '회의',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="mic-outline" size={size} color={color} />
          ),
          headerTitle: '🎙️ 회의 노트',
          headerTitleStyle: { fontSize: 18, fontWeight: '700' },
        }}
      />
      <Tabs.Screen
        name="chatbot"
        options={{
          title: 'AI 챗봇',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="chatbubble-ellipses-outline" size={size} color={color} />
          ),
          headerTitle: '🎙️ AI 보이스 챗봇',
          headerTitleStyle: { fontSize: 18, fontWeight: '700' },
        }}
      />
    </Tabs>
  );
}
