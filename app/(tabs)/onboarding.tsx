import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, borderRadius } from '../../src/constants/theme';

const API_BASE = __DEV__
  ? 'http://localhost:3001'
  : 'https://labflow-app-production.up.railway.app';

const HEADERS = {
  'Content-Type': 'application/json',
  'X-Dev-User-Id': 'dev-user-seo',
};

export default function OnboardingScreen() {
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);

  // Form state
  const [labName, setLabName] = useState('');
  const [university, setUniversity] = useState('');
  const [department, setDepartment] = useState('');
  const [piName, setPiName] = useState('');
  const [researchAreas, setResearchAreas] = useState('');
  const [seedPaperDoi, setSeedPaperDoi] = useState('');
  const [memberNames, setMemberNames] = useState('');

  const [completed, setCompleted] = useState(false);

  const steps = [
    { title: 'ì°êµ¬ì¤ ì ë³´', icon: 'flask-outline' as const },
    { title: 'ì°êµ¬ ë¶ì¼', icon: 'book-outline' as const },
    { title: 'ìë ë¼ë¬¸', icon: 'document-text-outline' as const },
    { title: 'ë©¤ë² ë±ë¡', icon: 'people-outline' as const },
  ];

  const canNext = () => {
    switch (step) {
      case 0:
        return labName.trim() && university.trim();
      case 1:
        return researchAreas.trim();
      case 2:
        return true; // seed paper is optional
      case 3:
        return true; // members optional
      default:
        return false;
    }
  };

  const submitOnboarding = async () => {
    setLoading(true);
    try {
      // Step 1: Create lab profile
      const onboardRes = await fetch(`${API_BASE}/api/lab/onboarding`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({
          labName: labName.trim(),
          university: university.trim(),
          department: department.trim(),
          piName: piName.trim(),
          researchAreas: researchAreas
            .split(',')
            .map((a) => a.trim())
            .filter(Boolean),
        }),
      });

      if (!onboardRes.ok) {
        const err = await onboardRes.json();
        throw new Error(err.error || 'ì¨ë³´ë© ì¤í¨');
      }

      // Step 2: Seed paper (optional)
      if (seedPaperDoi.trim()) {
        try {
          await fetch(`${API_BASE}/api/lab/seed-paper`, {
            method: 'POST',
            headers: HEADERS,
            body: JSON.stringify({ doi: seedPaperDoi.trim() }),
          });
        } catch {
          // non-critical, continue
        }
      }

      setCompleted(true);
    } catch (err: any) {
      Alert.alert('ì¤ë¥', err.message);
    } finally {
      setLoading(false);
    }
  };

  if (completed) {
    return (
      <View style={styles.completedContainer}>
        <View style={styles.checkCircle}>
          <Ionicons name="checkmark" size={48} color={colors.white} />
        </View>
        <Text style={styles.completedTitle}>ì¤ì  ìë£! ð</Text>
        <Text style={styles.completedSubtitle}>
          {labName} ì°êµ¬ì¤ì´ ë±ë¡ëììµëë¤.{'\n'}
          ì´ì  LabFlowì ëª¨ë  ê¸°ë¥ì ì¬ì©í  ì ììµëë¤.
        </Text>
        <View style={styles.featureList}>
          {[
            { icon: 'ð§ ', text: 'ë¯¸ëë¸ë ì¸ AI ì±í' },
            { icon: 'ð', text: 'ë¹ ë¥¸ ìº¡ì² & ìë ë¶ë¥' },
            { icon: 'ð', text: 'ë¼ë¬¸ ìë¦¼ ëª¨ëí°ë§' },
            { icon: 'ð¸ï¸', text: 'ì§ì ê·¸ëí ìë êµ¬ì¶' },
            { icon: 'ðï¸', text: 'AI ë³´ì´ì¤ ì±ë´' },
          ].map((f, i) => (
            <View key={i} style={styles.featureRow}>
              <Text style={styles.featureIcon}>{f.icon}</Text>
              <Text style={styles.featureText}>{f.text}</Text>
            </View>
          ))}
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      {/* Progress */}
      <View style={styles.progressBar}>
        {steps.map((s, i) => (
          <View key={i} style={styles.progressStep}>
            <View
              style={[
                styles.progressDot,
                i <= step ? styles.progressDotActive : {},
              ]}
            >
              <Ionicons
                name={s.icon}
                size={16}
                color={i <= step ? colors.white : colors.textMuted}
              />
            </View>
            <Text
              style={[
                styles.progressLabel,
                i <= step && styles.progressLabelActive,
              ]}
            >
              {s.title}
            </Text>
          </View>
        ))}
      </View>

      <ScrollView
        contentContainerStyle={styles.formContainer}
        keyboardShouldPersistTaps="handled"
      >
        {step === 0 && (
          <>
            <Text style={styles.stepTitle}>ì°êµ¬ì¤ ê¸°ë³¸ ì ë³´</Text>
            <Text style={styles.stepDesc}>
              ì°êµ¬ì¤ íë¡íì ì¤ì í©ëë¤. ì´ ì ë³´ë AIê° ë§¥ë½ì ì´í´íë ë° ì¬ì©ë©ëë¤.
            </Text>
            <Text style={styles.label}>ì°êµ¬ì¤ ì´ë¦ *</Text>
            <TextInput
              style={styles.input}
              value={labName}
              onChangeText={setLabName}
              placeholder="ì: BLISS Lab"
              placeholderTextColor={colors.textMuted}
            />
            <Text style={styles.label}>ëíêµ *</Text>
            <TextInput
              style={styles.input}
              value={university}
              onChangeText={setUniversity}
              placeholder="ì: ì°ì¸ëíêµ"
              placeholderTextColor={colors.textMuted}
            />
            <Text style={styles.label}>íê³¼</Text>
            <TextInput
              style={styles.input}
              value={department}
              onChangeText={setDepartment}
              placeholder="ì: ì ìì¬ê³µíê³¼"
              placeholderTextColor={colors.textMuted}
            />
            <Text style={styles.label}>PI (ì§ëêµì) ì´ë¦</Text>
            <TextInput
              style={styles.input}
              value={piName}
              onChangeText={setPiName}
              placeholder="ì: ìì ëª©"
              placeholderTextColor={colors.textMuted}
            />
          </>
        )}

        {step === 1 && (
          <>
            <Text style={styles.stepTitle}>ì°êµ¬ ë¶ì¼</Text>
            <Text style={styles.stepDesc}>
              ì°êµ¬ ë¶ì¼ë¥¼ ì¼íë¡ êµ¬ë¶í´ì ìë ¥í´ì£¼ì¸ì. ë¼ë¬¸ ê²ì ë° AI ë§ì¶¤íì ì¬ì©ë©ëë¤.
            </Text>
            <Text style={styles.label}>ì£¼ì ì°êµ¬ ë¶ì¼ *</Text>
            <TextInput
              style={[styles.input, styles.inputMultiline]}
              value={researchAreas}
              onChangeText={setResearchAreas}
              placeholder="ì: flexible electronics, biosensor, hydrogel, wearable device"
              placeholderTextColor={colors.textMuted}
              multiline
              numberOfLines={3}
            />
          </>
        )}

        {step === 2 && (
          <>
            <Text style={styles.stepTitle}>ìë ë¸ë¬¸ (ì í)</Text>
            <Text style={styles.stepDesc}>
              ëí ë¼ë¬¸ì DOIë¥¼ ìë ¥íë©´ ì§ì ê·¸ëíì ì´ê¸° ìë ë°ì´í°ë¡ íì©ë©ëë¤.
            </Text>
            <Text style={styles.label}>DOI</Text>
            <TextInput
              style={styles.input}
              value={seedPaperDoi}
              onChangeText={setSeedPaperDoi}
              placeholder="ì: 10.1038/s41586-024-00001-1"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
            />
          </>
        )}

        {step === 3 && (
          <>
            <Text style={styles.stepTitle}>ë©¤ë² ë±ë¡ (ì í)</Text>
            <Text style={styles.stepDesc}>
              ì°êµ¬ì¤ ë©¤ë² ì´ë¦ì ì¼íë¡ êµ¬ë¶í´ì ìë ¥íì¸ì. ëì¤ì ì¶ê°í  ìë ììµëë¤.
            </Text>
            <Text style={styles.label}>ë©¤ë² ì´ë¦</Text>
            <TextInput
              style={[styles.input, styles.inputMultiline]}
              value={memberNames}
              onChangeText={setMemberNames}
              placeholder="ì: ê¹ì² ì, ì´ìí¬, ë°ë¯¼ì"
              placeholderTextColor={colors.textMuted}
              multiline
            />
          </>
        )}
      </ScrollView>

      {/* Bottom Navigation */}
      <View style={styles.bottomBar}>
        {step > 0 && (
          <TouchableOpacity
            style={styles.backBtn}
            onPress={() => setStep(step - 1)}
          >
            <Ionicons name="chevron-back" size={20} color={colors.textSecondary} />
            <Text style={styles.backText}>ì´ì </Text>
          </TouchableOpacity>
        )}
        <View style={{ flex: 1 }} />
        {step < 3 ? (
          <TouchableOpacity
            style={[styles.nextBtn, !canNext() && styles.btnDisabled]}
            onPress={() => setStep(step + 1)}
            disabled={!canNext()}
          >
            <Text style={styles.nextText}>ë¤ì</Text>
            <Ionicons name="chevron-forward" size={20} color={colors.white} />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={styles.submitBtn}
            onPress={submitOnboarding}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color={colors.white} />
            ) : (
              <>
                <Text style={styles.nextText}>ìë£</Text>
                <Ionicons name="checkmark" size={20} color={colors.white} />
              </>
            )}
          </TouchableOpacity>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  progressBar: {
    flexDirection: 'row',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.lg,
    justifyContent: 'space-between',
  },
  progressStep: { alignItems: 'center', gap: 4 },
  progressDot: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.bgInput,
    justifyContent: 'center',
    alignItems: 'center',
  },
  progressDotActive: { backgroundColor: colors.primary },
  progressLabel: { fontSize: fontSize.xs, color: colors.textMuted },
  progressLabelActive: { color: colors.primary, fontWeight: '600' },
  formContainer: { padding: spacing.xl, paddingBottom: 120 },
  stepTitle: { fontSize: fontSize.xl, fontWeight: '800', color: colors.text },
  stepDesc: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    marginTop: spacing.sm,
    marginBottom: spacing.xl,
    lineHeight: 20,
  },
  label: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    marginBottom: 4,
    marginTop: spacing.lg,
  },
  input: {
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.md,
    padding: spacing.lg,
    fontSize: fontSize.md,
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.bgInput,
  },
  inputMultiline: { minHeight: 80, textAlignVertical: 'top' },
  bottomBar: {
    flexDirection: 'row',
    padding: spacing.lg,
    paddingBottom: Platform.OS === 'ios' ? spacing.xxl : spacing.lg,
    backgroundColor: colors.bgCard,
    borderTopWidth: 0.5,
    borderTopColor: colors.bgInput,
    alignItems: 'center',
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  backText: { fontSize: fontSize.md, color: colors.textSecondary },
  nextBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: borderRadius.md,
  },
  submitBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.success,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: borderRadius.md,
  },
  btnDisabled: { opacity: 0.4 },
  nextText: { fontSize: fontSize.md, fontWeight: '700', color: colors.white },
  completedContainer: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
  },
  checkCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: colors.success,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.xl,
  },
  completedTitle: { fontSize: fontSize.xxl, fontWeight: '800', color: colors.text },
  completedSubtitle: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    textAlign: 'center',
    marginTop: spacing.md,
    lineHeight: 24,
  },
  featureList: { marginTop: spacing.xxl, gap: spacing.md, width: '100%' },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.bgCard,
    padding: spacing.lg,
    borderRadius: borderRadius.md,
  },
  featureIcon: { fontSize: 24 },
  featureText: { fontSize: fontSize.md, color: colors.text, fontWeight: '500' },
});
