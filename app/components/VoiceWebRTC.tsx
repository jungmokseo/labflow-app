/**
 * VoiceWebRTC — WebView 기반 OpenAI Realtime API WebRTC 연결
 *
 * React Native에서 WebRTC를 직접 사용하려면 react-native-webrtc 네이티브 모듈이 필요하지만,
 * Expo 환경에서는 WebView 내부의 브라우저 WebRTC를 활용하는 것이 가장 실용적인 MVP 접근법입니다.
 *
 * 동작 방식:
 * 1. WebView에 최소한의 HTML을 로드 (WebRTC + OpenAI Realtime API 연결)
 * 2. ephemeral token을 WebView에 postMessage로 전달
 * 3. WebView에서 음성 인식/합성 후 결과를 다시 postMessage로 전달
 * 4. React Native에서 UI 업데이트
 */

import React, { useRef, useCallback, useEffect } from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';

interface VoiceWebRTCProps {
  ephemeralToken: string;
  model: string;
  systemPrompt: string;
  voiceId: string;
  tools: Array<{
    type: string;
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
  onTranscript: (role: 'user' | 'assistant', text: string) => void;
  onStatusChange: (status: string) => void;
  onError: (error: string) => void;
  onToolCall?: (name: string, args: string, callId: string) => Promise<any>;
  isActive: boolean;
}

const WEBRTC_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>body { margin: 0; background: transparent; }</style>
</head>
<body>
<script>
  let pc = null;
  let dc = null;
  let audioEl = null;

  function sendToRN(type, data) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type, ...data }));
  }

  async function connect(token, model, systemPrompt, voiceId, tools) {
    try {
      sendToRN('status', { status: 'WebRTC 연결 시작...' });

      // 1. RTCPeerConnection 생성
      pc = new RTCPeerConnection();

      // 2. 오디오 출력 설정
      audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      pc.ontrack = (e) => {
        audioEl.srcObject = e.streams[0];
        sendToRN('status', { status: '음성 연결됨' });
      };

      // 3. 마이크 입력 추가
      const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
      pc.addTrack(ms.getTracks()[0]);

      // 4. Data Channel (이벤트 수신)
      dc = pc.createDataChannel('oai-events');
      dc.onopen = () => {
        sendToRN('status', { status: '대화 준비 완료' });
        // 세션 설정 전송
        dc.send(JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text', 'audio'],
            instructions: systemPrompt,
            voice: voiceId,
            input_audio_transcription: { model: 'gpt-4o-mini-transcribe' },
            turn_detection: { type: 'server_vad', threshold: 0.5 },
            tools: tools || [],
          },
        }));
      };

      dc.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          handleServerEvent(event);
        } catch (err) {
          // ignore parse errors
        }
      };

      dc.onclose = () => {
        sendToRN('status', { status: '연결 종료' });
        sendToRN('disconnected', {});
      };

      // 5. SDP Offer 생성 및 OpenAI에 전송
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const baseUrl = 'https://api.openai.com/v1/realtime';
      const sdpResponse = await fetch(baseUrl + '?model=' + encodeURIComponent(model), {
        method: 'POST',
        body: offer.sdp,
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/sdp',
        },
      });

      if (!sdpResponse.ok) {
        throw new Error('OpenAI SDP 응답 실패: ' + sdpResponse.status);
      }

      const answerSdp = await sdpResponse.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

      sendToRN('connected', {});
    } catch (err) {
      sendToRN('error', { message: err.message || 'WebRTC 연결 실패' });
    }
  }

  // 사용자/어시스턴트 발화 누적 버퍼
  let userTranscriptBuffer = '';
  let assistantTranscriptBuffer = '';

  function handleServerEvent(event) {
    switch (event.type) {
      // 사용자 음성 텍스트 (실시간)
      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript) {
          sendToRN('transcript', { role: 'user', text: event.transcript.trim() });
        }
        break;

      // 어시스턴트 텍스트 응답 (실시간 델타)
      case 'response.audio_transcript.delta':
        assistantTranscriptBuffer += (event.delta || '');
        break;

      // 어시스턴트 텍스트 응답 완료
      case 'response.audio_transcript.done':
        if (event.transcript) {
          sendToRN('transcript', { role: 'assistant', text: event.transcript.trim() });
        } else if (assistantTranscriptBuffer) {
          sendToRN('transcript', { role: 'assistant', text: assistantTranscriptBuffer.trim() });
        }
        assistantTranscriptBuffer = '';
        break;

      // 어시스턴트가 말하기 시작
      case 'response.audio.started':
      case 'output_audio_buffer.speech_started':
        sendToRN('status', { status: 'AI가 말하고 있습니다...' });
        break;

      // 사용자가 말하기 시작 (VAD)
      case 'input_audio_buffer.speech_started':
        sendToRN('status', { status: '듣고 있습니다...' });
        sendToRN('listening', { active: true });
        break;

      // 사용자 말하기 끝
      case 'input_audio_buffer.speech_stopped':
        sendToRN('status', { status: '처리 중...' });
        sendToRN('listening', { active: false });
        break;

      // 에러
      case 'error':
        sendToRN('error', { message: event.error?.message || 'Unknown error' });
        break;

      // Tool call (function calling)
      case 'response.function_call_arguments.done':
        sendToRN('tool_call', {
          name: event.name,
          arguments: event.arguments,
          callId: event.call_id,
        });
        break;

      default:
        break;
    }
  }

  function disconnect() {
    if (dc) { dc.close(); dc = null; }
    if (pc) { pc.close(); pc = null; }
    if (audioEl) { audioEl.srcObject = null; audioEl = null; }
  }

  // Tool 결과를 OpenAI에 전달
  function sendToolResult(callId, result) {
    if (dc && dc.readyState === 'open') {
      dc.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify(result),
        },
      }));
      dc.send(JSON.stringify({ type: 'response.create' }));
    }
  }

  // React Native에서 메시지 수신
  window.addEventListener('message', (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'connect') {
        connect(msg.token, msg.model, msg.systemPrompt, msg.voiceId, msg.tools);
      } else if (msg.type === 'disconnect') {
        disconnect();
      } else if (msg.type === 'tool_result') {
        sendToolResult(msg.callId, msg.result);
      }
    } catch (err) {}
  });

  // Android 호환
  document.addEventListener('message', (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'connect') {
        connect(msg.token, msg.model, msg.systemPrompt, msg.voiceId, msg.tools);
      } else if (msg.type === 'disconnect') {
        disconnect();
      } else if (msg.type === 'tool_result') {
        sendToolResult(msg.callId, msg.result);
      }
    } catch (err) {}
  });
