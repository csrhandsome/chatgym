import { useRef, useState } from 'react';
import {
  CameraView,
  useCameraPermissions,
  type CameraCapturedPicture,
  type CameraType,
} from 'expo-camera';

export function useCamera() {
  const cameraRef = useRef<CameraView | null>(null);
  const [permission, requestPermissionAsync] = useCameraPermissions();
  const [facing, setFacing] = useState<CameraType>('back');
  const [isCameraReady, setIsCameraReady] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [lastPhoto, setLastPhoto] = useState<CameraCapturedPicture | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const requestPermission = async () => {
    setErrorMessage(null);

    const response = await requestPermissionAsync();

    if (!response.granted) {
      setErrorMessage(
        response.canAskAgain
          ? '需要相机权限才能继续拍照。'
          : '相机权限已被拒绝，请前往系统设置手动开启。'
      );
    }

    return response.granted;
  };

  const toggleFacing = () => {
    setIsCameraReady(false);
    setFacing((currentFacing) => (currentFacing === 'back' ? 'front' : 'back'));
  };

  const markCameraReady = () => {
    setIsCameraReady(true);
    setErrorMessage(null);
  };

  const setCameraError = (message: string | null) => {
    setIsCameraReady(false);
    setErrorMessage(message);
  };

  const clearPhoto = () => {
    setLastPhoto(null);
    setErrorMessage(null);
  };

  const takePhoto = async () => {
    if (!permission?.granted) {
      const granted = await requestPermission();

      if (!granted) {
        return null;
      }
    }

    if (!cameraRef.current) {
      setErrorMessage('相机还没有初始化完成。');
      return null;
    }

    if (!isCameraReady) {
      setErrorMessage('相机预览尚未就绪，请稍后再试。');
      return null;
    }

    if (isCapturing) {
      return null;
    }

    setIsCapturing(true);
    setErrorMessage(null);

    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.7,
        skipProcessing: false,
      });

      setLastPhoto(photo);
      return photo;
    } catch (error) {
      const message = error instanceof Error ? error.message : '拍照失败，请重试。';
      setErrorMessage(message);
      return null;
    } finally {
      setIsCapturing(false);
    }
  };

  return {
    permission,
    hasPermission: permission?.granted ?? false,
    canAskPermissionAgain: permission?.canAskAgain ?? true,
    isPermissionLoading: permission === null,
    cameraRef,
    facing,
    isCameraReady,
    isCapturing,
    lastPhoto,
    errorMessage,
    requestPermission,
    toggleFacing,
    markCameraReady,
    setCameraError,
    clearPhoto,
    takePhoto,
  };
}
