import AsyncStorage from '@react-native-async-storage/async-storage';

export const FITNESS_PLAN_STORAGE_KEY = 'fitnessPlan';

export type FitnessExerciseImageKey =
  | 'barbell-squat'
  | 'bench-press'
  | 'cable-chest-fly'
  | 'dumbbell-curl'
  | 'dumbbell-row'
  | 'hip-bridge'
  | 'lat-pulldown'
  | 'pec-deck-fly'
  | 'pull-up'
  | 'seated-row'
  | 'stair-climber'
  | 'treadmill'
  | 'tbar-row';

export type FitnessPlanSet = {
  completed: boolean;
  id: string;
  kg: string;
  reps: string;
  setNumber: number;
};

export type FitnessPlanExercise = {
  description: string;
  id: string;
  imageKey: FitnessExerciseImageKey;
  name: string;
  sets: FitnessPlanSet[];
};

export type FitnessPlan = {
  exercises: FitnessPlanExercise[];
  id: string;
  notes: string[];
  sourceTitle?: string;
  summary: string;
  title: string;
  updatedAt: number;
};

type FitnessPlanListener = (plan: FitnessPlan | null) => void;

type ExerciseSource = {
  context?: string;
  value: unknown;
};

const fitnessPlanListeners = new Map<string, Set<FitnessPlanListener>>();
const fitnessPlanWrites = new Map<string, Promise<void>>();

export function getFitnessPlanStorageKey(userId: string): string {
  if (!userId.trim() || userId !== userId.trim()) {
    throw new Error('训练计划需要有效的登录用户身份。');
  }
  return `${FITNESS_PLAN_STORAGE_KEY}:${encodeURIComponent(userId)}`;
}

const EXERCISE_ARRAY_KEYS = [
  'exercises',
  'movements',
  'actions',
  'exerciseList',
  'exercise_list',
  'items',
  'list',
  '动作',
  '动作列表',
  '训练动作',
] as const;

const GROUP_ARRAY_KEYS = [
  'days',
  'sessions',
  'blocks',
  'mainBlocks',
  'main_blocks',
  'schedule',
  'weeklySchedule',
  'weekly_schedule',
  'routine',
  'workouts',
  'plans',
  '训练日',
  '训练安排',
  '每日计划',
] as const;

const CONTAINER_KEYS = [
  'plan',
  'workoutPlan',
  'workout_plan',
  'fitnessPlan',
  'fitness_plan',
  'trainingPlan',
  'training_plan',
  'program',
  'routine',
  'workout',
  'result',
  'output',
  'response',
  'content',
  'data',
  'payload',
  'tool',
  'toolOutput',
  'tool_output',
  'toolResult',
  'tool_result',
  '训练计划',
  '计划',
  '结果',
  '输出',
  '数据',
] as const;

export async function getStoredFitnessPlan(userId: string | null): Promise<FitnessPlan | null> {
  if (!userId) return null;
  const key = getFitnessPlanStorageKey(userId);
  await fitnessPlanWrites.get(key)?.catch(() => undefined);
  const rawValue = await AsyncStorage.getItem(key);

  if (!rawValue) {
    return null;
  }

  try {
    const payload = JSON.parse(rawValue) as unknown;
    const normalizedPlan = normalizeFitnessPlan(payload);

    if (normalizedPlan) {
      return normalizedPlan;
    }
  } catch {
    return null;
  }

  return null;
}

export async function storeFitnessPlan(plan: FitnessPlan, userId: string): Promise<void> {
  const key = getFitnessPlanStorageKey(userId);
  // Snapshot and serialize writes so slow storage cannot roll back newer edits.
  const snapshot = JSON.parse(JSON.stringify(plan)) as FitnessPlan;
  const next = (fitnessPlanWrites.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    await AsyncStorage.setItem(key, JSON.stringify(snapshot));
    // A queued newer edit is already visible; publishing this older snapshot
    // would reset the screen and could overwrite further edits made there.
    if (fitnessPlanWrites.get(key) === next) notifyFitnessPlanListeners(userId, snapshot);
  });
  fitnessPlanWrites.set(key, next);
  try { await next; }
  finally { if (fitnessPlanWrites.get(key) === next) fitnessPlanWrites.delete(key); }
}

