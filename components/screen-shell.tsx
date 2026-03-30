import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { sketchTheme } from '@/constants/theme';

type ScreenShellProps = {
  accentColor?: string;
  label: string;
  note: string;
  tilt?: 'left' | 'right';
  title: string;
};

export function ScreenShell({
  accentColor = sketchTheme.colors.accent,
  label,
  note,
  tilt = 'left',
  title,
}: ScreenShellProps) {
  const rotatedStyle = tilt === 'left' ? styles.rotateLeft : styles.rotateRight;
  const alternateRotatedStyle = tilt === 'left' ? styles.rotateRight : styles.rotateLeft;

  return (
    <SafeAreaView edges={['top']} style={styles.safeArea}>
      <View style={styles.page}>
        <View pointerEvents="none" style={[styles.doodleCircle, styles.doodleCircleTop]} />
        <View pointerEvents="none" style={[styles.doodleCircle, styles.doodleCircleBottom]} />
        <View pointerEvents="none" style={styles.dashedLoop} />

        <View style={styles.surfaceWrap}>
          <View style={[styles.rotatedSurface, rotatedStyle]}>
            <View pointerEvents="none" style={styles.surfaceShadow} />
            <View style={styles.heroCard}>
              <View style={[styles.pin, { backgroundColor: accentColor }]} />
              <View style={styles.tapeStrip} />
              <Text style={styles.label}>{label}</Text>
              <Text style={styles.title}>{title}</Text>
              <Text style={styles.note}>{note}</Text>
            </View>
          </View>
        </View>

        <View style={[styles.surfaceWrap, styles.canvasWrap]}>
          <View style={[styles.rotatedSurface, alternateRotatedStyle]}>
            <View pointerEvents="none" style={styles.surfaceShadow} />
            <View style={styles.canvasCard}>
              <View style={styles.canvasHeader}>
                <Text style={styles.canvasTitle}>功能区域预留</Text>
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>待接入</Text>
                </View>
              </View>
              <View style={styles.placeholderStage}>
                <View style={styles.placeholderInner} />
                <Text style={styles.placeholderText}>后续模块内容从这里展开</Text>
              </View>
            </View>
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: sketchTheme.colors.paper,
    flex: 1,
  },
  page: {
    backgroundColor: sketchTheme.colors.paper,
    flex: 1,
    gap: 24,
    overflow: 'hidden',
    paddingBottom: 18,
    paddingHorizontal: sketchTheme.spacing.page,
    paddingTop: 12,
  },
  doodleCircle: {
    backgroundColor: sketchTheme.colors.muted,
    borderRadius: 999,
    opacity: 0.6,
    position: 'absolute',
  },
  doodleCircleTop: {
    height: 18,
    right: 34,
    top: 20,
    width: 18,
  },
  doodleCircleBottom: {
    bottom: 160,
    height: 12,
    left: 28,
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
    right: 18,
    top: 92,
    transform: [{ rotate: '12deg' }],
    width: 108,
  },
  surfaceWrap: {
    position: 'relative',
  },
  canvasWrap: {
    flex: 1,
  },
  rotatedSurface: {
    position: 'relative',
  },
  rotateLeft: {
    transform: [{ rotate: '-1.2deg' }],
  },
  rotateRight: {
    transform: [{ rotate: '1.1deg' }],
  },
  surfaceShadow: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: sketchTheme.colors.ink,
    transform: [
      { translateX: sketchTheme.shadow.offset },
      { translateY: sketchTheme.shadow.offset },
    ],
    ...sketchTheme.radius.card,
  },
  heroCard: {
    backgroundColor: sketchTheme.colors.white,
    borderColor: sketchTheme.colors.ink,
    borderWidth: sketchTheme.border.strong,
    gap: 10,
    paddingBottom: 26,
    paddingHorizontal: 20,
    paddingTop: 26,
    ...sketchTheme.radius.card,
  },
  pin: {
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
    transform: [{ rotate: '-8deg' }],
    width: 92,
  },
  label: {
    color: sketchTheme.colors.penBlue,
    fontSize: 15,
    letterSpacing: 1.4,
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
    maxWidth: '88%',
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  canvasCard: {
    backgroundColor: sketchTheme.colors.noteYellow,
    borderColor: sketchTheme.colors.ink,
    borderWidth: sketchTheme.border.strong,
    flex: 1,
    gap: 18,
    minHeight: 280,
    padding: 18,
    ...sketchTheme.radius.card,
  },
  canvasHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  canvasTitle: {
    color: sketchTheme.colors.ink,
    fontSize: 22,
    ...(sketchTheme.fonts.heading ? { fontFamily: sketchTheme.fonts.heading } : null),
  },
  badge: {
    backgroundColor: sketchTheme.colors.white,
    borderColor: sketchTheme.colors.ink,
    borderStyle: 'dashed',
    borderWidth: 2,
    paddingHorizontal: 12,
    paddingVertical: 6,
    ...sketchTheme.radius.pill,
  },
  badgeText: {
    color: sketchTheme.colors.ink,
    fontSize: 13,
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  placeholderStage: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.52)',
    borderColor: sketchTheme.colors.ink,
    borderStyle: 'dashed',
    borderWidth: 2,
    flex: 1,
    gap: 14,
    justifyContent: 'center',
    minHeight: 200,
    padding: 20,
    ...sketchTheme.radius.note,
  },
  placeholderInner: {
    borderColor: sketchTheme.colors.ink,
    borderRadius: 999,
    borderStyle: 'dashed',
    borderWidth: 2,
    height: 56,
    opacity: 0.45,
    width: 56,
  },
  placeholderText: {
    color: sketchTheme.colors.ink,
    fontSize: 17,
    lineHeight: 24,
    textAlign: 'center',
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
});
