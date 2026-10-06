import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FitnessExerciseCard } from '@/components/fitness-exercise-card';
import { sketchTheme } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import {
  getStoredFitnessPlan,
  storeFitnessPlan,
  subscribeToFitnessPlan,
  type FitnessPlan,
  type FitnessPlanSet,
} from '@/services/fitness-plan';

export default function FitnessScreen() {
  const { userId } = useAuth();
  const [storedPlan, setPlan] = useState<FitnessPlan | null>(null);
  const [storedFeedback, setFeedback] = useState<string | null>(null);
  const [loading, setIsLoading] = useState(Boolean(userId));
  const sessionRef = useRef({ userId, generation: 0 });
  const readRef = useRef(0);
  const planRef = useRef<FitnessPlan | null>(null);
  const belongsToAccount = sessionRef.current.userId === userId;
  const plan = belongsToAccount ? storedPlan : null;
  const feedback = belongsToAccount ? storedFeedback : null;
  const isLoading = Boolean(userId) && (!belongsToAccount || loading);

  useLayoutEffect(() => {
    if (sessionRef.current.userId !== userId) {
      sessionRef.current = { userId, generation: sessionRef.current.generation + 1 };
      readRef.current += 1;
      planRef.current = null;
      setPlan(null);
      setFeedback(null);
      setIsLoading(Boolean(userId));
    }
  }, [userId]);

  const loadPlan = useCallback(() => {
    let isActive = true;
    const generation = sessionRef.current.generation;
    const requestNumber = ++readRef.current;
    const canUpdate = () => isActive && sessionRef.current.userId === userId &&
      sessionRef.current.generation === generation && readRef.current === requestNumber;

    setIsLoading(Boolean(userId));

    void (async () => {
      try {
        const nextPlan = await getStoredFitnessPlan(userId);

        if (!canUpdate()) {
          return;
        }

        planRef.current = nextPlan;
        setPlan(nextPlan);
        setFeedback(null);
      } catch (error) {
        if (!canUpdate()) {
          return;
        }

        setFeedback(getErrorMessage(error));
      } finally {
        if (canUpdate()) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      isActive = false;
    };
  }, [userId]);

  useFocusEffect(loadPlan);

  useEffect(() => {
    let isActive = true;
    const generation = sessionRef.current.generation;
    const unsubscribe = subscribeToFitnessPlan(userId, (nextPlan) => {
      if (!isActive || sessionRef.current.userId !== userId || sessionRef.current.generation !== generation) return;
      readRef.current += 1;
      planRef.current = nextPlan;
      setPlan(nextPlan);
      setFeedback(null);
      setIsLoading(false);
    });
    return () => { isActive = false; unsubscribe(); };
  }, [userId]);

  function updatePlan(updater: (currentPlan: FitnessPlan) => FitnessPlan) {
    if (!userId || sessionRef.current.userId !== userId || !planRef.current) return;
    const nextPlan = updater(planRef.current);
    planRef.current = nextPlan;
    setPlan(nextPlan);
    void persistPlan(nextPlan, userId, sessionRef.current.generation);
  }

  async function persistPlan(nextPlan: FitnessPlan, ownerId: string, generation: number) {
    const isCurrentAccount = () => sessionRef.current.userId === ownerId && sessionRef.current.generation === generation;
    try {
      await storeFitnessPlan(nextPlan, ownerId);
      if (isCurrentAccount()) setFeedback(null);
    } catch (error) {
      if (isCurrentAccount()) setFeedback(getErrorMessage(error));
    }
  }

  function handleToggleSet(exerciseId: string, setId: string) {
    updatePlan((currentPlan) => ({
      ...currentPlan,
      exercises: currentPlan.exercises.map((exercise) =>
        exercise.id !== exerciseId
          ? exercise
          : {
              ...exercise,
              sets: exercise.sets.map((setItem) =>
                setItem.id !== setId
                  ? setItem
                  : {
                      ...setItem,
                      completed: !setItem.completed,
                    }
              ),
            }
      ),
      updatedAt: Date.now(),
    }));
  }

  function handleUpdateSet(
    exerciseId: string,
    setId: string,
    field: 'kg' | 'reps',
    value: string
  ) {
    const normalizedValue = value.trim();
    const isValid = normalizedValue === '' || (field === 'kg'
      ? /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalizedValue) && Number.isFinite(Number(normalizedValue))
      : /^\d+$/.test(normalizedValue) && Number.isSafeInteger(Number(normalizedValue)) && Number(normalizedValue) > 0);
    if (!isValid) {
      setFeedback(field === 'kg' ? '重量需要为非负数字，可以使用小数或留空。' : '次数需要为正整数，或留空。');
      return;
    }
    updatePlan((currentPlan) => ({
      ...currentPlan,
      exercises: currentPlan.exercises.map((exercise) =>
        exercise.id !== exerciseId
          ? exercise
          : {
              ...exercise,
              sets: exercise.sets.map((setItem) =>
                setItem.id !== setId
                  ? setItem
                  : {
                      ...setItem,
                      [field]: normalizedValue,
                    }
              ),
            }
      ),
      updatedAt: Date.now(),
    }));
  }

  function handleAddSet(exerciseId: string) {
    updatePlan((currentPlan) => ({
      ...currentPlan,
      exercises: currentPlan.exercises.map((exercise) => {
        if (exercise.id !== exerciseId) {
          return exercise;
        }

        const lastSet = exercise.sets[exercise.sets.length - 1];
        const nextSet = createNextSet(lastSet, exercise.sets.length + 1, exercise.id);

        return {
          ...exercise,
          sets: [...exercise.sets, nextSet],
        };
      }),
      updatedAt: Date.now(),
    }));
  }

  const totalSets = plan?.exercises.reduce((count, exercise) => count + exercise.sets.length, 0) ?? 0;
  const completedSets =
    plan?.exercises.reduce(
      (count, exercise) => count + exercise.sets.filter((setItem) => setItem.completed).length,
      0
    ) ?? 0;

  return (
    <SafeAreaView edges={['top']} style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.page} showsVerticalScrollIndicator={false}>
        <View pointerEvents="none" style={[styles.doodleCircle, styles.doodleCircleTop]} />
        <View pointerEvents="none" style={[styles.doodleCircle, styles.doodleCircleBottom]} />
        <View pointerEvents="none" style={styles.dashedLoop} />

        <View style={[styles.card, styles.heroCard]}>
          <View style={styles.heroHeader}>
            <View style={styles.heroCopy}>
              <Text style={styles.label}>计划同步</Text>
              <Text style={styles.title}>训练计划</Text>
              <Text style={styles.note}>
                聊天里整理出的训练安排会自动出现在这里，你可以直接勾选完成情况，也可以继续补充训练组数。
              </Text>
            </View>

            <Pressable onPress={() => loadPlan()} style={({ pressed }) => [styles.refreshButton, pressed && styles.refreshButtonPressed]}>
              <Text style={styles.refreshButtonText}>重新读取</Text>
            </Pressable>
          </View>

          <View style={styles.metaRow}>
            <View style={styles.metaChip}>
              <Text style={styles.metaChipText}>
                {plan ? `最近更新 ${formatTime(plan.updatedAt)}` : '等待新的训练计划'}
              </Text>
            </View>
            <View style={[styles.metaChip, styles.metaChipAlt]}>
              <Text style={styles.metaChipText}>{plan?.title ?? '暂无训练安排'}</Text>
            </View>
          </View>
        </View>

        {feedback ? (
          <View style={[styles.card, styles.feedbackCard]}>
            <Text style={styles.feedbackTitle}>状态提醒</Text>
            <Text style={styles.feedbackText}>{feedback}</Text>
          </View>
        ) : null}

        {isLoading ? (
          <View style={[styles.card, styles.loadingCard]}>
            <ActivityIndicator color={sketchTheme.colors.penBlue} />
            <Text style={styles.loadingText}>正在读取最近保存的训练计划...</Text>
          </View>
        ) : plan ? (
          <Fragment key={plan.id}>
            <View style={[styles.card, styles.overviewCard]}>
              <Text style={styles.sectionLabel}>计划概览</Text>
              <Text style={styles.sectionTitle}>{plan.title}</Text>
              <Text style={styles.summaryText}>{plan.summary}</Text>

              <View style={styles.statsRow}>
                <View style={styles.statBlock}>
                  <Text style={styles.statValue}>{plan.exercises.length}</Text>
                  <Text style={styles.statLabel}>动作数</Text>
                </View>
                <View style={styles.statBlock}>
                  <Text style={styles.statValue}>{totalSets}</Text>
                  <Text style={styles.statLabel}>总组数</Text>
                </View>
                <View style={styles.statBlock}>
                  <Text style={styles.statValue}>{completedSets}</Text>
                  <Text style={styles.statLabel}>已完成</Text>
                </View>
              </View>
            </View>

            {plan.notes.length > 0 ? (
              <View style={[styles.card, styles.notesCard]}>
                <Text style={styles.sectionTitle}>训练提醒</Text>
                <View style={styles.notesList}>
                  {plan.notes.map((noteItem, index) => (
                    <View key={`${noteItem}-${index}`} style={styles.noteItem}>
                      <Text style={styles.noteIndex}>{index + 1}</Text>
                      <Text style={styles.noteItemText}>{noteItem}</Text>
                    </View>
                  ))}
                </View>
              </View>
            ) : null}

            <View style={styles.listSection}>
              <Text style={styles.sectionTitle}>动作清单</Text>
              <Text style={styles.sectionHint}>
                点击卡片查看动作说明和每组安排。重量和次数可以直接修改，新增一组会先沿用上一组的数据。
              </Text>

              <View style={styles.exerciseList}>
                {plan.exercises.map((exercise) => (
                  <FitnessExerciseCard
                    key={exercise.id}
                    exercise={exercise}
                    onAddSet={() => handleAddSet(exercise.id)}
                    onToggleSet={(setId) => handleToggleSet(exercise.id, setId)}
                    onUpdateSet={(setId, field, value) =>
                      handleUpdateSet(exercise.id, setId, field, value)
                    }
                  />
                ))}
              </View>
            </View>
          </Fragment>
        ) : (
          <View style={[styles.card, styles.emptyCard]}>
            <Text style={styles.emptyEyebrow}>还没有训练计划</Text>
            <Text style={styles.emptyTitle}>{userId ? '先去聊天页生成训练计划' : '请先登录查看你的训练计划'}</Text>
            <Text style={styles.emptyText}>
              把你的目标、频率和器械条件告诉教练，生成后会自动同步到这里。
            </Text>

            <View style={styles.emptySteps}>
              <View style={styles.stepCard}>
                <Text style={styles.stepIndex}>1</Text>
                <Text style={styles.stepText}>在聊天页说明你的目标、训练频率和器械条件。</Text>
              </View>
              <View style={styles.stepCard}>
                <Text style={styles.stepIndex}>2</Text>
                <Text style={styles.stepText}>等待系统整理出动作、组数、重量和次数。</Text>
              </View>
              <View style={styles.stepCard}>
                <Text style={styles.stepIndex}>3</Text>
                <Text style={styles.stepText}>回到这里勾选完成情况，或继续补充训练组。</Text>
              </View>
            </View>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function createNextSet(
  lastSet: FitnessPlanSet | undefined,
  nextSetNumber: number,
  exerciseId: string
): FitnessPlanSet {
  return {
    completed: false,
    id: `set-${exerciseId}-${Date.now()}-${nextSetNumber}`,
    kg: lastSet?.kg ?? '',
    reps: lastSet?.reps ?? '',
    setNumber: nextSetNumber,
  };
}

function formatTime(value: number): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '刚刚';
  }

  return date.toLocaleString('zh-CN', {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: '2-digit',
  });
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
    backgroundColor: '#FFE4CC',
    borderRadius: 999,
    opacity: 0.75,
    position: 'absolute',
  },
  doodleCircleTop: {
    height: 18,
    left: 26,
    top: 34,
    width: 18,
  },
  doodleCircleBottom: {
    bottom: 220,
    height: 14,
    right: 24,
    width: 14,
  },
  dashedLoop: {
    borderColor: sketchTheme.colors.ink,
    borderRadius: 999,
    borderStyle: 'dashed',
    borderWidth: 2,
    height: 60,
    opacity: 0.3,
    position: 'absolute',
    right: 14,
    top: 90,
    transform: [{ rotate: '12deg' }],
    width: 124,
  },
  card: {
    borderColor: sketchTheme.colors.ink,
    borderWidth: sketchTheme.border.strong,
    ...sketchTheme.radius.card,
  },
  heroCard: {
    backgroundColor: sketchTheme.colors.white,
    gap: 14,
    padding: 20,
  },
  heroHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
  },
  heroCopy: {
    flex: 1,
    gap: 8,
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
    fontSize: 38,
    lineHeight: 42,
    ...(sketchTheme.fonts.heading ? { fontFamily: sketchTheme.fonts.heading } : null),
  },
  note: {
    color: sketchTheme.colors.ink,
    fontSize: 17,
    lineHeight: 25,
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  refreshButton: {
    alignItems: 'center',
    backgroundColor: '#EEF5FF',
    borderColor: sketchTheme.colors.ink,
    borderWidth: 2,
    justifyContent: 'center',
    minHeight: 42,
    paddingHorizontal: 14,
    ...sketchTheme.radius.pill,
  },
  refreshButtonPressed: {
    opacity: 0.86,
  },
  refreshButtonText: {
    color: sketchTheme.colors.ink,
    fontSize: 14,
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  metaChip: {
    backgroundColor: '#FFF4E8',
    borderColor: sketchTheme.colors.ink,
    borderStyle: 'dashed',
    borderWidth: 2,
    paddingHorizontal: 12,
    paddingVertical: 7,
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
  feedbackCard: {
    backgroundColor: '#FFF0F0',
    gap: 6,
    padding: 16,
  },
  feedbackTitle: {
    color: '#A13838',
    fontSize: 20,
    ...(sketchTheme.fonts.heading ? { fontFamily: sketchTheme.fonts.heading } : null),
  },
  feedbackText: {
    color: sketchTheme.colors.ink,
    fontSize: 15,
    lineHeight: 22,
  },
  loadingCard: {
    alignItems: 'center',
    backgroundColor: '#FFF9EA',
    gap: 12,
    padding: 24,
  },
  loadingText: {
    color: sketchTheme.colors.ink,
    fontSize: 15,
  },
  overviewCard: {
    backgroundColor: sketchTheme.colors.noteYellow,
    gap: 10,
    padding: 18,
  },
  sectionLabel: {
    color: sketchTheme.colors.penBlue,
    fontSize: 14,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  sectionTitle: {
    color: sketchTheme.colors.ink,
    fontSize: 28,
    ...(sketchTheme.fonts.heading ? { fontFamily: sketchTheme.fonts.heading } : null),
  },
  summaryText: {
    color: sketchTheme.colors.ink,
    fontSize: 16,
    lineHeight: 24,
  },
  statsRow: {
    flexDirection: 'row',
    gap: 10,
    paddingTop: 4,
  },
  statBlock: {
    backgroundColor: 'rgba(255,255,255,0.84)',
    borderColor: sketchTheme.colors.ink,
    borderWidth: 2,
    flex: 1,
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 12,
    ...sketchTheme.radius.note,
  },
  statValue: {
    color: sketchTheme.colors.ink,
    fontSize: 28,
    ...(sketchTheme.fonts.heading ? { fontFamily: sketchTheme.fonts.heading } : null),
  },
  statLabel: {
    color: '#6B625A',
    fontSize: 13,
  },
  notesCard: {
    backgroundColor: '#EFF8EF',
    gap: 14,
    padding: 18,
  },
  notesList: {
    gap: 10,
  },
  noteItem: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 10,
  },
  noteIndex: {
    backgroundColor: '#BFE3B5',
    borderColor: sketchTheme.colors.ink,
    borderRadius: 999,
    borderWidth: 2,
    color: sketchTheme.colors.ink,
    minWidth: 28,
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 4,
    textAlign: 'center',
  },
  noteItemText: {
    color: sketchTheme.colors.ink,
    flex: 1,
    fontSize: 15,
    lineHeight: 22,
  },
  listSection: {
    gap: 12,
  },
  sectionHint: {
    color: '#6B625A',
    fontSize: 14,
    lineHeight: 20,
  },
  exerciseList: {
    gap: 18,
  },
  emptyCard: {
    backgroundColor: sketchTheme.colors.white,
    gap: 12,
    padding: 18,
  },
  emptyEyebrow: {
    color: sketchTheme.colors.penBlue,
    fontSize: 15,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  emptyTitle: {
    color: sketchTheme.colors.ink,
    fontSize: 32,
    lineHeight: 38,
    ...(sketchTheme.fonts.heading ? { fontFamily: sketchTheme.fonts.heading } : null),
  },
  emptyText: {
    color: sketchTheme.colors.ink,
    fontSize: 16,
    lineHeight: 24,
  },
  emptySteps: {
    gap: 10,
    paddingTop: 4,
  },
  stepCard: {
    alignItems: 'flex-start',
    backgroundColor: '#FFF8EF',
    borderColor: sketchTheme.colors.ink,
    borderStyle: 'dashed',
    borderWidth: 2,
    flexDirection: 'row',
    gap: 10,
    padding: 12,
    ...sketchTheme.radius.note,
  },
  stepIndex: {
    backgroundColor: sketchTheme.colors.accent,
    borderColor: sketchTheme.colors.ink,
    borderRadius: 999,
    borderWidth: 2,
    color: sketchTheme.colors.white,
    minWidth: 28,
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 4,
    textAlign: 'center',
  },
  stepText: {
    color: sketchTheme.colors.ink,
    flex: 1,
    fontSize: 15,
    lineHeight: 22,
  },
});