export function subscribeToFitnessPlan(userId: string | null, listener: FitnessPlanListener): () => void {
  if (!userId) return () => {};
  getFitnessPlanStorageKey(userId);
  const listeners = fitnessPlanListeners.get(userId) ?? new Set<FitnessPlanListener>();
  listeners.add(listener);
  fitnessPlanListeners.set(userId, listeners);

  return () => {
    listeners.delete(listener);
    if (!listeners.size) fitnessPlanListeners.delete(userId);
  };
}

export function extractFitnessPlan(
  value: unknown,
  options: { fallbackTitle?: string; sourceTitle?: string } = {}
): FitnessPlan | null {
  const normalizedValue = unwrapJsonString(value);
  const planCandidate = locatePlanCandidate(normalizedValue);

  if (!planCandidate) {
    return null;
  }

  const exerciseSources = collectExerciseSources(planCandidate);
  const exercises = exerciseSources
    .map((source, index) => normalizeExercise(source, index))
    .filter((exercise): exercise is FitnessPlanExercise => Boolean(exercise));

  if (exercises.length === 0) {
    return null;
  }

  const planRecord = isRecord(planCandidate) ? planCandidate : null;
  const notes = normalizeNotes(planRecord);
  const updatedAt = Date.now();
  const title =
    extractFirstText([
      planRecord?.title,
      planRecord?.name,
      planRecord?.label,
      planRecord?.programName,
      planRecord?.program_name,
      planRecord?.['标题'],
      planRecord?.['计划名'],
      options.sourceTitle,
      options.fallbackTitle,
    ]) ?? '训练计划';
  const summary =
    extractFirstText([
      planRecord?.summary,
      planRecord?.description,
      planRecord?.goal,
      planRecord?.focus,
      planRecord?.objective,
      planRecord?.['摘要'],
      planRecord?.['目标'],
      planRecord?.['说明'],
    ]) ?? `共 ${exercises.length} 个动作，来自最近一次训练建议。`;

  return {
    exercises,
    id: `fitness-plan-${updatedAt}`,
    notes,
    sourceTitle: options.sourceTitle,
    summary,
    title,
    updatedAt,
  };
}

function normalizeFitnessPlan(value: unknown): FitnessPlan | null {
  if (!isRecord(value)) {
    return null;
  }

  const exercises = Array.isArray(value.exercises)
    ? value.exercises
        .map((item) => normalizeStoredExercise(item))
        .filter((item): item is FitnessPlanExercise => Boolean(item))
    : [];

  if (exercises.length === 0) {
    return null;
  }

  return {
    exercises,
    id: typeof value.id === 'string' && value.id ? value.id : `fitness-plan-${Date.now()}`,
    notes: Array.isArray(value.notes)
      ? value.notes
          .map((item) => (typeof item === 'string' ? item.trim() : ''))
          .filter(Boolean)
      : [],
    sourceTitle:
      typeof value.sourceTitle === 'string' && value.sourceTitle ? value.sourceTitle : undefined,
    summary: typeof value.summary === 'string' ? value.summary : '',
    title: typeof value.title === 'string' && value.title ? value.title : '训练计划',
    updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(new Date(value.updatedAt).getTime())
      ? value.updatedAt : Date.now(),
  };
}

function notifyFitnessPlanListeners(userId: string, plan: FitnessPlan | null) {
  for (const listener of fitnessPlanListeners.get(userId) ?? []) {
    listener(plan);
  }
}

function normalizeStoredExercise(value: unknown): FitnessPlanExercise | null {
  if (!isRecord(value)) {
    return null;
  }

  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const imageKey = isImageKey(value.imageKey) ? value.imageKey : matchExerciseImageKey(name);
  const sets = Array.isArray(value.sets)
    ? value.sets
        .map((item, index) => normalizeStoredSet(item, index))
        .filter((item): item is FitnessPlanSet => Boolean(item))
    : [];

  if (!name || sets.length === 0) {
    return null;
  }

  return {
    description: typeof value.description === 'string' ? value.description : '',
    id: typeof value.id === 'string' && value.id ? value.id : `exercise-${Date.now()}-${name}`,
    imageKey,
    name,
    sets,
  };
}

