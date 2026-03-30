import { Platform } from 'react-native';

export const sketchTheme = {
  colors: {
    paper: '#FDFBF7',
    ink: '#2D2D2D',
    muted: '#E5E0D8',
    accent: '#FF4D4D',
    penBlue: '#2D5DA1',
    noteYellow: '#FFF3A9',
    white: '#FFFFFF',
    overlay: '#F5EFE6',
  },
  spacing: {
    page: 20,
    card: 18,
    barInset: 16,
    barHeight: 94,
  },
  border: {
    strong: 3,
    regular: 2,
  },
  shadow: {
    offset: 6,
  },
  radius: {
    shell: {
      borderTopLeftRadius: 34,
      borderTopRightRadius: 18,
      borderBottomLeftRadius: 26,
      borderBottomRightRadius: 32,
    },
    card: {
      borderTopLeftRadius: 30,
      borderTopRightRadius: 14,
      borderBottomLeftRadius: 20,
      borderBottomRightRadius: 30,
    },
    note: {
      borderTopLeftRadius: 24,
      borderTopRightRadius: 12,
      borderBottomLeftRadius: 16,
      borderBottomRightRadius: 24,
    },
    pill: {
      borderTopLeftRadius: 20,
      borderTopRightRadius: 10,
      borderBottomLeftRadius: 12,
      borderBottomRightRadius: 20,
    },
  },
  fonts: {
    heading: Platform.select({
      ios: 'Marker Felt',
      android: undefined,
      default: undefined,
    }),
    body: Platform.select({
      ios: 'Marker Felt',
      android: undefined,
      default: undefined,
    }),
  },
} as const;
