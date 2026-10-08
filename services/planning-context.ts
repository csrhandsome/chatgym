const musclePatterns: [string, RegExp][] = [
  ['胸', /胸(?:部|肌)?|\b(?:chest|pecs?)\b/i],
  ['背', /背(?:部|肌)?|\bback\b/i],
  ['腿', /腿(?:部)?|\blegs?\b/i],
  ['臀', /臀(?:部|肌)?|\bglutes?\b/i],
  ['肩', /肩(?:部)?|\bshoulders?\b/i],
  ['手臂', /手臂|二头|三头|\barms?\b/i],
  ['核心', /核心|腹(?:部|肌)|\b(?:core|abs)\b/i],
];

// Use the device's calendar, including around midnight, rather than asking
// the model to infer a date from its training data or past chat messages.
export function createPlanningContext(message: string, now = new Date(), previousUserMessages: string[] = []) {
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const weekday = `周${'日一二三四五六'[now.getDay()]}`;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const affirmativeText = message.replace(
    /(?:不要|不想|不需要|不打算|不|别)(?:再|要)?(?:练|训练)?(?:胸(?:部|肌)?|背(?:部|肌)?|腿部?|臀(?:部|肌)?|肩部?|手臂|二头|三头|核心|腹(?:部|肌))/g,
    '',
  );
  const currentTargets = musclePatterns.filter(([, pattern]) => pattern.test(affirmativeText)).map(([muscle]) => muscle);
  const previousTargetMessage = [...previousUserMessages].reverse().find((text) => musclePatterns.some(([, pattern]) => pattern.test(text)));
  // A follow-up such as “少一个动作” keeps the user's last stated focus.
  // A newly stated or negated muscle target takes precedence over history.
  const targetAreas = currentTargets.length || musclePatterns.some(([, pattern]) => pattern.test(message))
    ? currentTargets : musclePatterns.filter(([, pattern]) => pattern.test(previousTargetMessage ?? '')).map(([muscle]) => muscle);
  const duration = message.match(/(\d+)\s*(?:分钟|min(?:utes?)?\b)/i);
  const sessionDurationMinutes = duration ? Math.max(20, Math.min(180, Number(duration[1]))) : 60;
  const notes = [
    `设备当前本地日期：${date}，星期：${weekday}，时区：${timeZone}。涉及“今天”时必须使用此日期，不得从历史对话推断。`,
    `此客户端每次聊天都生成或调整当天计划。weeklySchedule 必须只有今天（${weekday}）的 1 次训练，weeklyFrequency 为 1。主训练最多 5 个动作。历史周计划只能作为背景，不得扩展为多日计划。${targetAreas.length ? `主训练围绕${targetAreas.join('、')}，不要补入无关部位的动作。` : ''}`,
    '未提供的经验、器械与时长使用保守假设并说明；不要把界面默认值当作用户已确认的个人信息。',
  ].join('\n');

  return { interactionMode: 'plan', singleSession: true, targetAreas, notes,
    planningScope: 'day', calendar: { localDate: date, dayIndex: now.getDay() || 7, timeZone },
    schedule: { availableDaysPerWeek: 1, preferredDays: [weekday], sessionDurationMinutes } };
}

export function getDailyPlanError(value: unknown, context: ReturnType<typeof createPlanningContext>): string | null {
  if (!value || typeof value !== 'object' || !('weeklySchedule' in value)) return null;
  const plan = value as Record<string, unknown>;
  if (!Array.isArray(plan.weeklySchedule) || plan.weeklySchedule.length !== 1 ||
      (plan.weeklyFrequency !== undefined && plan.weeklyFrequency !== 1)) {
    return '当天计划必须只有一次训练，不能把多天动作合并。';
  }
  const session = plan.weeklySchedule[0];
  if (!session || session.dayIndex !== context.calendar.dayIndex || session.dayLabel !== context.schedule.preferredDays[0]) {
    return `当天是 ${context.calendar.localDate}（${context.schedule.preferredDays[0]}），返回的训练日期不一致。`;
  }
  const exercises: Record<string, unknown>[] = Array.isArray(session.mainBlocks)
    ? session.mainBlocks.flatMap((block: Record<string, unknown>) => Array.isArray(block?.exercises) ? block.exercises : []) : [];
  if (exercises.length > 5) return '当天主训练不能超过 5 个动作，请重新生成。';
  const seen = new Set<string>();
  for (const exercise of exercises) {
    if (!exercise) continue;
    const name = typeof exercise.name === 'string' ? exercise.name.trim().toLowerCase() : '';
    if (name && seen.has(name)) return '当天计划包含重复动作，请重新生成。';
    if (name) seen.add(name);
    if (context.targetAreas.length && Array.isArray(exercise.primaryMuscles) &&
        !exercise.primaryMuscles.some((muscle) => context.targetAreas.includes(muscle))) {
      return `主训练包含与 ${context.targetAreas.join('、')} 无关的动作，请重新生成。`;
    }
  }
  return null;
}
