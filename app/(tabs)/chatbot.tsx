/**
 * Voice Chatbot Tab
 *
 * 두 가지 보이스챗봇 선택 화면:
 * 1. Research Discussion Bot — 논문 RAG 대화
 * 2. English Voice Tutor — 발음/문법 교정
 *
 * 선택 후 WebRTC로 OpenAI Realtime API에 연결하여 음성 대화 진행.
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActivityIndicator,
  Animated,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../../src/constants/theme';
import VoiceWebRTC from '../components/VoiceWebRTC';

// ── 타입 정의 ──────────────────────────────────────

interface VoiceOption {
  id: string;
  name: string;
  nameKo: string;
  gender: 'male' | 'female' | 'neutral';
  description: string;
  descriptionKo: string;
  tags: string[];
}

interface Persona {
  id: string;
  name: string;
  nameKo: string;
  description: string;
  defaultVoiceId: string;
  recommendedVoices: VoiceOption[];
}

interface SessionInfo {
  sessionId: string;
  persona: {
    id: string;
    name: string;
    nameKo: string;
    voiceId: string;
    toolAnnouncements: {
      searching: string;
      processing: string;
      error: string;
    };
  };
  ephemeralToken: string | null;
  config: {
    model: string;
    wsUrl: string;
  };
}

type ChatbotState = 'select' | 'connecting' | 'active' | 'error';

// ── API 베이스 URL ─────────────────────────────────

const API_BASE = __DEV__
  ? 'http://localhost:3001'
  : 'https://labflow-app-production.up.railway.app';

// ── 메인 컴포넌트 ──────────────────────────────────

export default function ChatbotScreen() {
  const [state, setState] = useState<ChatbotState>('select');
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [selectedPersona, setSelectedPersona] = useState<Persona | null>(null);
  const [selectedVoiceId, setSelectedVoiceId] = useState<string | null>(null);
  const [showVoicePicker, setShowVoicePicker] = useState(false);
  const [conversation, setConversation] = useState<Array<{
    role: 'user' | 'assistant';
    text: string;
    timestamp: Date;
  }>>([]);

  const pulseAnim = useRef(new Animated.Value(1)).current;

  // 전체 음성 목록 (하드코딩 — 서버에서도 동일 데이터)
  const ALL_VOICES: VoiceOption[] = [
    { id: 'alloy', name: 'Alloy', nameKo: '알로이', gender: 'neutral', description: 'Neutral and balanced', descriptionKo: '중성적이고 균형 잡힌 목소리', tags: [] },
    { id: 'ash', name: 'Ash', nameKo: '애쉬', gender: 'male', description: 'Soft-spoken male', descriptionKo: '부드러운 남성 음성 — 차분하고 편안함', tags: [] },
    { id: 'ballad', name: 'Ballad', nameKo: '발라드', gender: 'male', description: 'Warm male voice', descriptionKo: '따뜻한 남성 음성 — 이야기하듯 부드러움', tags: [] },
    { id: 'coral', name: 'Coral', nameKo: '코랄', gender: 'female', description: 'Warm and friendly female', descriptionKo: '따뜻하고 친근한 여성 음성', tags: ['default'] },
    { id: 'echo', name: 'Echo', nameKo: '에코', gender: 'male', description: 'Calm and composed male', descriptionKo: '차분하고 침착한 남성 음성 — 설명에 적합', tags: [] },
    { id: 'fable', name: 'Fable', nameKo: '페이블', gender: 'female', description: 'Expressive female', descriptionKo: '표현력 풍부한 여성 음성', tags: [] },
    { id: 'nova', name: 'Nova', nameKo: '노바', gender: 'female', description: 'Energetic and bright', descriptionKo: '밝고 에너지 넘치는 여성 음성', tags: [] },
    { id: 'onyx', name: 'Onyx', nameKo: '오닉스', gender: 'male', description: 'Deep authoritative male', descriptionKo: '깊고 권위 있는 남성 음성', tags: [] },
    { id: 'sage', name: 'Sage', nameKo: '세이지', gender: 'female', description: 'Wise and measured', descriptionKo: '지적이고 차분한 여성 음성', tags: [] },
    { id: 'shimmer', name: 'Shimmer', nameKo: '쉬머', gender: 'female', description: 'Light and encouraging', descriptionKo: '가볍고 격려하는 여성 음성 — 교정에 최적', tags: [] },
    { id: 'verse', name: 'Verse', nameKo: '버스', gender: 'male', description: 'Clear articulate male', descriptionKo: '또렷하고 명확한 남성 음성 — 학술 토론용', tags: [] },
  ];

  // 페르소나 목록 (추천 음성 포함)
  const personas: Persona[] = [
    {
      id: 'research-bot',
      name: 'Research Discussion Bot',
      nameKo: '연구 토론 봇',
      description: '논문에 대해 음성으로 토론하세요. RAG 기반으로 관련 논문을 검색하며 대화합니다.',
      defaultVoiceId: 'coral',
      recommendedVoices: ALL_VOICES.filter(v => ['coral', 'echo', 'sage', 'verse', 'onyx'].includes(v.id)),
    },
    {
      id: 'english-tutor',
      name: 'English Voice Tutor',
      nameKo: '영어 음성 튜터',
      description: '학술 영어 발음과 문법을 실시간으로 교정받으세요. 학회 발표 연습도 가능합니다.',
      defaultVoiceId: 'shimmer',
      recommendedVoices: ALL_VOICES.filter(v => ['shimmer', 'nova', 'fable', 'coral', 'alloy'].includes(v.id)),
    },
  ];

  const genderIcon = (g: string) => g === 'male' ? '♂' : g === 'female' ? '♀' : '◎';

  // 맥박 애니메이션 (녹음 중)
  useEffect(() => {
    if (isListening) {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.3,
            duration: 800,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 800,
            useNativeDriver: true,
          }),
        ])
      );
      pulse.start();
      return () => pulse.stop();
    } else {
      pulseAnim.setValue(1);
    }
  }, [isListening]);

  // 페르소나 선택 → 음성 선택 화면 표시
  const handlePersonaSelect = useCallback((persona: Persona) => {
    setSelectedPersona(persona);
    setSelectedVoiceId(persona.defaultVoiceId);
    setShowVoicePicker(true);
  }, []);

  // 세션 시작 (음성 선택 완료 후)
  const startSession = useCallback(async (personaId: string, voiceId?: string) => {
    setState('connecting');
    setShowVoicePicker(false);
    setStatusText('서버에 연결 중...');

    try {
      const response = await fetch(`${API_BASE}/api/voice/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personaId, voiceId }),
      });

      if (!response.ok) throw new Error('Session creation failed');

      const data: SessionInfo = await response.json();
      setSession(data);

      if (!data.ephemeralToken) {
        throw new Error('서버에 OpenAI API 키가 설정되지 않았습니다.');
      }

      setState('active');
      setStatusText(`${data.persona.nameKo}와 대화 준비 완료`);
      setConversation([]);

    } catch (err) {
      setState('error');
      setStatusText((err as Error).message);
      Alert.alert('연결 실패', (err as Error).message);
    }
  }, []);

  // 세션 종료
  const endSession = useCallback(async () => {
    if (!session) return;

    try {
      // Try new endpoint first, fallback to old one
      const endBody = JSON.stringify({
        sessionId: session.sessionId,
        personaId: session.persona.id,
      });
      const endRes = await fetch(`${API_BASE}/api/voice/end-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: endBody,
      });
      if (!endRes.ok) {
        // Fallback to old endpoint (pre-Session 18 servers)
        await fetch(`${API_BASE}/api/voice/session/end`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: endBody,
        });
      }
    } catch (err) {
      console.error('Session end error:', err);
    }

    setSession(null);
    setState('select');
    setIsListening(false);
    setConversation([]);
    setStatusText('');
  }, [session]);

  // WebRTC 콜백
  const handleTranscript = useCallback((role: 'user' | 'assistant', text: string) => {
    setConversation(prev => [...prev, { role, text, timestamp: new Date() }]);
  }, []);

  const handleStatusChange = useCallback((status: string) => {
    setStatusText(status);
    if (status === '듣고 있습니다...') {
      setIsListening(true);
    } else {
      setIsListening(false);
    }
  }, []);

  const handleVoiceError = useCallback((error: string) => {
    console.error('Voice error:', error);
    Alert.alert('음성 오류', error);
  }, []);

  // Tool call 처리 — 서버 API 호출 후 결과 반환
  const handleToolCall = useCallback(async (name: string, args: string, callId: string): Promise<any> => {
    if (!session) return { error: 'No active session' };

    try {
      const parsedArgs = JSON.parse(args);

      if (name === 'search_papers') {
        const res = await fetch(`${API_BASE}/api/voice/search-papers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: session.sessionId,
            query: parsedArgs.query,
            limit: parsedArgs.limit || 5,
            threshold: 0.3,
          }),
        });
        return await res.json();
      }

      if (name === 'get_paper_details') {
        // TODO: Implement paper details endpoint
        return { message: `Paper ${parsedArgs.paperId} details not yet implemented` };
      }

      if (name === 'save_correction') {
        const res = await fetch(`${API_BASE}/api/voice/save-correction`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: session.sessionId,
            ...parsedArgs,
          }),
        });
        return await res.json();
      }

      return { message: `Unknown tool: ${name}` };
    } catch (err) {
      console.error('Tool call error:', err);
      return { error: 'Tool execution failed' };
    }
  }, [session]);

  // 토글 녹음 (VAD 모드에서는 자동이지만, 수동 모드용으로 유지)
  const toggleListening = useCallback(() => {
    setIsListening(prev => !prev);
    if (!isListening) {
      setStatusText('듣고 있습니다...');
    } else {
      setStatusText('처리 중...');
    }
  }, [isListening]);

  // ── 렌더링 ──────────────────────────────────────

  // 페르소나 선택 화면
  if (state === 'select') {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.selectContainer}>
        <Text style={styles.title}>🎙️ AI 보이스 챗봇</Text>
        <Text style={styles.subtitle}>
          음성으로 대화할 AI를 선택하세요
        </Text>

        {!showVoicePicker ? (
          <>
            {personas.map(persona => (
              <TouchableOpacity
                key={persona.id}
                style={styles.personaCard}
                onPress={() => handlePersonaSelect(persona)}
                activeOpacity={0.7}
              >
                <View style={styles.personaIcon}>
                  <Ionicons
                    name={persona.id === 'research-bot' ? 'library-outline' : 'language-outline'}
                    size={32}
                    color={colors.primary}
                  />
                </View>
                <View style={styles.personaInfo}>
                  <Text style={styles.personaName}>{persona.nameKo}</Text>
                  <Text style={styles.personaNameEn}>{persona.name}</Text>
                  <Text style={styles.personaDesc}>{persona.description}</Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
              </TouchableOpacity>
            ))}
          </>
        ) : selectedPersona && (
          <>
            {/* 음성 선택 화면 */}
            <View style={styles.voicePickerHeader}>
              <TouchableOpacity onPress={() => setShowVoicePicker(false)}>
                <Ionicons name="arrow-back" size={22} color={colors.text} />
              </TouchableOpacity>
              <Text style={styles.voicePickerTitle}>
                🔊 {selectedPersona.nameKo} — 음성 선택
              </Text>
            </View>

            <Text style={styles.voicePickerSubtitle}>추천 음성</Text>
            {selectedPersona.recommendedVoices.map(voice => (
              <TouchableOpacity
                key={voice.id}
                style={[
                  styles.voiceCard,
                  selectedVoiceId === voice.id && styles.voiceCardSelected,
                ]}
                onPress={() => setSelectedVoiceId(voice.id)}
                activeOpacity={0.7}
              >
                <Text style={styles.voiceGender}>{genderIcon(voice.gender)}</Text>
                <View style={styles.voiceInfo}>
                  <Text style={styles.voiceName}>
                    {voice.nameKo} ({voice.name})
                    {voice.id === selectedPersona.defaultVoiceId && (
                      <Text style={styles.defaultBadge}>  기본</Text>
                    )}
                  </Text>
                  <Text style={styles.voiceDesc}>{voice.descriptionKo}</Text>
                </View>
                {selectedVoiceId === voice.id && (
                  <Ionicons name="checkmark-circle" size={22} color={colors.primary} />
                )}
              </TouchableOpacity>
            ))}

            <Text style={[styles.voicePickerSubtitle, { marginTop: 16 }]}>전체 음성</Text>
            {ALL_VOICES.filter(v => !selectedPersona.recommendedVoices.some(rv => rv.id === v.id)).map(voice => (
              <TouchableOpacity
                key={voice.id}
                style={[
                  styles.voiceCard,
                  selectedVoiceId === voice.id && styles.voiceCardSelected,
                ]}
                onPress={() => setSelectedVoiceId(voice.id)}
                activeOpacity={0.7}
              >
                <Text style={styles.voiceGender}>{genderIcon(voice.gender)}</Text>
                <View style={styles.voiceInfo}>
                  <Text style={styles.voiceName}>{voice.nameKo} ({voice.name})</Text>
                  <Text style={styles.voiceDesc}>{voice.descriptionKo}</Text>
                </View>
                {selectedVoiceId === voice.id && (
                  <Ionicons name="checkmark-circle" size={22} color={colors.primary} />
                )}
              </TouchableOpacity>
            ))}

            <TouchableOpacity
              style={styles.startButton}
              onPress={() => startSession(selectedPersona.id, selectedVoiceId || undefined)}
            >
              <Ionicons name="mic" size={20} color="#FFF" />
              <Text style={styles.startButtonText}>대화 시작</Text>
            </TouchableOpacity>
          </>
        )}

        <View style={styles.infoBox}>
          <Ionicons name="information-circle-outline" size={16} color={colors.textMuted} />
          <Text style={styles.infoText}>
            마이크 권한이 필요합니다. OpenAI Realtime API를 사용하여 실시간 음성 대화를 지원합니다.
          </Text>
        </View>
      </ScrollView>
    );
  }

  // 연결 중 화면
  if (state === 'connecting') {
    return (
      <View style={[styles.container, styles.centerContent]}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.connectingText}>{statusText}</Text>
      </View>
    );
  }

  // 에러 화면
  if (state === 'error') {
    return (
      <View style={[styles.container, styles.centerContent]}>
        <Ionicons name="alert-circle-outline" size={48} color="#EF4444" />
        <Text style={styles.errorText}>{statusText}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={() => setState('select')}>
          <Text style={styles.retryButtonText}>다시 시도</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // 활성 대화 화면
  return (
    <View style={styles.container}>
      {/* WebRTC 음성 연결 (숨겨진 WebView) */}
      {session?.ephemeralToken && (
        <VoiceWebRTC
          ephemeralToken={session.ephemeralToken}
          model={session.config.model}
          systemPrompt=""
          voiceId={session.persona.voiceId}
          tools={[]}
          onTranscript={handleTranscript}
          onStatusChange={handleStatusChange}
          onError={handleVoiceError}
          onToolCall={handleToolCall}
          isActive={state === 'active'}
        />
      )}

      {/* 헤더 */}
      <View style={styles.activeHeader}>
        <TouchableOpacity onPress={endSession} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <View>
          <Text style={styles.activeTitle}>{session?.persona.nameKo}</Text>
          <Text style={styles.activeSubtitle}>{statusText}</Text>
        </View>
        <View style={[styles.statusDot, isListening && styles.statusDotActive]} />
      </View>

      {/* 대화 로그 */}
      <ScrollView style={styles.conversationLog} contentContainerStyle={{ paddingBottom: 100 }}>
        {conversation.length === 0 && (
          <Text style={styles.emptyText}>
            아래 마이크 버튼을 눌러 대화를 시작하세요
          </Text>
        )}
        {conversation.map((msg, idx) => (
          <View key={idx} style={[
            styles.messageBubble,
            msg.role === 'user' ? styles.userBubble : styles.assistantBubble,
          ]}>
            <Text style={[
              styles.messageText,
              msg.role === 'user' ? styles.userText : styles.assistantText,
            ]}>
              {msg.text}
            </Text>
          </View>
        ))}
      </ScrollView>

      {/* 마이크 컨트롤 */}
      <View style={styles.micContainer}>
        <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
          <TouchableOpacity
            style={[styles.micButton, isListening && styles.micButtonActive]}
            onPress={toggleListening}
            activeOpacity={0.7}
          >
            <Ionicons
              name={isListening ? 'mic' : 'mic-outline'}
              size={36}
              color="#FFFFFF"
            />
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

// ── 스타일 ──────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  selectContainer: {
    padding: 20,
    paddingTop: 12,
  },
  centerContent: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: colors.textMuted,
    marginBottom: 20,
  },

  // Persona cards
  personaCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.bgInput,
  },
  personaIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: `${colors.primary}15`,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
  },
  personaInfo: {
    flex: 1,
  },
  personaName: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.text,
  },
  personaNameEn: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 1,
  },
  personaDesc: {
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: 4,
    lineHeight: 18,
  },

  // Voice picker
  voicePickerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 16,
  },
  voicePickerTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.text,
  },
  voicePickerSubtitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textMuted,
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  voiceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  voiceCardSelected: {
    borderColor: colors.primary,
    backgroundColor: `${colors.primary}08`,
  },
  voiceGender: {
    fontSize: 18,
    width: 32,
    textAlign: 'center',
    color: colors.textMuted,
  },
  voiceInfo: {
    flex: 1,
    marginLeft: 8,
  },
  voiceName: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
  },
  voiceDesc: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 2,
  },
  defaultBadge: {
    fontSize: 11,
    color: colors.primary,
    fontWeight: '500',
  },
  startButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    borderRadius: 14,
    paddingVertical: 14,
    marginTop: 16,
    marginBottom: 8,
    gap: 8,
  },
  startButtonText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '700',
  },

  // Info box
  infoBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: `${colors.primary}08`,
    borderRadius: 12,
    padding: 12,
    marginTop: 8,
    gap: 8,
  },
  infoText: {
    flex: 1,
    fontSize: 12,
    color: colors.textMuted,
    lineHeight: 17,
  },

  // Connecting
  connectingText: {
    fontSize: 16,
    color: colors.textMuted,
    marginTop: 16,
  },

  // Error
  errorText: {
    fontSize: 15,
    color: '#EF4444',
    marginTop: 12,
    textAlign: 'center',
  },
  retryButton: {
    marginTop: 20,
    paddingHorizontal: 24,
    paddingVertical: 10,
    backgroundColor: colors.primary,
    borderRadius: 8,
  },
  retryButtonText: {
    color: '#FFF',
    fontWeight: '600',
  },

  // Active session
  activeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.bgInput,
  },
  backButton: {
    marginRight: 12,
  },
  activeTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.text,
  },
  activeSubtitle: {
    fontSize: 12,
    color: colors.textMuted,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.textMuted,
    marginLeft: 'auto',
  },
  statusDotActive: {
    backgroundColor: '#22C55E',
  },

  // Conversation
  conversationLog: {
    flex: 1,
    padding: 16,
  },
  emptyText: {
    textAlign: 'center',
    color: colors.textMuted,
    fontSize: 14,
    marginTop: 40,
  },
  messageBubble: {
    maxWidth: '80%',
    borderRadius: 16,
    padding: 12,
    marginBottom: 8,
  },
  userBubble: {
    alignSelf: 'flex-end',
    backgroundColor: colors.primary,
  },
  assistantBubble: {
    alignSelf: 'flex-start',
    backgroundColor: colors.bgCard,
    borderWidth: 0.5,
    borderColor: colors.bgInput,
  },
  messageText: {
    fontSize: 15,
    lineHeight: 21,
  },
  userText: {
    color: '#FFF',
  },
  assistantText: {
    color: colors.text,
  },

  // Mic controls
  micContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
    paddingBottom: Platform.OS === 'ios' ? 36 : 20,
    gap: 20,
    backgroundColor: colors.bgCard,
    borderTopWidth: 0.5,
    borderTopColor: colors.bgInput,
  },
  micButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    ...Platform.select({
      ios: {
        shadowColor: colors.primary,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
      },
      android: {
        elevation: 8,
      },
    }),
  },
  micButtonActive: {
    backgroundColor: '#EF4444',
  },
  endCallButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    backgroundColor: '#FEE2E2',
    gap: 4,
  },
  endCallText: {
    color: '#EF4444',
    fontWeight: '600',
    fontSize: 13,
  },
});
