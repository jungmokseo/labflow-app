import React, { useRef, useCallback, useEffect } from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';

interface VoiceWebRTCProps {
  ephemeralToken: string;
  model: string;
  systemPrompt: string;
  voiceId: string;
  tools: Array<{ type: string; name: string; description: string; parameters: Record<string, unknown> }>;
  onTranscript: (role: 'user' | 'assistant', text: string) => void;
  onStatusChange: (status: string) => void;
  onError: (error: string) => void;
  isActive: boolean;
}

const WEBRTC_HTML = `
<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body { margin: 0; background: transparent; }</style>
</head><body><script>
let pc = null; let dc = null; let audioEl = null;
function sendToRN(type, data) { window.ReactNativeWebView.postMessage(JSON.stringify({ type, ...data })); }
async function connect(token, model, systemPrompt, voiceId, tools) {
  try {
    sendToRN('status', { status: 'WebRTC 연결 시작...' });
    pc = new RTCPeerConnection();
    audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    pc.ontrack = (e) => { audioEl.srcObject = e.streams[0]; sendToRN('status', { status: '음성 연결됨' }); };
    const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
    pc.addTrack(ms.getTracks()[0]);
    dc = pc.createDataChannel('oai-events');
    dc.onopen = () => {
      sendToRN('status', { status: '대화 준비 완료' });
      dc.send(JSON.stringify({ type: 'session.update', session: {
        modalities: ['text', 'audio'], instructions: systemPrompt, voice: voiceId,
        input_audio_transcription: { model: 'gpt-4o-mini-transcribe' },
        turn_detection: { type: 'server_vad', threshold: 0.5 }, tools: tools || [],
      }}));
    };
    dc.onmessage = (e) => { try { handleServerEvent(JSON.parse(e.data)); } catch(err) {} };
    dc.onclose = () => { sendToRN('status', { status: '연결 종료' }); sendToRN('disconnected', {}); };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const sdpResponse = await fetch('https://api.openai.com/v1/realtime?model=' + encodeURIComponent(model), {
      method: 'POST', body: offer.sdp,
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/sdp' },
    });
    if (!sdpResponse.ok) throw new Error('OpenAI SDP 응답 실패: ' + sdpResponse.status);
    const answerSdp = await sdpResponse.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    sendToRN('connected', {});
  } catch (err) { sendToRN('error', { message: err.message || 'WebRTC 연결 실패' }); }
}
let assistantTranscriptBuffer = '';
function handleServerEvent(event) {
  switch (event.type) {
    case 'conversation.item.input_audio_transcription.completed':
      if (event.transcript) sendToRN('transcript', { role: 'user', text: event.transcript.trim() }); break;
    case 'response.audio_transcript.delta':
      assistantTranscriptBuffer += (event.delta || ''); break;
    case 'response.audio_transcript.done':
      if (event.transcript) sendToRN('transcript', { role: 'assistant', text: event.transcript.trim() });
      else if (assistantTranscriptBuffer) sendToRN('transcript', { role: 'assistant', text: assistantTranscriptBuffer.trim() });
      assistantTranscriptBuffer = ''; break;
    case 'response.audio.started': case 'output_audio_buffer.speech_started':
      sendToRN('status', { status: 'AI가 말하고 있습니다...' }); break;
    case 'input_audio_buffer.speech_started':
      sendToRN('status', { status: '듣고 있습니다...' }); sendToRN('listening', { active: true }); break;
    case 'input_audio_buffer.speech_stopped':
      sendToRN('status', { status: '처리 중...' }); sendToRN('listening', { active: false }); break;
    case 'error': sendToRN('error', { message: event.error?.message || 'Unknown error' }); break;
    case 'response.function_call_arguments.done':
      sendToRN('tool_call', { name: event.name, arguments: event.arguments, callId: event.call_id }); break;
  }
}
function disconnect() { if (dc) { dc.close(); dc = null; } if (pc) { pc.close(); pc = null; } if (audioEl) { audioEl.srcObject = null; audioEl = null; } }
function sendToolResult(callId, result) {
  if (dc && dc.readyState === 'open') {
    dc.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) } }));
    dc.send(JSON.stringify({ type: 'response.create' }));
  }
}
window.addEventListener('message', (e) => { try { const msg = JSON.parse(e.data); if (msg.type === 'connect') connect(msg.token, msg.model, msg.systemPrompt, msg.voiceId, msg.tools); else if (msg.type === 'disconnect') disconnect(); else if (msg.type === 'tool_result') sendToolResult(msg.callId, msg.result); } catch(err) {} });
document.addEventListener('message', (e) => { try { const msg = JSON.parse(e.data); if (msg.type === 'connect') connect(msg.token, msg.model, msg.systemPrompt, msg.voiceId, msg.tools); else if (msg.type === 'disconnect') disconnect(); else if (msg.type === 'tool_result') sendToolResult(msg.callId, msg.result); } catch(err) {} });
<\/script></body></html>
`;
export default function VoiceWebRTC({ ephemeralToken, model, systemPrompt, voiceId, tools, onTranscript, onStatusChange, onError, isActive }: VoiceWebRTCProps) {
  const webviewRef = useRef<WebView>(null);

  useEffect(() => {
    if (isActive && ephemeralToken && webviewRef.current) {
      const connectMsg = JSON.stringify({ type: 'connect', token: ephemeralToken, model, systemPrompt, voiceId, tools });
      setTimeout(() => { webviewRef.current?.postMessage(connectMsg); }, 500);
    }
    return () => { if (webviewRef.current) webviewRef.current.postMessage(JSON.stringify({ type: 'disconnect' })); };
  }, [isActive, ephemeralToken]);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      switch (msg.type) {
        case 'transcript': onTranscript(msg.role, msg.text); break;
        case 'status': onStatusChange(msg.status); break;
        case 'error': onError(msg.message); break;
        case 'tool_call': handleToolCall(msg.name, msg.arguments, msg.callId); break;
      }
    } catch (err) {}
  }, [onTranscript, onStatusChange, onError]);

  const handleToolCall = useCallback(async (name: string, args: string, callId: string) => {
    try {
      const result = { message: `Tool ${name} executed` };
      webviewRef.current?.postMessage(JSON.stringify({ type: 'tool_result', callId, result }));
    } catch (err) {
      webviewRef.current?.postMessage(JSON.stringify({ type: 'tool_result', callId, result: { error: 'Tool execution failed' } }));
    }
  }, []);

  if (!isActive) return null;

  return (
    <View style={styles.hidden}>
      <WebView ref={webviewRef} source={{ html: WEBRTC_HTML }} originWhitelist={['*']}
        javaScriptEnabled={true} mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback={true} onMessage={handleMessage}
        {...(Platform.OS === 'android' ? { androidLayerType: 'hardware' } : {})}
        style={styles.webview} />
    </View>
  );
}

const styles = StyleSheet.create({
  hidden: { position: 'absolute', width: 0, height: 0, overflow: 'hidden' },
  webview: { width: 1, height: 1, opacity: 0 },
});
