import React, { useState, useRef, useCallback, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert, ActivityIndicator, Animated, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../../src/constants/theme';
import VoiceWebRTC from '../components/VoiceWebRTC';

interface Persona { id: string; name: string; nameKo: string; description: string; }
interface SessionInfo {
  sessionId: string;
  persona: { id: string; name: string; nameKo: string; voiceId: string; toolAnnouncements: { searching: string; processing: string; error: string; }; };
  ephemeralToken: string | null;
  config: { model: string; wsUrl: string; };
}
type ChatbotState = 'select' | 'connecting' | 'active' | 'error';

const API_BASE = __DEV__ ? 'http://localhost:3001' : 'https://labflow-api.onrender.com';

export default function ChatbotScreen() {
  const [state, setState] = useState<ChatbotState>('select');
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [conversation, setConversation] = useState<Array<{ role: 'user' | 'assistant'; text: string; timestamp: Date; }>>([]);
  const pulseAnim = useRef(new Animated.Value(1)).current;

  const personas: Persona[] = [
    { id: 'research-bot', name: 'Research Discussion Bot', nameKo: '연구 토론 봇', description: '논문에 대해 음성으로 토론하세요. RAG 기반으로 관련 논문을 검색하며 대화합니다.' },
    { id: 'english-tutor', name: 'English Voice Tutor', nameKo: '영어 음성 튜터', description: '학술 영어 발음과 문법을 실시간으로 교정받으세요. 학회 발표 연습도 가능합니다.' },
  ];
  useEffect(() => {
    if (isListening) {
      const pulse = Animated.loop(Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.3, duration: 800, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
      ]));
      pulse.start();
      return () => pulse.stop();
    } else { pulseAnim.setValue(1); }
  }, [isListening]);

  const startSession = useCallback(async (personaId: string) => {
    setState('connecting'); setStatusText('서버에 연결 중...');
    try {
      const response = await fetch(`${API_BASE}/api/voice/session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personaId }),
      });
      if (!response.ok) throw new Error('Session creation failed');
      const data: SessionInfo = await response.json();
      setSession(data);
      if (!data.ephemeralToken) throw new Error('서버에 OpenAI API 키가 설정되지 않았습니다.');
      setState('active'); setStatusText(`${data.persona.nameKo}와 대화 준비 완료`); setConversation([]);
    } catch (err) { setState('error'); setStatusText((err as Error).message); Alert.alert('연결 실패', (err as Error).message); }
  }, []);

  const endSession = useCallback(async () => {
    if (!session) return;
    try { await fetch(`${API_BASE}/api/voice/session/end`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: session.sessionId, personaId: session.persona.id }) }); } catch (err) { console.error('Session end error:', err); }
    setSession(null); setState('select'); setIsListening(false); setConversation([]); setStatusText('');
  }, [session]);

  const handleTranscript = useCallback((role: 'user' | 'assistant', text: string) => {
    setConversation(prev => [...prev, { role, text, timestamp: new Date() }]);
  }, []);
  const handleStatusChange = useCallback((status: string) => {
    setStatusText(status); setIsListening(status === '듣고 있습니다...');
  }, []);
  const handleVoiceError = useCallback((error: string) => { console.error('Voice error:', error); Alert.alert('음성 오류', error); }, []);
  const toggleListening = useCallback(() => {
    setIsListening(prev => !prev);
    if (!isListening) setStatusText('듣고 있습니다...'); else setStatusText('처리 중...');
  }, [isListening]);
  if (state === 'select') {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.selectContainer}>
        <Text style={styles.title}>🎙️ AI 보이스 챗봇</Text>
        <Text style={styles.subtitle}>음성으로 대화할 AI를 선택하세요</Text>
        {personas.map(persona => (
          <TouchableOpacity key={persona.id} style={styles.personaCard} onPress={() => startSession(persona.id)} activeOpacity={0.7}>
            <View style={styles.personaIcon}>
              <Ionicons name={persona.id === 'research-bot' ? 'library-outline' : 'language-outline'} size={32} color={colors.primary} />
            </View>
            <View style={styles.personaInfo}>
              <Text style={styles.personaName}>{persona.nameKo}</Text>
              <Text style={styles.personaNameEn}>{persona.name}</Text>
              <Text style={styles.personaDesc}>{persona.description}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
          </TouchableOpacity>
        ))}
        <View style={styles.infoBox}>
          <Ionicons name="information-circle-outline" size={16} color={colors.textMuted} />
          <Text style={styles.infoText}>마이크 권한이 필요합니다. OpenAI Realtime API를 사용하여 실시간 음성 대화를 지원합니다.</Text>
        </View>
      </ScrollView>
    );
  }

  if (state === 'connecting') {
    return (<View style={[styles.container, styles.centerContent]}><ActivityIndicator size="large" color={colors.primary} /><Text style={styles.connectingText}>{statusText}</Text></View>);
  }
  if (state === 'error') {
    return (<View style={[styles.container, styles.centerContent]}><Ionicons name="alert-circle-outline" size={48} color="#EF4444" /><Text style={styles.errorText}>{statusText}</Text><TouchableOpacity style={styles.retryButton} onPress={() => setState('select')}><Text style={styles.retryButtonText}>다시 시도</Text></TouchableOpacity></View>);
  }
  return (
    <View style={styles.container}>
      {session?.ephemeralToken && (
        <VoiceWebRTC ephemeralToken={session.ephemeralToken} model={session.config.model}
          systemPrompt="" voiceId={session.persona.voiceId} tools={[]}
          onTranscript={handleTranscript} onStatusChange={handleStatusChange}
          onError={handleVoiceError} isActive={state === 'active'} />
      )}
      <View style={styles.activeHeader}>
        <TouchableOpacity onPress={endSession} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <View><Text style={styles.activeTitle}>{session?.persona.nameKo}</Text><Text style={styles.activeSubtitle}>{statusText}</Text></View>
        <View style={[styles.statusDot, isListening && styles.statusDotActive]} />
      </View>
      <ScrollView style={styles.conversationLog} contentContainerStyle={{ paddingBottom: 100 }}>
        {conversation.length === 0 && (<Text style={styles.emptyText}>아래 마이크 버튼을 눌러 대화를 시작하세요</Text>)}
        {conversation.map((msg, idx) => (
          <View key={idx} style={[styles.messageBubble, msg.role === 'user' ? styles.userBubble : styles.assistantBubble]}>
            <Text style={[styles.messageText, msg.role === 'user' ? styles.userText : styles.assistantText]}>{msg.text}</Text>
          </View>
        ))}
      </ScrollView>
      <View style={styles.micContainer}>
        <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
          <TouchableOpacity style={[styles.micButton, isListening && styles.micButtonActive]} onPress={toggleListening} activeOpacity={0.7}>
            <Ionicons name={isListening ? 'mic' : 'mic-outline'} size={36} color="#FFFFFF" />
          </TouchableOpacity>
        </Animated.View>
        <TouchableOpacity style={styles.endCallButton} onPress={endSession}>
          <Ionicons name="call-outline" size={20} color="#EF4444" />
          <Text style={styles.endCallText}>종료</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  selectContainer: { padding: 20, paddingTop: 12 },
  centerContent: { justifyContent: 'center', alignItems: 'center', padding: 20 },
  title: { fontSize: 24, fontWeight: '700', color: colors.text, marginBottom: 4 },
  subtitle: { fontSize: 14, color: colors.textMuted, marginBottom: 20 },
  personaCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.bgCard, borderRadius: 16, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: colors.bgInput },
  personaIcon: { width: 56, height: 56, borderRadius: 28, backgroundColor: `${colors.primary}15`, justifyContent: 'center', alignItems: 'center', marginRight: 14 },
  personaInfo: { flex: 1 },
  personaName: { fontSize: 17, fontWeight: '700', color: colors.text },
  personaNameEn: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
  personaDesc: { fontSize: 13, color: colors.textSecondary, marginTop: 4, lineHeight: 18 },
  infoBox: { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: `${colors.primary}08`, borderRadius: 12, padding: 12, marginTop: 8, gap: 8 },
  infoText: { flex: 1, fontSize: 12, color: colors.textMuted, lineHeight: 17 },
  connectingText: { fontSize: 16, color: colors.textMuted, marginTop: 16 },
  errorText: { fontSize: 15, color: '#EF4444', marginTop: 12, textAlign: 'center' },
  retryButton: { marginTop: 20, paddingHorizontal: 24, paddingVertical: 10, backgroundColor: colors.primary, borderRadius: 8 },
  retryButtonText: { color: '#FFF', fontWeight: '600' },
  activeHeader: { flexDirection: 'row', alignItems: 'center', padding: 16, borderBottomWidth: 0.5, borderBottomColor: colors.bgInput },
  backButton: { marginRight: 12 },
  activeTitle: { fontSize: 17, fontWeight: '700', color: colors.text },
  activeSubtitle: { fontSize: 12, color: colors.textMuted },
  statusDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.textMuted, marginLeft: 'auto' },
  statusDotActive: { backgroundColor: '#22C55E' },
  conversationLog: { flex: 1, padding: 16 },
  emptyText: { textAlign: 'center', color: colors.textMuted, fontSize: 14, marginTop: 40 },
  messageBubble: { maxWidth: '80%', borderRadius: 16, padding: 12, marginBottom: 8 },
  userBubble: { alignSelf: 'flex-end', backgroundColor: colors.primary },
  assistantBubble: { alignSelf: 'flex-start', backgroundColor: colors.bgCard, borderWidth: 0.5, borderColor: colors.bgInput },
  messageText: { fontSize: 15, lineHeight: 21 },
  userText: { color: '#FFF' },
  assistantText: { color: colors.text },
  micContainer: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', padding: 20, paddingBottom: Platform.OS === 'ios' ? 36 : 20, gap: 20, backgroundColor: colors.bgCard, borderTopWidth: 0.5, borderTopColor: colors.bgInput },
  micButton: { width: 72, height: 72, borderRadius: 36, backgroundColor: colors.primary, justifyContent: 'center', alignItems: 'center', ...Platform.select({ ios: { shadowColor: colors.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8 }, android: { elevation: 8 } }) },
  micButtonActive: { backgroundColor: '#EF4444' },
  endCallButton: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 20, backgroundColor: '#FEE2E2', gap: 4 },
  endCallText: { color: '#EF4444', fontWeight: '600', fontSize: 13 },
});
