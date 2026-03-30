import { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { sketchTheme } from '@/constants/theme';
import type { FitnessExerciseImageKey, FitnessPlanExercise } from '@/services/fitness-plan';

const EXERCISE_IMAGES: Record<FitnessExerciseImageKey, number> = {
  'barbell-squat': require('../assets/exercises-cartoon/barbell-squat-cartoon.png'),
  'bench-press': require('../assets/exercises-cartoon/bench-press-cartoon.png'),
  'cable-chest-fly': require('../assets/exercises-cartoon/cable-chest-fly-cartoon.png'),
  'dumbbell-curl': require('../assets/exercises-cartoon/dumbbell-curl-cartoon.png'),
  'dumbbell-row': require('../assets/exercises-cartoon/dumbbell-row-cartoon.png'),
  'hip-bridge': require('../assets/exercises-cartoon/hip-bridge-cartoon.png'),
  'lat-pulldown': require('../assets/exercises-cartoon/lat-pulldown-cartoon.png'),
  'pec-deck-fly': require('../assets/exercises-cartoon/pec-deck-fly-cartoon.png'),
  'pull-up': require('../assets/exercises-cartoon/pull-up-cartoon.png'),
  'seated-row': require('../assets/exercises-cartoon/seated-row-cartoon.png'),
  'stair-climber': require('../assets/exercises-cartoon/stair-climber-cartoon.png'),
  treadmill: require('../assets/exercises-cartoon/treadmill-cartoon.png'),
  'tbar-row': require('../assets/exercises-cartoon/tbar-row-cartoon.png'),
};

type FitnessExerciseCardProps = {
  exercise: FitnessPlanExercise;
  onAddSet: () => void;
  onToggleSet: (setId: string) => void;
};

export function FitnessExerciseCard({
  exercise,
  onAddSet,
  onToggleSet,
}: FitnessExerciseCardProps) {
  const [expanded, setExpanded] = useState(false);
  const completedCount = exercise.sets.filter((setItem) => setItem.completed).length;

  return (
    <View style={styles.wrap}>
      <View pointerEvents="none" style={styles.shadow} />
      <View style={styles.card}>
        <Pressable
          onPress={() => setExpanded((current) => !current)}
          style={({ pressed }) => [styles.headerButton, pressed && styles.headerButtonPressed]}>
          <Image resizeMode="contain" source={EXERCISE_IMAGES[exercise.imageKey]} style={styles.image} />

          <View style={styles.headerContent}>
            <Text style={styles.eyebrow}>训练动作</Text>
            <Text style={styles.name}>{exercise.name}</Text>

            <View style={styles.metaRow}>
              <View style={styles.metaChip}>
                <Text style={styles.metaChipText}>
                  {completedCount}/{exercise.sets.length} 组完成
                </Text>
              </View>
              <View style={[styles.metaChip, styles.metaChipAlt]}>
                <Text style={styles.metaChipText}>{expanded ? '收起详情' : '展开详情'}</Text>
              </View>
            </View>
          </View>

          <View style={[styles.foldBadge, expanded && styles.foldBadgeExpanded]}>
            <Text style={styles.foldBadgeText}>{expanded ? '−' : '+'}</Text>
          </View>
        </Pressable>

        {expanded ? (
          <View style={styles.detailBlock}>
            <Text style={styles.description}>
              {exercise.description || '保持核心稳定，按照计划完成每一组。'}
            </Text>

            <View style={styles.tableHeader}>
              <Text style={[styles.tableHeaderText, styles.setColumn]}>组数</Text>
              <Text style={[styles.tableHeaderText, styles.metricColumn]}>kg</Text>
              <Text style={[styles.tableHeaderText, styles.metricColumn]}>次</Text>
              <Text style={[styles.tableHeaderText, styles.checkColumn]}>完成</Text>
            </View>

            <View style={styles.setList}>
              {exercise.sets.map((setItem) => (
                <View key={setItem.id} style={styles.setRow}>
                  <Text style={[styles.setCellText, styles.setColumn]}>第 {setItem.setNumber} 组</Text>
                  <Text style={[styles.setCellText, styles.metricColumn]}>
                    {setItem.kg || '--'}
                  </Text>
                  <Text style={[styles.setCellText, styles.metricColumn]}>
                    {setItem.reps || '--'}
                  </Text>
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: setItem.completed }}
                    onPress={() => onToggleSet(setItem.id)}
                    style={[
                      styles.checkButton,
                      setItem.completed && styles.checkButtonCompleted,
                    ]}>
                    <Text
                      style={[
                        styles.checkButtonText,
                        setItem.completed && styles.checkButtonTextCompleted,
                      ]}>
                      {setItem.completed ? '✓' : ''}
                    </Text>
                  </Pressable>
                </View>
              ))}
            </View>

            <Pressable onPress={onAddSet} style={({ pressed }) => [styles.addButton, pressed && styles.addButtonPressed]}>
              <Text style={styles.addButtonText}>新增一组</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'relative',
  },
  shadow: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: sketchTheme.colors.ink,
    transform: [{ translateX: 5 }, { translateY: 5 }],
    ...sketchTheme.radius.card,
  },
  card: {
    backgroundColor: sketchTheme.colors.white,
    borderColor: sketchTheme.colors.ink,
    borderWidth: sketchTheme.border.strong,
    overflow: 'hidden',
    ...sketchTheme.radius.card,
  },
  headerButton: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
    minHeight: 138,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  headerButtonPressed: {
    opacity: 0.92,
  },
  image: {
    backgroundColor: '#FFF8EF',
    borderColor: sketchTheme.colors.ink,
    borderRadius: 22,
    borderWidth: 2,
    height: 104,
    padding: 8,
    width: 104,
  },
  headerContent: {
    flex: 1,
    gap: 8,
    minWidth: 0,
  },
  eyebrow: {
    color: sketchTheme.colors.penBlue,
    fontSize: 13,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  name: {
    color: sketchTheme.colors.ink,
    fontSize: 28,
    lineHeight: 33,
    ...(sketchTheme.fonts.heading ? { fontFamily: sketchTheme.fonts.heading } : null),
  },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  metaChip: {
    backgroundColor: '#FFF2E3',
    borderColor: sketchTheme.colors.ink,
    borderStyle: 'dashed',
    borderWidth: 2,
    paddingHorizontal: 10,
    paddingVertical: 6,
    ...sketchTheme.radius.pill,
  },
  metaChipAlt: {
    backgroundColor: '#EEF5FF',
  },
  metaChipText: {
    color: sketchTheme.colors.ink,
    fontSize: 13,
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  foldBadge: {
    alignItems: 'center',
    backgroundColor: sketchTheme.colors.noteYellow,
    borderColor: sketchTheme.colors.ink,
    borderRadius: 20,
    borderWidth: 2,
    height: 38,
    justifyContent: 'center',
    width: 38,
  },
  foldBadgeExpanded: {
    backgroundColor: '#DCEBFF',
  },
  foldBadgeText: {
    color: sketchTheme.colors.ink,
    fontSize: 26,
    lineHeight: 28,
  },
  detailBlock: {
    backgroundColor: '#FFF8EF',
    borderTopColor: 'rgba(45,45,45,0.12)',
    borderTopWidth: 2,
    gap: 12,
    padding: 16,
  },
  description: {
    color: sketchTheme.colors.ink,
    fontSize: 15,
    lineHeight: 23,
  },
  tableHeader: {
    flexDirection: 'row',
    paddingHorizontal: 4,
  },
  tableHeaderText: {
    color: '#7B6D59',
    fontSize: 13,
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  setList: {
    gap: 8,
  },
  setRow: {
    alignItems: 'center',
    backgroundColor: sketchTheme.colors.white,
    borderColor: sketchTheme.colors.ink,
    borderWidth: 2,
    flexDirection: 'row',
    minHeight: 54,
    paddingHorizontal: 12,
    ...sketchTheme.radius.note,
  },
  setCellText: {
    color: sketchTheme.colors.ink,
    fontSize: 15,
  },
  setColumn: {
    flex: 1.3,
  },
  metricColumn: {
    flex: 0.85,
  },
  checkColumn: {
    flex: 0.65,
    textAlign: 'right',
  },
  checkButton: {
    alignItems: 'center',
    backgroundColor: '#FFF5CF',
    borderColor: sketchTheme.colors.ink,
    borderRadius: 14,
    borderWidth: 2,
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  checkButtonCompleted: {
    backgroundColor: '#BFE3B5',
  },
  checkButtonText: {
    color: 'transparent',
    fontSize: 17,
    lineHeight: 20,
  },
  checkButtonTextCompleted: {
    color: sketchTheme.colors.ink,
  },
  addButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: sketchTheme.colors.penBlue,
    borderColor: sketchTheme.colors.ink,
    borderWidth: sketchTheme.border.regular,
    justifyContent: 'center',
    minHeight: 46,
    paddingHorizontal: 18,
    ...sketchTheme.radius.pill,
  },
  addButtonPressed: {
    opacity: 0.88,
    transform: [{ translateY: 1 }],
  },
  addButtonText: {
    color: sketchTheme.colors.white,
    fontSize: 15,
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
});
