import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { sketchTheme } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';

export default function ProfileScreen() {
  const { isAuthenticated, isHydrating, signIn, signOut } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleLogin() {
    if (!username.trim() || !password.trim()) {
      setFeedback('请输入账号和密码。');
      return;
    }

    setIsSubmitting(true);
    setFeedback(null);

    try {
      await signIn({
        password,
        username: username.trim(),
      });
      setPassword('');
      setFeedback('登录成功。');
    } catch (error) {
      setFeedback(getErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleLogout() {
    setIsSubmitting(true);
    setFeedback(null);

    try {
      await signOut();
      setFeedback('已退出登录。');
    } catch (error) {
      setFeedback(getErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <SafeAreaView edges={['top']} style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <View pointerEvents="none" style={[styles.doodleCircle, styles.doodleCircleTop]} />
        <View pointerEvents="none" style={[styles.doodleCircle, styles.doodleCircleBottom]} />
        <View pointerEvents="none" style={styles.dashedLoop} />

        <View style={[styles.card, styles.heroCard]}>
          <View style={styles.pin} />
          <View style={styles.tapeStrip} />
          <Text style={styles.label}>账户中心</Text>
          <Text style={styles.title}>个人中心</Text>
          <Text style={styles.note}>
            登录后会自动保留当前状态，方便你继续咨询训练问题，也能随时查看已生成的训练计划。
          </Text>
        </View>

        <View style={[styles.card, styles.statusCard]}>
          <Text style={styles.sectionTitle}>登录状态</Text>
          <Text style={styles.statusText}>
            {isHydrating ? '正在恢复登录状态...' : isAuthenticated ? '已登录' : '未登录'}
          </Text>
          <Text style={styles.metaText}>登录后会自动保存状态，下次打开也能继续使用。</Text>
          <Text style={styles.metaText}>生成的训练建议会自动同步到训练页。</Text>
        </View>

        <View style={[styles.card, styles.formCard]}>
          <Text style={styles.sectionTitle}>{isAuthenticated ? '当前状态' : '账号登录'}</Text>

          {isAuthenticated ? (
            <>
              <Text style={styles.formNote}>
                你已经登录，可以继续咨询训练与饮食问题，生成的计划也会自动同步到训练页。
              </Text>

              <Pressable
                disabled={isSubmitting}
                onPress={handleLogout}
                style={({ pressed }) => [
                  styles.button,
                  styles.secondaryButton,
                  pressed && styles.buttonPressed,
                  isSubmitting && styles.buttonDisabled,
                ]}>
                {isSubmitting ? (
                  <ActivityIndicator color={sketchTheme.colors.ink} />
                ) : (
                  <Text style={styles.secondaryButtonText}>退出登录</Text>
                )}
              </Pressable>
            </>
          ) : (
            <>
              <Text style={styles.inputLabel}>账号</Text>
              <TextInput
                autoCapitalize="none"
                editable={!isSubmitting}
                onChangeText={setUsername}
                placeholder="输入账号"
                placeholderTextColor="#8C857A"
                style={styles.input}
                value={username}
              />

              <Text style={styles.inputLabel}>密码</Text>
              <TextInput
                editable={!isSubmitting}
                onChangeText={setPassword}
                placeholder="输入密码"
                placeholderTextColor="#8C857A"
                secureTextEntry
                style={styles.input}
                value={password}
              />

              <Pressable
                disabled={isSubmitting}
                onPress={handleLogin}
                style={({ pressed }) => [
                  styles.button,
                  pressed && styles.buttonPressed,
                  isSubmitting && styles.buttonDisabled,
                ]}>
                {isSubmitting ? (
                  <ActivityIndicator color={sketchTheme.colors.white} />
                ) : (
                  <Text style={styles.buttonText}>登录并继续</Text>
                )}
              </Pressable>
            </>
          )}

          {feedback ? (
            <View style={styles.feedbackCard}>
              <Text style={styles.feedbackText}>{feedback}</Text>
            </View>
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '发生未知错误，请稍后再试。';
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: sketchTheme.colors.paper,
    flex: 1,
  },
  page: {
    backgroundColor: sketchTheme.colors.paper,
    gap: 22,
    minHeight: '100%',
    overflow: 'hidden',
    paddingBottom: 140,
    paddingHorizontal: sketchTheme.spacing.page,
    paddingTop: 12,
  },
  doodleCircle: {
    backgroundColor: sketchTheme.colors.muted,
    borderRadius: 999,
    opacity: 0.55,
    position: 'absolute',
  },
  doodleCircleTop: {
    height: 18,
    right: 32,
    top: 18,
    width: 18,
  },
  doodleCircleBottom: {
    bottom: 120,
    height: 12,
    left: 20,
    width: 12,
  },
  dashedLoop: {
    borderColor: sketchTheme.colors.ink,
    borderRadius: 999,
    borderStyle: 'dashed',
    borderWidth: 2,
    height: 54,
    opacity: 0.35,
    position: 'absolute',
    right: 22,
    top: 104,
    transform: [{ rotate: '10deg' }],
    width: 104,
  },
  card: {
    borderColor: sketchTheme.colors.ink,
    borderWidth: sketchTheme.border.strong,
    ...sketchTheme.radius.card,
  },
  heroCard: {
    backgroundColor: sketchTheme.colors.white,
    gap: 10,
    paddingBottom: 24,
    paddingHorizontal: 20,
    paddingTop: 26,
    position: 'relative',
  },
  pin: {
    backgroundColor: sketchTheme.colors.penBlue,
    borderColor: sketchTheme.colors.ink,
    borderRadius: 999,
    borderWidth: 2,
    height: 18,
    position: 'absolute',
    right: 18,
    top: 16,
    width: 18,
  },
  tapeStrip: {
    alignSelf: 'center',
    backgroundColor: '#D9D4CD',
    borderRadius: 8,
    height: 16,
    opacity: 0.9,
    position: 'absolute',
    top: -8,
    transform: [{ rotate: '-7deg' }],
    width: 92,
  },
  label: {
    color: sketchTheme.colors.penBlue,
    fontSize: 15,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  title: {
    color: sketchTheme.colors.ink,
    fontSize: 36,
    lineHeight: 42,
    ...(sketchTheme.fonts.heading ? { fontFamily: sketchTheme.fonts.heading } : null),
  },
  note: {
    color: sketchTheme.colors.ink,
    fontSize: 18,
    lineHeight: 26,
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  statusCard: {
    backgroundColor: '#EEF5FF',
    gap: 8,
    padding: 18,
  },
  sectionTitle: {
    color: sketchTheme.colors.ink,
    fontSize: 24,
    ...(sketchTheme.fonts.heading ? { fontFamily: sketchTheme.fonts.heading } : null),
  },
  statusText: {
    color: sketchTheme.colors.ink,
    fontSize: 18,
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  metaText: {
    color: '#5A5A5A',
    fontSize: 14,
    lineHeight: 20,
  },
  tokenCard: {
    backgroundColor: sketchTheme.colors.white,
    borderColor: sketchTheme.colors.ink,
    borderStyle: 'dashed',
    borderWidth: 2,
    gap: 6,
    marginTop: 8,
    padding: 14,
    ...sketchTheme.radius.note,
  },
  tokenLabel: {
    color: sketchTheme.colors.penBlue,
    fontSize: 13,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  tokenValue: {
    color: sketchTheme.colors.ink,
    fontSize: 15,
    lineHeight: 22,
  },
  formCard: {
    backgroundColor: sketchTheme.colors.noteYellow,
    gap: 12,
    padding: 18,
  },
  formNote: {
    color: sketchTheme.colors.ink,
    fontSize: 16,
    lineHeight: 24,
  },
  inputLabel: {
    color: sketchTheme.colors.ink,
    fontSize: 15,
    marginTop: 4,
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  input: {
    backgroundColor: sketchTheme.colors.white,
    borderColor: sketchTheme.colors.ink,
    borderWidth: 2,
    color: sketchTheme.colors.ink,
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    ...sketchTheme.radius.note,
  },
  button: {
    alignItems: 'center',
    backgroundColor: sketchTheme.colors.accent,
    borderColor: sketchTheme.colors.ink,
    borderWidth: sketchTheme.border.regular,
    justifyContent: 'center',
    marginTop: 8,
    minHeight: 54,
    paddingHorizontal: 16,
    paddingVertical: 12,
    ...sketchTheme.radius.pill,
  },
  secondaryButton: {
    backgroundColor: sketchTheme.colors.white,
  },
  buttonPressed: {
    opacity: 0.86,
    transform: [{ translateY: 1 }],
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: sketchTheme.colors.white,
    fontSize: 16,
    textAlign: 'center',
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  secondaryButtonText: {
    color: sketchTheme.colors.ink,
    fontSize: 16,
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  feedbackCard: {
    backgroundColor: 'rgba(255,255,255,0.72)',
    borderColor: sketchTheme.colors.ink,
    borderStyle: 'dashed',
    borderWidth: 2,
    marginTop: 4,
    padding: 12,
    ...sketchTheme.radius.note,
  },
  feedbackText: {
    color: sketchTheme.colors.ink,
    fontSize: 15,
    lineHeight: 22,
  },
});