function normalizeStoredSet(value: unknown, index: number): FitnessPlanSet | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    completed: value.completed === true,
    id: typeof value.id === 'string' && value.id ? value.id : `set-${Date.now()}-${index}`,
    kg: typeof value.kg === 'string' ? value.kg : '',
    reps: typeof value.reps === 'string' ? value.reps : '',
    setNumber: typeof value.setNumber === 'number' && Number.isSafeInteger(value.setNumber) && value.setNumber > 0
      ? value.setNumber : index + 1,
  };
}

function locatePlanCandidate(source: unknown): unknown {
  const normalizedSource = unwrapJsonString(source);

  if (Array.isArray(normalizedSource)) {
    const exerciseSources = collectExerciseSources(normalizedSource);
    return exerciseSources.length > 0 ? { exercises: normalizedSource } : null;
  }

  if (!isRecord(normalizedSource)) {
    return null;
  }

  if (collectExerciseSources(normalizedSource).length > 0) {
    return normalizedSource;
  }

  const queue: unknown[] = Object.values(normalizedSource);
  const visited = new Set<unknown>([normalizedSource]);
  let depth = 0;

  while (queue.length > 0 && depth < 40) {
    const candidate = unwrapJsonString(queue.shift());

    if (candidate && typeof candidate === 'object' && !visited.has(candidate)) {
      visited.add(candidate);
    }

    if (collectExerciseSources(candidate).length > 0) {
      return candidate;
    }

    if (isRecord(candidate)) {
      for (const key of CONTAINER_KEYS) {
        if (key in candidate) {
          queue.push(candidate[key]);
        }
      }
    }

    depth += 1;
  }

  return null;
}

function collectExerciseSources(value: unknown, context?: string): ExerciseSource[] {
  const normalizedValue = unwrapJsonString(value);

  if (Array.isArray(normalizedValue)) {
    return normalizedValue.flatMap((item) => collectExerciseSources(item, context));
  }

  if (!isRecord(normalizedValue)) {
    return [];
  }

  if (isExerciseLike(normalizedValue)) {
    return [{ context, value: normalizedValue }];
  }

  for (const key of EXERCISE_ARRAY_KEYS) {
    const candidate = normalizedValue[key];

    if (Array.isArray(candidate)) {
      return candidate.flatMap((item) => collectExerciseSources(item, context));
    }
  }

  for (const key of GROUP_ARRAY_KEYS) {
    const candidate = normalizedValue[key];

    if (!Array.isArray(candidate)) {
      continue;
    }

    return candidate.flatMap((item) => {
      const groupRecord = isRecord(item) ? item : null;
      const nextContext =
        extractFirstText([
          groupRecord?.title,
          groupRecord?.name,
          groupRecord?.label,
          groupRecord?.focus,
          groupRecord?.['标题'],
          groupRecord?.['训练日'],
          groupRecord?.['名称'],
          context,
        ]) ?? context;

      return collectExerciseSources(item, nextContext);
    });
  }

  return [];
}

function normalizeExercise(source: ExerciseSource, index: number): FitnessPlanExercise | null {
  const record = isRecord(source.value) ? source.value : null;

  if (!record) {
    return null;
  }

  const baseName =
    extractFirstText([
      record.name,
      record.title,
      record.exercise,
      record.action,
      record.movement,
      record.label,
      record['动作'],
      record['名称'],
      record['项目'],
    ]) ?? '';

  if (!baseName) {
    return null;
  }

  const description = [
    source.context,
    extractFirstText([
      record.description,
      record.summary,
      record.instructions,
      record.coachingCue,
      record.notes,
      record.tips,
      record.target,
      record['描述'],
      record['说明'],
      record['要点'],
    ]),
  ]
    .filter((item): item is string => Boolean(item))
    .join(' · ');
  const sets = normalizeExerciseSets(record);

  return {
    description,
    id: `exercise-${Date.now()}-${index}-${slugify(baseName)}`,
    imageKey: matchExerciseImageKey(baseName),
    name: baseName,
    sets,
  };
}

