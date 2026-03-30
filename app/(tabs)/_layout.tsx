import { Tabs } from 'expo-router';

import CustomBottomTab from '@/components/CustomBottomTab';
import { sketchTheme } from '@/constants/theme';

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        animation: 'none',
        headerShown: false,
        sceneStyle: { backgroundColor: sketchTheme.colors.paper },
      }}
      tabBar={(props) => <CustomBottomTab {...props} />}>
      <Tabs.Screen
        name="camera"
        options={{
          title: '拍照',
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: '聊天',
        }}
      />
      <Tabs.Screen
        name="fitness"
        options={{
          title: '训练',
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: '我的',
        }}
      />
      <Tabs.Screen
        name="workout"
        options={{
          href: null,
        }}
      />
    </Tabs>
  );
}
