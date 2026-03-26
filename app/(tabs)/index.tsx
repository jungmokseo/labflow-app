/**
 * 미니브레인 탭 — 3층 기억 구조 채팅
 * 첫 번째 탭으로, 앱 열면 바로 미니브레인 채팅 시작
 */

import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { colors } from '../../src/constants/theme';
import { apiClient } from '../../src/services/api-client';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

export default function BrainTab() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [channelId, setChannelId] = useState<string | null>(null);
  const flatListRef = useRef<FlatList>(null);

  const suggestions = [
    '과제 사사 문구 알려줘',
    '학생 명단 보여줘',
    '지난 미팅 요약',
    '메모 저장해줘',
  ];

  async function handleSend(text?: string) {
    const msg = (text || input).trim();
    if (!msg || loading) return;
    setInput('');

    setMessages(prev => [...prev, { id: `u-${Date.now()}`, role: 'user', content: msg }]);
    setLoading(true);

    try {
      const res = await apiClient.post('/api/brain/chat', { message: msg, channelId });
      const data = res.data as any;
      if (data.channelId && !channelId) setChannelId(data.channelId);
      setMessages(prev => [...prev, { id: `a-${Date.now()}`, role: 'assistant', content: data.response }]);
    } catch (err: any) {
      setMessages(prev => [...prev, { id: `e-${Date.now()}`, role: 'assistant', content: `오류: ${err.message}` }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView style={s.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={100}>
      {messages.length === 0 ? (
        <View style={s.empty}>
          <Text style={s.icon}>🧠</Text>
          <Text style={s.title}>Lab Memory 미니브레인</Text>
          <Text style={s.desc}>연구실 정보를 물어보세요</Text>
          <View style={s.chips}>
            {suggestions.map(q => (
              <TouchableOpacity key={q} style={s.chip} onPress={() => handleSend(q)}>
                <Text style={s.chipText}>{q}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      ) : (
        <FlatList
          ref={flatListRef}
          data={messages}
          keyExtractor={i => i.id}
          contentContainerStyle={{ padding: 16 }}
          onContentSizeChange={() => flatListRef.current?.scrollToEnd()}
          renderItem={({ item }) => (
            <View style={[s.row, item.role === 'user' && s.rowR]}>
              <View style={[s.bubble, item.role === 'user' ? s.uBub : s.aBub]}>
                <Text style={[s.msgTxt, item.role === 'user' && { color: '#fff' }]}>{item.content}</Text>
              </View>
            </View>
          )}
        />
      )}
      {loading && (
        <View style={s.loadRow}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={s.loadTxt}>생각 중...</Text>
        </View>
      )}
      <View style={s.inputRow}>
        <TextInput value={input} onChangeText={setInput} placeholder="메시지 입력..." placeholderTextColor={colors.textMuted} style={s.input} onSubmitEditing={() => handleSend()} returnKeyType="send" />
        <TouchableOpacity style={[s.sendBtn, (!input.trim() || loading) && { opacity: 0.5 }]} onPress={() => handleSend()} disabled={!input.trim() || loading}>
          <Text style={s.sendTxt}>전송</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  icon: { fontSize: 48, marginBottom: 16 },
  title: { fontSize: 20, fontWeight: '700', color: colors.text },
  desc: { fontSize: 14, color: colors.textMuted, marginTop: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', marginTop: 24, gap: 8 },
  chip: { backgroundColor: colors.bgCard, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16 },
  chipText: { color: colors.textMuted, fontSize: 12 },
  row: { marginBottom: 12 },
  rowR: { alignItems: 'flex-end' },
  bubble: { maxWidth: '80%', paddingHorizontal: 16, paddingVertical: 12, borderRadius: 18 },
  uBub: { backgroundColor: colors.primary, borderBottomRightRadius: 4 },
  aBub: { backgroundColor: colors.bgCard, borderBottomLeftRadius: 4 },
  msgTxt: { fontSize: 14, color: colors.text, lineHeight: 20 },
  loadRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingVertical: 8 },
  loadTxt: { color: colors.textMuted, fontSize: 12 },
  inputRow: { flexDirection: 'row', padding: 12, gap: 8, borderTopWidth: 0.5, borderTopColor: colors.bgInput },
  input: { flex: 1, backgroundColor: colors.bgCard, color: colors.text, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 20, fontSize: 14 },
  sendBtn: { backgroundColor: colors.primary, paddingHorizontal: 20, borderRadius: 20, justifyContent: 'center' },
  sendTxt: { color: '#fff', fontWeight: '600', fontSize: 14 },
});