function normalizeExerciseSets(record: Record<string, unknown>): FitnessPlanSet[] {
  const rawSets =
    record.sets ??
    record.workSets ??
    record.work_sets ??
    record.series ??
    record.rows ??
    record.scheme ??
    record['训练组'] ??
    record['组'] ??
    record['组数'];
  const exerciseKg = formatValue(
    record.kg ?? record.weightKg ?? record.weight_kg ?? record.weight ?? record['重量']
  );
  const exerciseReps = formatValue(
    record.reps ?? record.rep ?? record.count ?? record.targetReps ?? record['次数']
  );

  // Treat unreasonable model output as one editable row rather than allocating
  // an unbounded list or silently accepting fractional group counts.
  if (typeof rawSets === 'number' && Number.isSafeInteger(rawSets) && rawSets > 0 && rawSets <= 100) {
    return Array.from({ length: rawSets }, (_, index) =>
      createSetRow(index + 1, exerciseKg, exerciseReps)
    );
  }

  if (Array.isArray(rawSets)) {
    const rows = rawSets
      .map((item, index) => normalizeSetRow(item, index, exerciseKg, exerciseReps))
      .filter((item): item is FitnessPlanSet => Boolean(item));

    if (rows.length > 0) {
      return rows;
    }
  }

  if (exerciseKg || exerciseReps) {
    return [createSetRow(1, exerciseKg, exerciseReps)];
  }

  return [createSetRow(1, '', '')];
}

function normalizeSetRow(
  value: unknown,
  index: number,
  fallbackKg: string,
  fallbackReps: string
): FitnessPlanSet | null {
  if (typeof value === 'number') {
    return createSetRow(index + 1, fallbackKg, formatValue(value));
  }

  if (typeof value === 'string') {
    const parsed = parseSimpleSetString(value);
    return createSetRow(index + 1, parsed.kg || fallbackKg, parsed.reps || fallbackReps);
  }

  if (!isRecord(value)) {
    return null;
  }

  return createSetRow(
    typeof value.setNumber === 'number' ? value.setNumber : index + 1,
    formatValue(value.kg ?? value.weightKg ?? value.weight_kg ?? value.weight ?? value.load) ||
      formatValue(value['重量']) ||
      fallbackKg,
    formatValue(value.reps ?? value.rep ?? value.count ?? value.targetReps ?? value['次数']) ||
      fallbackReps
  );
}

function parseSimpleSetString(value: string): { kg: string; reps: string } {
  const normalized = value.trim().toLowerCase();
  const kgMatch = normalized.match(/(\d+(?:\.\d+)?)\s*(?:kg|公斤)/);
  const repsMatch = normalized.match(/(\d+)\s*(?:次|reps?|x)/);

  return {
    kg: kgMatch?.[1] ? `${kgMatch[1]} kg` : '',
    reps: repsMatch?.[1] ? `${repsMatch[1]} 次` : '',
  };
}

function createSetRow(setNumber: number, kg: string, reps: string): FitnessPlanSet {
  return {
    completed: false,
    id: `set-${Date.now()}-${setNumber}-${slugify(`${kg}-${reps}`)}`,
    kg,
    reps,
    setNumber,
  };
}

function normalizeNotes(record: Record<string, unknown> | null): string[] {
  if (!record) {
    return [];
  }

  const noteCandidates = [
    record.notes,
    record.tips,
    record.precautions,
    record.reminders,
    record['注意事项'],
    record['提醒'],
  ];

  for (const candidate of noteCandidates) {
    if (!candidate) {
      continue;
    }

    if (Array.isArray(candidate)) {
      const notes = candidate.map((item) => formatValue(item)).filter(Boolean);

      if (notes.length > 0) {
        return notes;
      }
    }

    const singleNote = formatValue(candidate);

    if (singleNote) {
      return [singleNote];
    }
  }

  return [];
}

