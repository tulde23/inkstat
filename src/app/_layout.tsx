import { IBMPlexMono_500Medium } from '@expo-google-fonts/ibm-plex-mono/500Medium';
import { IBMPlexMono_600SemiBold } from '@expo-google-fonts/ibm-plex-mono/600SemiBold';
import { IBMPlexSans_400Regular } from '@expo-google-fonts/ibm-plex-sans/400Regular';
import { IBMPlexSans_500Medium } from '@expo-google-fonts/ibm-plex-sans/500Medium';
import { IBMPlexSans_600SemiBold } from '@expo-google-fonts/ibm-plex-sans/600SemiBold';
import { IBMPlexSans_700Bold } from '@expo-google-fonts/ibm-plex-sans/700Bold';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { SQLiteProvider } from 'expo-sqlite';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useState } from 'react';
import { View } from 'react-native';

import { DB_NAME, migrate } from '@/db';
import { AnimatedSplash } from '@/ui/AnimatedSplash';
import { DialogProvider } from '@/ui/Dialog';
import { fonts, useColors } from '@/ui/theme';
import { applyThemePreference } from '@/ui/themePreference';

void SplashScreen.preventAutoHideAsync();
// Light, dark or the phone's setting, as chosen under More > Appearance.
applyThemePreference();

export default function RootLayout() {
  const c = useColors();
  const [loaded, error] = useFonts({
    IBMPlexSans_400Regular,
    IBMPlexSans_500Medium,
    IBMPlexSans_600SemiBold,
    IBMPlexSans_700Bold,
    IBMPlexMono_500Medium,
    IBMPlexMono_600SemiBold,
  });

  // A font failure should not block the app; system fonts are an acceptable fallback.
  const ready = loaded || Boolean(error);
  // The animated splash plays once per launch over the app as it loads underneath;
  // it hides the native splash itself, once its identical first frame is drawn.
  const [splashDone, setSplashDone] = useState(false);
  const finishSplash = useCallback(() => setSplashDone(true), []);
  if (!ready) return null;

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
    <SQLiteProvider databaseName={DB_NAME} onInit={migrate}>
      <StatusBar style="auto" />
      <DialogProvider>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: c.card },
          headerTintColor: c.text,
          headerTitleStyle: { fontFamily: fonts.heading },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: c.bg },
        }}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="scan" options={{ title: 'Scan a game' }} />
        <Stack.Screen name="models" options={{ title: 'Reading model' }} />
        <Stack.Screen name="season" options={{ title: 'Season' }} />
        <Stack.Screen name="account" options={{ title: 'Account' }} />
        <Stack.Screen name="team-setup" options={{ title: 'Your team', headerShown: false }} />
        <Stack.Screen name="team-edit" options={{ title: 'Team' }} />
        <Stack.Screen name="game/whose" options={{ title: 'Your team' }} />
        <Stack.Screen name="join/[code]" options={{ title: 'Join a group' }} />
        <Stack.Screen name="templates" options={{ title: 'Scorebook templates' }} />
        <Stack.Screen name="template-editor" options={{ title: 'Template' }} />
        <Stack.Screen name="bench" options={{ title: 'Test bench' }} />
        <Stack.Screen name="team/[key]" options={{ headerShown: false }} />
        <Stack.Screen name="game/[id]" options={{ title: 'Game' }} />
        <Stack.Screen name="game/box" options={{ title: 'Box score' }} />
        <Stack.Screen name="game/check" options={{ title: 'Check', presentation: 'modal', headerShown: false }} />
      </Stack>
      </DialogProvider>
    </SQLiteProvider>
    {!splashDone && <AnimatedSplash onDone={finishSplash} />}
    </View>
  );
}
