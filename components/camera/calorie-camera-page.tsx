import { Image } from 'expo-image';
import { CameraView, type CameraCapturedPicture } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { sketchTheme } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useCamera } from '@/hooks/use-camera';
import { BackendApiError } from '@/services/backend-api';
import { analyzeMealPhoto, type CalorieAnalysisResult } from '@/services/calorie-api';

type AnalysisState = 'idle' | 'analyzing' | 'success' | 'error';
type CameraSession = { token: string | null; userId: string | null; generation: number };
type CameraOperation = CameraSession & { token: string; controller: AbortController };

export function CalorieCameraPage({ active = true, signal }: { active?: boolean; signal?: AbortSignal } = {}) {
  const router = useRouter();
  const { isAuthenticated, isHydrating, token, userId, signOut } = useAuth();
  const {
    hasPermission,
    canAskPermissionAgain,
    isPermissionLoading,
    cameraRef,
    facing,
    isCameraReady,
    isCapturing,
    lastPhoto: capturedPhoto,
    errorMessage,
    requestPermission,
    toggleFacing,
    markCameraReady,
    setCameraError,
    clearPhoto,
    takePhoto,
  } = useCamera();
  const [storedAnalysisState, setAnalysisState] = useState<AnalysisState>('idle');
  const [storedAnalysisResult, setAnalysisResult] = useState<CalorieAnalysisResult | null>(null);
  const [storedAnalysisError, setAnalysisError] = useState<string | null>(null);
  const sessionRef = useRef<CameraSession>({ token, userId: userId ?? null, generation: 0 });
  const operationRef = useRef<CameraOperation | null>(null);
  const photoOwnerRef = useRef<CameraOperation | null>(null);
  const activeRef = useRef(active);
  const mountFailedRef = useRef(false);

  // Update the guard during render so an old response is rejected even before effects run.
  const sessionChanged = sessionRef.current.token !== token || sessionRef.current.userId !== (userId ?? null);
  const activeChanged = activeRef.current !== active;
  activeRef.current = active;
  if (sessionChanged || activeChanged) {
    operationRef.current?.controller.abort();
    if (sessionChanged) {
      sessionRef.current = { token, userId: userId ?? null, generation: sessionRef.current.generation + 1 };
    }
    operationRef.current = null;
    if (storedAnalysisState === 'analyzing') {
      setAnalysisState('error');
      setAnalysisResult(null);
      setAnalysisError(sessionChanged
        ? '登录状态已改变，照片已保留，请登录后重新上传。'
        : '识别已暂停，照片已保留，返回后可以重新上传。');
    }
    if (activeChanged) { mountFailedRef.current = false; setCameraError(null); }
  }
  const ownerChanged = Boolean(userId && photoOwnerRef.current && photoOwnerRef.current.userId !== userId);
  if (ownerChanged) {
    // These states belong to this component, including the useCamera hook's photo state.
    photoOwnerRef.current = null;
    clearPhoto();
    setAnalysisState('idle');
    setAnalysisResult(null);
    setAnalysisError(null);
  }
  const lastPhoto = ownerChanged ? null : capturedPhoto;
  const analysisState = ownerChanged ? 'idle' : storedAnalysisState;
  const analysisResult = ownerChanged ? null : storedAnalysisResult;
  const analysisError = ownerChanged ? null : storedAnalysisError;
  const renderedSession = sessionRef.current;
  const canAnalyze = isAuthenticated && Boolean(token) && !isHydrating;

  const isCurrent = (operation: CameraOperation) =>
    activeRef.current && !signal?.aborted && !operation.controller.signal.aborted &&
    operationRef.current === operation && sessionRef.current.generation === operation.generation &&
    sessionRef.current.token === operation.token && sessionRef.current.userId === operation.userId;

  const analyzePhoto = async (picture: CameraCapturedPicture, operation: CameraOperation) => {
    if (!isCurrent(operation)) return;

    setAnalysisState('analyzing');
    setAnalysisResult(null);
    setAnalysisError(null);

    try {
      const result = await analyzeMealPhoto(picture, {
        token: operation.token, isCurrent: () => isCurrent(operation), signal: operation.controller.signal,
      });
      if (!isCurrent(operation)) return;
      setAnalysisResult(result);
      setAnalysisState('success');
    } catch (error) {
      if (!isCurrent(operation)) return;
      let message = error instanceof Error ? error.message : '热量识别失败，请稍后再试。';

      if (error instanceof BackendApiError && error.status >= 500) {
        message = '识别服务暂时不可用，请稍后重新上传，照片已保留。';
      }
      if (/无法连接到|Failed to fetch|Network request failed/i.test(message)) {
        message = '网络连接异常，请重新上传，照片已保留。';
      }

      const isUnauthorized = error instanceof BackendApiError && error.status === 401;
      if (isUnauthorized) {
        message = '登录状态已失效，请重新登录后重试，照片已保留。';
      }
      setAnalysisError(message);
      setAnalysisState('error');

      if (isUnauthorized) {
        try {
          await signOut(operation.token);
        } catch {
          if (!sessionRef.current.token && photoOwnerRef.current === operation) {
            setAnalysisError(message + '已退出当前会话，但未能清除本地登录记录。');
          }
        }
      }
    }
  };

  const handleCapture = async () => {
    if (!active || signal?.aborted) return;
    if (!canAnalyze) {
      setAnalysisError('请先登录，再拍照识别食物热量。');
      setAnalysisState('error');
      return;
    }
    if (renderedSession !== sessionRef.current || operationRef.current || isCapturing || !token) {
      return;
    }

    const operation = { ...renderedSession, token, controller: new AbortController() };
    const cancel = () => operation.controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    operationRef.current = operation;
    photoOwnerRef.current = operation;
    try {
      const picture = await takePhoto(() => isCurrent(operation));
      if (!isCurrent(operation)) return;
      if (picture) {
        await analyzePhoto(picture, operation);
      }
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (operationRef.current === operation) operationRef.current = null;
    }
  };

  const handleRetake = () => {
    if (operationRef.current) {
      return;
    }
    clearPhoto();
    photoOwnerRef.current = null;
    setAnalysisState('idle');
    setAnalysisResult(null);
    setAnalysisError(null);
  };

  const handleRetryUpload = async () => {
    if (!active || signal?.aborted) return;
    if (renderedSession !== sessionRef.current || !lastPhoto || operationRef.current) {
      return;
    }

    if (!canAnalyze || !token) {
      setAnalysisError('请先登录，再识别食物热量。照片会保留，登录后可以重新上传。');
      setAnalysisState('error');
      return;
    }
    const operation = { ...renderedSession, token, controller: new AbortController() };
    const cancel = () => operation.controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    operationRef.current = operation;
    photoOwnerRef.current = operation;
    try {
      await analyzePhoto(lastPhoto, operation);
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (operationRef.current === operation) operationRef.current = null;
    }
  };

  const openSettings = async () => {
    if (Platform.OS === 'web') {
      return;
    }

    await Linking.openSettings();
  };

  const renderPermissionCard = () => {
    if (isPermissionLoading) {
      return (
        <View style={[styles.infoCard, styles.sketchShadow]}>
          <Text style={styles.infoTitle}>权限检查中</Text>
          <Text style={styles.infoBody}>正在读取相机授权状态，马上就能进入拍照页。</Text>
        </View>
      );
    }

    return null;
  };

  const renderBoardStatus = () => {
    if (!hasPermission && !isPermissionLoading) {
      if (canAskPermissionAgain) {
        return (
          <Pressable onPress={() => void requestPermission()} style={[styles.stateBadge, styles.stateBadgeAction]}>
            <Text style={[styles.stateBadgeText, styles.stateBadgeActionText]}>打开相机权限</Text>
          </Pressable>
        );
      }

      if (Platform.OS !== 'web') {
        return (
          <Pressable onPress={() => void openSettings()} style={[styles.stateBadge, styles.stateBadgeAction]}>
            <Text style={[styles.stateBadgeText, styles.stateBadgeActionText]}>前往系统设置</Text>
          </Pressable>
        );
      }
    }

    return (
      <View style={styles.stateBadge}>
        <Text style={styles.stateBadgeText}>{statusText}</Text>
      </View>
    );
  };

  const statusText =
    analysisState === 'analyzing'
      ? '正在计算食物的热量...'
      : analysisState === 'success'
        ? '识别完成'
        : analysisState === 'error'
          ? '识别失败'
          : !canAnalyze
            ? isHydrating ? '正在恢复登录状态' : '请先登录'
            : !hasPermission && !isPermissionLoading
            ? '相机权限未开启'
            : errorMessage
            ? '相机不可用'
            : isCameraReady
            ? '请把食物放进取景框'
            : '正在打开相机';

  const helperText =
    analysisState === 'analyzing'
      ? '照片已经提交，正在识别这份食物的大致热量。'
      : analysisState === 'success'
        ? analysisResult?.summary ?? '识别结果已经准备好，你也可以继续重拍下一份食物。'
        : analysisState === 'error'
          ? analysisError ?? '这次识别没有完成，请稍后再试。'
          : !canAnalyze
            ? '登录后即可拍照识别食物热量。'
            : '拍下食物后会自动开始识别，并给出热量估算。';

  return (
    <SafeAreaView edges={['top']} style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.page} showsVerticalScrollIndicator={false}>
        <View pointerEvents="none" style={[styles.doodleCircle, styles.doodleCircleTop]} />
        <View pointerEvents="none" style={[styles.doodleCircle, styles.doodleCircleBottom]} />
        <View pointerEvents="none" style={styles.dashedLoop} />

        <View style={[styles.heroCard, styles.sketchShadow]}>
          <View style={styles.tapeStrip} />
          <View style={styles.heroHeader}>
            <Text style={styles.eyebrow}>饮食记录</Text>
            <View style={styles.heroPin} />
          </View>
          <Text style={styles.heroTitle}>拍照识别食物热量</Text>
          <Text style={styles.heroNote}>
            拍下眼前这份食物，我们会尽快给出热量估算，方便你更轻松地记录每一餐。
          </Text>
        </View>

        {renderPermissionCard()}

        <View style={[styles.cameraBoard, styles.sketchShadow]}>
          <View style={styles.boardHeader}>
            <Text style={styles.boardTitle}>拍照识别</Text>
            {renderBoardStatus()}
          </View>

          <View style={styles.cameraStage}>
            {lastPhoto ? (
              <Image contentFit="cover" source={{ uri: lastPhoto.uri }} style={styles.cameraFill} />
            ) : hasPermission && active ? (
              <CameraView
                key={facing}
                ref={cameraRef}
                style={styles.cameraFill}
                facing={facing}
                mirror={facing === 'front'}
                onCameraReady={() => { if (!mountFailedRef.current) markCameraReady(); }}
                onMountError={() => {
                  mountFailedRef.current = true;
                  setCameraError('无法打开相机，请确认设备存在且未被其他应用占用。');
                }}
              />
            ) : (
              <View style={styles.lockedStage}>
                <Text style={styles.lockedStageTitle}>等待授权后开启相机</Text>
                <Text style={styles.lockedStageText}>授权完成后，这里会展示实时取景画面。</Text>
              </View>
            )}

            <View pointerEvents="box-none" style={styles.stageOverlay}>
              <View style={styles.overlayTopRow}>
                <View style={styles.lensBadge}>
                  <Text style={styles.lensBadgeText}>
                    {facing === 'back' ? '后置镜头' : '前置镜头'}
                  </Text>
                </View>

                {!lastPhoto && hasPermission ? (
                  <Pressable disabled={isCapturing} onPress={() => {
                    if (!operationRef.current && !isCapturing) {
                      mountFailedRef.current = false;
                      toggleFacing();
                    }
                  }} style={styles.overlayGhostButton}>
                    <Text style={styles.overlayGhostButtonText}>切换镜头</Text>
                  </Pressable>
                ) : null}
              </View>

              <View style={styles.captureDock}>
                {!lastPhoto ? (
                  <>
                    <Text style={styles.captureHint}>
                      {canAnalyze ? '对准餐盘，点击快门后自动识别热量' : '请先登录，再拍照识别热量'}
                    </Text>
                    <Pressable
                      accessibilityLabel="拍照并识别食物热量"
                      disabled={!active || !canAnalyze || !hasPermission || !isCameraReady || isCapturing}
                      onPress={handleCapture}
                      style={[
                        styles.captureButton,
                        (!canAnalyze || !hasPermission || !isCameraReady || isCapturing) &&
                          styles.captureButtonDisabled,
                      ]}>
                      <View style={styles.captureButtonInner} />
                    </Pressable>
                  </>
                ) : (
                  <View style={styles.previewActions}>
                    <Pressable
                      disabled={analysisState === 'analyzing'}
                      onPress={handleRetake}
                      style={styles.overlayGhostButton}>
                      <Text style={styles.overlayGhostButtonText}>重新拍摄</Text>
                    </Pressable>
                    {analysisState === 'error' ? (
                      <Pressable
                        disabled={isHydrating}
                        onPress={canAnalyze ? handleRetryUpload : () => router.navigate('/(tabs)/profile')}
                        style={styles.overlaySolidButton}>
                        <Text style={styles.overlaySolidButtonText}>
                          {canAnalyze ? '重新上传' : '登录后重试'}
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                )}
              </View>
            </View>

            {analysisState === 'analyzing' ? (
              <View style={styles.loadingSheet}>
                <ActivityIndicator color={sketchTheme.colors.accent} size="large" />
                <Text style={styles.loadingTitle}>正在计算食物的热量</Text>
                <Text style={styles.loadingText}>图片已经拍好，识别结果很快就会返回。</Text>
              </View>
            ) : null}
          </View>

          <View style={styles.boardFooter}>
            <Text style={styles.boardFooterText}>{helperText}</Text>
            {errorMessage ? <Text style={styles.errorText}>相机出现问题：{errorMessage}</Text> : null}
            {!canAnalyze && !isHydrating && !lastPhoto ? (
              <Pressable
                onPress={() => router.navigate('/(tabs)/profile')}
                style={styles.overlaySolidButton}>
                <Text style={styles.overlaySolidButtonText}>前往登录</Text>
              </Pressable>
            ) : null}
          </View>
        </View>

        <View style={styles.resultRow}>
          <View style={[styles.metricCard, styles.sketchShadow]}>
            <Text style={styles.metricLabel}>热量估算</Text>
            <View style={styles.metricValueRow}>
              <Text style={styles.metricValue}>
                {analysisResult?.calories != null ? Math.round(analysisResult.calories) : '--'}
              </Text>
              <Text style={styles.metricUnit}>千卡</Text>
            </View>
            <Text style={styles.metricNote}>{analysisResult?.title ?? '等待识别菜品名称和热量结果。'}</Text>
          </View>
        </View>
      </ScrollView>
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
    gap: 22,
    minHeight: '100%',
    overflow: 'hidden',
    paddingBottom: 20,
    paddingHorizontal: sketchTheme.spacing.page,
    paddingTop: 10,
  },
  doodleCircle: {
    backgroundColor: sketchTheme.colors.muted,
    borderRadius: 999,
    opacity: 0.7,
    position: 'absolute',
  },
  doodleCircleTop: {
    height: 14,
    right: 34,
    top: 28,
    width: 14,
  },
  doodleCircleBottom: {
    bottom: 138,
    height: 20,
    left: 16,
    width: 20,
  },
  dashedLoop: {
    borderColor: sketchTheme.colors.ink,
    borderRadius: 999,
    borderStyle: 'dashed',
    borderWidth: 2,
    height: 60,
    opacity: 0.28,
    position: 'absolute',
    right: 22,
    top: 108,
    transform: [{ rotate: '13deg' }],
    width: 104,
  },
  sketchShadow: {
    shadowColor: 'transparent',
  },
  heroCard: {
    backgroundColor: sketchTheme.colors.white,
    borderColor: sketchTheme.colors.ink,
    borderWidth: sketchTheme.border.strong,
    paddingBottom: 22,
    paddingHorizontal: 18,
    paddingTop: 22,
    position: 'relative',
    transform: [{ rotate: '-1deg' }],
    ...sketchTheme.radius.card,
  },
  tapeStrip: {
    alignSelf: 'center',
    backgroundColor: '#D9D4CD',
    borderRadius: 8,
    height: 16,
    opacity: 0.92,
    position: 'absolute',
    top: -8,
    transform: [{ rotate: '-8deg' }],
    width: 92,
  },
  heroHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  eyebrow: {
    color: sketchTheme.colors.penBlue,
    fontSize: 15,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  heroPin: {
    backgroundColor: sketchTheme.colors.accent,
    borderColor: sketchTheme.colors.ink,
    borderRadius: 999,
    borderWidth: 2,
    height: 18,
    width: 18,
  },
  heroTitle: {
    color: sketchTheme.colors.ink,
    fontSize: 34,
    lineHeight: 40,
    marginBottom: 10,
    ...(sketchTheme.fonts.heading ? { fontFamily: sketchTheme.fonts.heading } : null),
  },
  heroNote: {
    color: sketchTheme.colors.ink,
    fontSize: 17,
    lineHeight: 25,
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  infoCard: {
    backgroundColor: sketchTheme.colors.white,
    borderColor: sketchTheme.colors.ink,
    borderWidth: sketchTheme.border.strong,
    gap: 10,
    padding: 18,
    transform: [{ rotate: '0.9deg' }],
    ...sketchTheme.radius.note,
  },
  infoTitle: {
    color: sketchTheme.colors.ink,
    fontSize: 22,
    ...(sketchTheme.fonts.heading ? { fontFamily: sketchTheme.fonts.heading } : null),
  },
  infoBody: {
    color: sketchTheme.colors.ink,
    fontSize: 16,
    lineHeight: 24,
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  cameraBoard: {
    backgroundColor: sketchTheme.colors.noteYellow,
    borderColor: sketchTheme.colors.ink,
    borderWidth: sketchTheme.border.strong,
    gap: 16,
    padding: 16,
    transform: [{ rotate: '1deg' }],
    ...sketchTheme.radius.card,
  },
  boardHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
  },
  boardTitle: {
    color: sketchTheme.colors.ink,
    fontSize: 24,
    ...(sketchTheme.fonts.heading ? { fontFamily: sketchTheme.fonts.heading } : null),
  },
  stateBadge: {
    backgroundColor: sketchTheme.colors.white,
    borderColor: sketchTheme.colors.ink,
    borderStyle: 'dashed',
    borderWidth: 2,
    maxWidth: '58%',
    paddingHorizontal: 12,
    paddingVertical: 8,
    ...sketchTheme.radius.pill,
  },
  stateBadgeText: {
    color: sketchTheme.colors.ink,
    fontSize: 13,
    textAlign: 'center',
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  stateBadgeAction: {
    backgroundColor: sketchTheme.colors.accent,
    borderStyle: 'solid',
  },
  stateBadgeActionText: {
    color: sketchTheme.colors.white,
  },
  cameraStage: {
    backgroundColor: '#1F2937',
    borderColor: sketchTheme.colors.ink,
    borderWidth: sketchTheme.border.strong,
    height: 448,
    overflow: 'hidden',
    position: 'relative',
    ...sketchTheme.radius.note,
  },
  cameraFill: {
    height: '100%',
    width: '100%',
  },
  lockedStage: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  lockedStageTitle: {
    color: sketchTheme.colors.white,
    fontSize: 24,
    marginBottom: 8,
    textAlign: 'center',
    ...(sketchTheme.fonts.heading ? { fontFamily: sketchTheme.fonts.heading } : null),
  },
  lockedStageText: {
    color: '#E5E7EB',
    fontSize: 16,
    lineHeight: 24,
    textAlign: 'center',
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  stageOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'space-between',
    padding: 16,
  },
  overlayTopRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  lensBadge: {
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderColor: sketchTheme.colors.ink,
    borderWidth: sketchTheme.border.regular,
    paddingHorizontal: 12,
    paddingVertical: 8,
    ...sketchTheme.radius.pill,
  },
  lensBadgeText: {
    color: sketchTheme.colors.ink,
    fontSize: 14,
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  overlayGhostButton: {
    backgroundColor: 'rgba(31, 41, 55, 0.72)',
    borderColor: sketchTheme.colors.white,
    borderWidth: 2,
    paddingHorizontal: 14,
    paddingVertical: 10,
    ...sketchTheme.radius.pill,
  },
  overlayGhostButtonText: {
    color: sketchTheme.colors.white,
    fontSize: 14,
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  overlaySolidButton: {
    backgroundColor: sketchTheme.colors.accent,
    borderColor: sketchTheme.colors.ink,
    borderWidth: sketchTheme.border.regular,
    paddingHorizontal: 14,
    paddingVertical: 10,
    ...sketchTheme.radius.pill,
  },
  overlaySolidButtonText: {
    color: sketchTheme.colors.white,
    fontSize: 14,
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  captureDock: {
    alignItems: 'center',
    gap: 12,
  },
  captureHint: {
    color: sketchTheme.colors.white,
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  captureButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.28)',
    borderRadius: 999,
    height: 84,
    justifyContent: 'center',
    width: 84,
  },
  captureButtonDisabled: {
    opacity: 0.45,
  },
  captureButtonInner: {
    backgroundColor: sketchTheme.colors.white,
    borderRadius: 999,
    height: 60,
    width: 60,
  },
  previewActions: {
    flexDirection: 'row',
    gap: 10,
  },
  loadingSheet: {
    alignItems: 'center',
    backgroundColor: 'rgba(253, 251, 247, 0.94)',
    borderColor: sketchTheme.colors.ink,
    borderWidth: sketchTheme.border.regular,
    gap: 8,
    left: 18,
    paddingHorizontal: 20,
    paddingVertical: 18,
    position: 'absolute',
    right: 18,
    top: 150,
    ...sketchTheme.radius.note,
  },
  loadingTitle: {
    color: sketchTheme.colors.ink,
    fontSize: 24,
    textAlign: 'center',
    ...(sketchTheme.fonts.heading ? { fontFamily: sketchTheme.fonts.heading } : null),
  },
  loadingText: {
    color: sketchTheme.colors.ink,
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  boardFooter: {
    gap: 6,
  },
  boardFooterText: {
    color: sketchTheme.colors.ink,
    fontSize: 15,
    lineHeight: 22,
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  errorText: {
    color: '#9F1239',
    fontSize: 14,
    lineHeight: 20,
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  resultRow: {
    gap: 16,
  },
  metricCard: {
    backgroundColor: sketchTheme.colors.white,
    borderColor: sketchTheme.colors.ink,
    borderWidth: sketchTheme.border.strong,
    padding: 18,
    transform: [{ rotate: '-0.8deg' }],
    ...sketchTheme.radius.card,
  },
  metricLabel: {
    color: sketchTheme.colors.penBlue,
    fontSize: 15,
    letterSpacing: 1,
    marginBottom: 10,
    textTransform: 'uppercase',
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  metricValueRow: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  metricValue: {
    color: sketchTheme.colors.ink,
    fontSize: 52,
    lineHeight: 56,
    ...(sketchTheme.fonts.heading ? { fontFamily: sketchTheme.fonts.heading } : null),
  },
  metricUnit: {
    color: sketchTheme.colors.ink,
    fontSize: 20,
    marginBottom: 8,
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  metricNote: {
    color: sketchTheme.colors.ink,
    fontSize: 16,
    lineHeight: 24,
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
});