function matchExerciseImageKey(name: string): FitnessExerciseImageKey {
  const normalizedName = slugify(name);

  if (normalizedName.includes('squat')) {
    return 'barbell-squat';
  }

  if (name.includes('深蹲')) {
    return 'barbell-squat';
  }

  if (normalizedName.includes('bench') || normalizedName.includes('press')) {
    return 'bench-press';
  }

  if (name.includes('卧推') || name.includes('推举')) {
    return 'bench-press';
  }

  if (normalizedName.includes('cable') && normalizedName.includes('fly')) {
    return 'cable-chest-fly';
  }

  if (name.includes('绳索') && name.includes('飞鸟')) {
    return 'cable-chest-fly';
  }

  if (normalizedName.includes('curl')) {
    return 'dumbbell-curl';
  }

  if (name.includes('弯举')) {
    return 'dumbbell-curl';
  }

  if (normalizedName.includes('row') && normalizedName.includes('dumbbell')) {
    return 'dumbbell-row';
  }

  if (name.includes('哑铃') && name.includes('划船')) {
    return 'dumbbell-row';
  }

  if (normalizedName.includes('bridge') || normalizedName.includes('hip thrust')) {
    return 'hip-bridge';
  }

  if (name.includes('臀桥') || name.includes('臀推')) {
    return 'hip-bridge';
  }

  if (normalizedName.includes('pulldown') || normalizedName.includes('lat')) {
    return 'lat-pulldown';
  }

  if (name.includes('下拉')) {
    return 'lat-pulldown';
  }

  if (normalizedName.includes('pec') || normalizedName.includes('chest fly')) {
    return 'pec-deck-fly';
  }

  if (name.includes('飞鸟')) {
    return name.includes('绳索') ? 'cable-chest-fly' : 'pec-deck-fly';
  }

  if (normalizedName.includes('pull up') || normalizedName.includes('pull-up')) {
    return 'pull-up';
  }

  if (name.includes('引体')) {
    return 'pull-up';
  }

  if (normalizedName.includes('seated') && normalizedName.includes('row')) {
    return 'seated-row';
  }

  if (name.includes('坐姿') && name.includes('划船')) {
    return 'seated-row';
  }

  if (
    normalizedName.includes('treadmill') ||
    normalizedName.includes('incline walk') ||
    (normalizedName.includes('running') && normalizedName.includes('machine'))
  ) {
    return 'treadmill';
  }

  if (name.includes('跑步机')) {
    return 'treadmill';
  }

  if (
    normalizedName.includes('stair climber') ||
    normalizedName.includes('stair-climber') ||
    normalizedName.includes('stairmaster') ||
    normalizedName.includes('stepmill')
  ) {
    return 'stair-climber';
  }

  if (
    name.includes('爬楼机') ||
    name.includes('登阶机') ||
    name.includes('楼梯机') ||
    name.includes('踏步机')
  ) {
    return 'stair-climber';
  }

  if (normalizedName.includes('t bar') || normalizedName.includes('tbar')) {
    return 'tbar-row';
  }

  if (name.includes('t杠') || name.includes('T杠')) {
    return 'tbar-row';
  }

  return 'bench-press';
}

function parseJsonCandidate(value: string): unknown {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  const directResult = tryParseJson(trimmed);

  if (directResult !== null) {
    return directResult;
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]+?)```/i);

  if (fencedMatch?.[1]) {
    const fencedResult = tryParseJson(fencedMatch[1].trim());

    if (fencedResult !== null) {
      return fencedResult;
    }
  }

  return null;
}

function unwrapJsonString(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  return parseJsonCandidate(value) ?? value;
}

function tryParseJson(value: string): unknown {
  if (!value.startsWith('{') && !value.startsWith('[')) {
    return null;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function extractFirstText(values: unknown[]): string | null {
  for (const value of values) {
    const text = formatValue(value);

    if (text) {
      return text;
    }
  }

  return null;
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (typeof value === 'number') {
    return `${value}`;
  }

  if (typeof value === 'boolean') {
    return value ? '是' : '否';
  }

  return '';
}

function isExerciseLike(value: Record<string, unknown>): boolean {
  return Boolean(
    extractFirstText([
      value.name,
      value.title,
      value.exercise,
      value.action,
      value.movement,
      value.label,
      value['动作'],
      value['名称'],
      value['项目'],
    ]) &&
      (value.sets !== undefined ||
        value.reps !== undefined ||
        value.rep !== undefined ||
        value.weight !== undefined ||
        value.kg !== undefined ||
        value.weightKg !== undefined ||
        value.description !== undefined ||
        value['组数'] !== undefined ||
        value['重量'] !== undefined ||
        value['次数'] !== undefined ||
        value['描述'] !== undefined)
  );
}

function isImageKey(value: unknown): value is FitnessExerciseImageKey {
  return (
    value === 'barbell-squat' ||
    value === 'bench-press' ||
    value === 'cable-chest-fly' ||
    value === 'dumbbell-curl' ||
    value === 'dumbbell-row' ||
    value === 'hip-bridge' ||
    value === 'lat-pulldown' ||
    value === 'pec-deck-fly' ||
    value === 'pull-up' ||
    value === 'seated-row' ||
    value === 'stair-climber' ||
    value === 'treadmill' ||
    value === 'tbar-row'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
}
