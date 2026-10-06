import { useIsFocused } from '@react-navigation/native';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { CalorieCameraPage } from '@/components/camera/calorie-camera-page';

export default function CameraScreen() {
  const isFocused = useIsFocused();
  const [signal, setSignal] = useState<AbortSignal>();
  useFocusEffect(useCallback(() => {
    const controller = new AbortController();
    setSignal(controller.signal);
    return () => controller.abort();
  }, []));
  return <CalorieCameraPage active={isFocused && Boolean(signal && !signal.aborted)} signal={signal} />;
}
