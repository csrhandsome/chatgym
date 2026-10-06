import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { sketchTheme } from '@/constants/theme';

const TAB_META = {
  camera: {
    label: '拍照',
    icon: require('../assets/icons/camera-line.png'),
    pinColor: sketchTheme.colors.penBlue,
    tilt: '-2deg',
  },
  chat: {
    label: '聊天',
    icon: require('../assets/icons/chat-bubble-line.png'),
    pinColor: sketchTheme.colors.accent,
    tilt: '1.5deg',
  },
  fitness: {
    label: '训练',
    icon: require('../assets/icons/dumbbell-line.png'),
    pinColor: sketchTheme.colors.noteYellow,
    tilt: '-1.5deg',
  },
  profile: {
    label: '我的',
    icon: require('../assets/icons/profile-line.png'),
    pinColor: sketchTheme.colors.penBlue,
    tilt: '2deg',
  },
} as const;

type TabRouteName = keyof typeof TAB_META;

function isTabRouteName(routeName: string): routeName is TabRouteName {
  return routeName in TAB_META;
}

type TabButtonProps = {
  icon: (typeof TAB_META)[TabRouteName]['icon'];
  isFocused: boolean;
  label: string;
  onLongPress: () => void;
  onPress: () => void;
  pinColor: string;
  tilt: string;
};

function TabButton({
  icon,
  isFocused,
  label,
  onLongPress,
  onPress,
  pinColor,
  tilt,
}: TabButtonProps) {
  const motionStyle = useAnimatedStyle(() => ({
    opacity: withTiming(isFocused ? 1 : 0.88, { duration: 160 }),
    transform: [
      { translateY: withSpring(isFocused ? -6 : 0, SPRING_CONFIG) },
      { scale: withSpring(isFocused ? 1.02 : 0.82, SPRING_CONFIG) },
      { rotate: isFocused ? '0deg' : tilt },
    ],
  }));

  const labelStyle = useAnimatedStyle(() => ({
    opacity: withTiming(isFocused ? 1 : 0.78, { duration: 160 }),
  }));

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: isFocused }}
      onLongPress={onLongPress}
      onPress={onPress}
      style={styles.tabSlot}>
      <Animated.View style={[styles.motionWrap, motionStyle]}>
        {isFocused ? <View pointerEvents="none" style={styles.activeShadow} /> : null}
        <View style={[styles.tabChip, isFocused ? styles.tabChipActive : styles.tabChipIdle]}>
          <View style={[styles.pin, { backgroundColor: pinColor }]} />
          <Image
            resizeMode="contain"
            source={icon}
            style={[
              styles.icon,
              {
                tintColor: isFocused
                  ? sketchTheme.colors.white
                  : sketchTheme.colors.ink,
              },
            ]}
          />
          <Animated.Text
            numberOfLines={1}
            style={[
              styles.label,
              labelStyle,
              {
                color: isFocused
                  ? sketchTheme.colors.white
                  : sketchTheme.colors.ink,
              },
            ]}>
            {label}
          </Animated.Text>
        </View>
      </Animated.View>
    </Pressable>
  );
}

export default function CustomBottomTab({
  descriptors,
  insets,
  navigation,
  state,
}: BottomTabBarProps) {
  const bottomInset = Math.max(insets.bottom, 10);

  return (
    <View style={[styles.outer, { paddingBottom: bottomInset }]}>
      <View style={styles.barRotation}>
        <View pointerEvents="none" style={styles.barShadow} />
        <View style={[styles.barSurface, { minHeight: sketchTheme.spacing.barHeight }]}>
          {state.routes.map((route, index) => {
            if (!isTabRouteName(route.name)) {
              return null;
            }

            const isFocused = state.index === index;
            const meta = TAB_META[route.name];
            const options = descriptors[route.key]?.options;

            const onPress = () => {
              const event = navigation.emit({
                type: 'tabPress',
                target: route.key,
                canPreventDefault: true,
              });

              if (!isFocused && !event.defaultPrevented) {
                navigation.navigate(route.name);
              }
            };

            const onLongPress = () => {
              navigation.emit({
                type: 'tabLongPress',
                target: route.key,
              });
            };

            return (
              <TabButton
                key={route.key}
                icon={meta.icon}
                isFocused={isFocused}
                label={String(options?.title ?? meta.label)}
                onLongPress={onLongPress}
                onPress={onPress}
                pinColor={meta.pinColor}
                tilt={meta.tilt}
              />
            );
          })}
        </View>
      </View>
    </View>
  );
}

const SPRING_CONFIG = {
  damping: 14,
  mass: 0.85,
  stiffness: 220,
};

const styles = StyleSheet.create({
  outer: {
    backgroundColor: sketchTheme.colors.paper,
    paddingHorizontal: sketchTheme.spacing.barInset,
    paddingTop: 10,
  },
  barRotation: {
    position: 'relative',
    transform: [{ rotate: '-1deg' }],
  },
  barShadow: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: sketchTheme.colors.ink,
    transform: [
      { translateX: sketchTheme.shadow.offset },
      { translateY: sketchTheme.shadow.offset },
    ],
    ...sketchTheme.radius.shell,
  },
  barSurface: {
    alignItems: 'center',
    backgroundColor: sketchTheme.colors.white,
    borderColor: sketchTheme.colors.ink,
    borderWidth: sketchTheme.border.strong,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 12,
    ...sketchTheme.radius.shell,
  },
  tabSlot: {
    flex: 1,
  },
  motionWrap: {
    minWidth: 0,
    position: 'relative',
  },
  activeShadow: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: sketchTheme.colors.ink,
    transform: [{ translateX: 4 }, { translateY: 4 }],
    ...sketchTheme.radius.note,
  },
  tabChip: {
    alignItems: 'center',
    borderColor: sketchTheme.colors.ink,
    gap: 4,
    justifyContent: 'center',
    minHeight: 68,
    paddingHorizontal: 6,
    paddingVertical: 10,
    position: 'relative',
    ...sketchTheme.radius.note,
  },
  tabChipActive: {
    backgroundColor: sketchTheme.colors.accent,
    borderWidth: sketchTheme.border.strong,
  },
  tabChipIdle: {
    backgroundColor: sketchTheme.colors.overlay,
    borderWidth: sketchTheme.border.regular,
  },
  pin: {
    borderColor: sketchTheme.colors.ink,
    borderRadius: 999,
    borderWidth: 2,
    height: 12,
    position: 'absolute',
    right: 10,
    top: 8,
    width: 12,
  },
  icon: {
    height: 24,
    marginTop: 2,
    width: 24,
  },
  label: {
    fontSize: 12,
    letterSpacing: 0.2,
    lineHeight: 15,
    textAlign: 'center',
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
});
