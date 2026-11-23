import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { codeFromParam, joinGroup, type Group } from '@/auth/account';
import { useSession } from '@/auth/session';
import { Button, Card, T } from '@/ui/components';
import { SignInButtons } from '@/ui/SignInButtons';
import { base, fonts, useColors } from '@/ui/theme';

type State = { kind: 'ready' } | { kind: 'joining' } | { kind: 'joined'; group: Group } | { kind: 'error'; message: string };

/**
 * Where an invite link lands: inkstat://join/<code>, opened from the invite page or
 * straight from a message. Joining needs an account, so it offers sign-in first and
 * joins straight after.
 */
export default function Join() {
  const c = useColors();
  const session = useSession();
  const code = codeFromParam(useLocalSearchParams<{ code: string }>().code);
  const [state, setState] = useState<State>({ kind: 'ready' });

  const join = async () => {
    if (!code) return;
    setState({ kind: 'joining' });
    try {
      setState({ kind: 'joined', group: await joinGroup(code) });
    } catch (e) {
      const notFound = (e as { status?: number }).status === 404;
      setState({
        kind: 'error',
        message: notFound
          ? 'That invite link doesn’t work any more. Ask the group’s owner for a new one.'
          : e instanceof Error
            ? e.message
            : String(e),
      });
    }
  };

  const done = () => (router.canGoBack() ? router.replace('/account') : router.replace('/'));

  return (
    <ScrollView style={[base.screen, { backgroundColor: c.bg }]} contentContainerStyle={base.content}>
      <Stack.Screen options={{ title: 'Join a group' }} />
      {!code ? (
        <>
          <T style={base.h1}>That link isn’t complete</T>
          <T style={styles.body}>Ask for the invite link again, or enter the code under More › Account › Join with a code.</T>
          <Button title="Go to Account" onPress={() => router.replace('/account')} />
        </>
      ) : state.kind === 'joined' ? (
        <>
          <T style={base.h1}>You’re in</T>
          <Card>
            <T style={{ fontFamily: fonts.bodySemiBold, fontSize: 17 }}>{state.group.name}</T>
            <T muted>{`${state.group.members} member${state.group.members === 1 ? '' : 's'}`}</T>
          </Card>
          <T style={styles.body}>Games shared in this group appear when you sync.</T>
          <Button title="Done" onPress={done} />
        </>
      ) : (
        <>
          <T style={base.h1}>You’ve been invited to a group</T>
          <View style={[styles.code, { borderColor: c.text, backgroundColor: c.card }]}>
            <T style={styles.codeText}>{code}</T>
          </View>
          <T muted style={styles.body}>
            A group shares games among a team’s scorekeepers and coaches. Others in the group will see your name.
          </T>
          {state.kind === 'error' && <T style={{ color: c.error }}>{state.message}</T>}
          {session ? (
            <Button title="Join the group" onPress={() => void join()} busy={state.kind === 'joining'} />
          ) : (
            <>
              <T style={styles.body}>Sign in to join. You don’t need an account for anything else.</T>
              <SignInButtons onSignedIn={join} />
            </>
          )}
          <Button title="Not now" kind="secondary" onPress={() => router.replace('/')} />
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  body: { fontSize: 16, lineHeight: 23 },
  code: { borderWidth: 1.5, borderRadius: 8, padding: 14, alignItems: 'center' },
  codeText: { fontFamily: fonts.monoBold, fontSize: 28, letterSpacing: 4 },
});