</script>
</body>
</html>
`;

export default function VoiceWebRTC({
  ephemeralToken,
  model,
  systemPrompt,
  voiceId,
  tools,
  onTranscript,
  onStatusChange,
  onError,
  onToolCall,
  isActive,
}: VoiceWebRTCProps) {
  const webviewRef = useRef<WebView>(null);

  // WebRTC 연결 시작
  useEffect(() => {
    if (isActive && ephemeralToken && webviewRef.current) {
      const connectMsg = JSON.stringify({
        type: 'connect',
        token: ephemeralToken,
        model,
        systemPrompt,
        voiceId,
        tools,
      });
      // 약간의 딜레이 후 전송 (WebView 로드 완료 대기)
      setTimeout(() => {
        webviewRef.current?.postMessage(connectMsg);
      }, 500);
    }

    return () => {
      if (webviewRef.current) {
        webviewRef.current.postMessage(JSON.stringify({ type: 'disconnect' }));
      }
    };
  }, [isActive, ephemeralToken]);

  // WebView에서 메시지 수신
  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);

      switch (msg.type) {
        case 'transcript':
          onTranscript(msg.role, msg.text);
          break;
        case 'status':
          onStatusChange(msg.status);
          break;
        case 'error':
          onError(msg.message);
          break;
        case 'listening':
          // 마이크 상태 변경은 부모 컴포넌트에서 처리
          break;
        case 'tool_call':
          handleToolCallInternal(msg.name, msg.arguments, msg.callId);
          break;
        default:
          break;
      }
    } catch (err) {
      // ignore
    }
  }, [onTranscript, onStatusChange, onError]);

  // Tool call 처리 — 부모 컴포넌트의 onToolCall 콜백 사용
  const handleToolCallInternal = useCallback(async (name: string, args: string, callId: string) => {
    try {
      let result;
      if (onToolCall) {
        result = await onToolCall(name, args, callId);
      } else {
        result = { message: `Tool ${name} executed (no handler)` };
      }
      webviewRef.current?.postMessage(JSON.stringify({
        type: 'tool_result',
        callId,
        result,
      }));
    } catch (err) {
      webviewRef.current?.postMessage(JSON.stringify({
        type: 'tool_result',
        callId,
        result: { error: 'Tool execution failed' },
      }));
    }
  }, [onToolCall]);

  if (!isActive) return null;

  return (
    <View style={styles.hidden}>
      <WebView
        ref={webviewRef}
        source={{ html: WEBRTC_HTML }}
        originWhitelist={['*']}
        javaScriptEnabled={true}
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback={true}
        onMessage={handleMessage}
        // 마이크 권한 허용
        {...(Platform.OS === 'android' ? {
          androidLayerType: 'hardware',
        } : {})}
        style={styles.webview}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  hidden: {
    position: 'absolute',
    width: 0,
    height: 0,
    overflow: 'hidden',
  },
  webview: {
    width: 1,
    height: 1,
    opacity: 0,
  },
});
