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
          title: 'ë¯¸ëë¸ë ì¸',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="bulb-outline" size={size} color={color} />
          ),
          headerTitle: 'ð§  ë¯¸ëë¸ë ì¸',
          headerTitleStyle: { fontSize: 18, fontWeight: '700' },
        }}
      />
      <Tabs.Screen
        name="brain-chat"
        options={{
          title: 'AI ì±í',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="chatbubbles-outline" size={size} color={color} />
          ),
          headerTitle: 'ð¬ AI íì¤í¸ ì±í',
          headerTitleStyle: { fontSize: 18, fontWeight: '700' },
        }}
      />
      <Tabs.Screen
        name="memo"
        options={{
          title: 'ìº¡ì²',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="flash-outline" size={size} color={color} />
          ),
          headerTitle: 'ð ë¹ ë¥¸ ìº¡ì²',
          headerTitleStyle: { fontSize: 18, fontWeight: '700' },
        }}
      />
      <Tabs.Screen
        name="paper-alerts"
        options={{
          title: 'ë¼ë¬¸',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="document-text-outline" size={size} color={color} />
          ),
          headerTitle: 'ð ë¼ë¬¸ ìë¦¼',
          headerTitleStyle: { fontSize: 18, fontWeight: '700' },
        }}
      />
      <Tabs.Screen
        name="knowledge-graph"
        options={{
          title: 'ê·¸ëí',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="git-network-outline" size={size} color={color} />
          ),
          headerTitle: 'ð¸ï¸ ì§ì ê·¸ëí',
          headerTitleStyle: { fontSize: 18, fontWeight: '700' },
        }}
      />
      <Tabs.Screen
        name="chatbot"
        options={{
          title: 'ë³´ì´ì¤',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="mic-outline" size={size} color={color} />
          ),
          headerTitle: 'ðï¸ AI ë³´ì´ì¤ ì±ë´',
          headerTitleStyle: { fontSize: 18, fontWeight: '700' },
        }}
      />
      <Tabs.Screen
        name="email"
        options={{
          title: 'ì´ë©ì¼',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="mail-outline" size={size} color={color} />
          ),
          headerTitle: 'âï¸ ì´ë©ì¼ ë¸ë¦¬í',
          headerTitleStyle: { fontSize: 18, fontWeight: '700' },
        }}
      />
      <Tabs.Screen
        name="meeting"
        options={{
          title: 'íì',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="calendar-outline" size={size} color={color} />
          ),
          headerTitle: 'ðï¸ íì ë¸í¸',
          headerTitleStyle: { fontSize: 18, fontWeight: '700' },
        }}
      />
      <Tabs.Screen
        name="onboarding"
        options={{
          title: 'ì¤ì ',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="settings-outline" size={size} color={color} />
          ),
          headerTitle: 'âï¸ ì°êµ¬ì¤ ì¤ì ',
          headerTitleStyle: { fontSize: 18, fontWeight: '700' },
        }}
      />
    </Tabs>
  );
}
