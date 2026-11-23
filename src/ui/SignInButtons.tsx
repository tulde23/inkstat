import { useState } from 'react';
import { Platform, useColorScheme, View } from 'react-native';

import { signIn } from '@/auth/session';
import { availableProviders, describeProviderError, SignInCancelled, type IdentityProvider } from '@/auth/socialSignIn';

import { Button, T } from './components';
import { radius, space, useColors } from './theme';

/**
 * The sign-in buttons, wherever sign-in is offered: Apple first on iPhone (its own
 * button, as Apple asks), then Google. Handles busy, cancel and errors itself, and calls
 * `onSignedIn` once there is a session.
 */
export function SignInButtons({ onSignedIn, onBusy }: { onSignedIn?: () => void | Promise<void>; onBusy?: (busy: boolean) => void }) {
  const c = useColors();
  const scheme = useColorScheme();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const providers = availableProviders();

  const go = async (provider: IdentityProvider) => {
    setBusy(true);
    onBusy?.(true);
    setError(null);
    try {
      await signIn(provider);
      await onSignedIn?.();
    } catch (e) {
      if (!(e instanceof SignInCancelled)) {
        console.warn('[sign-in]', describeProviderError(e));
        setError(e instanceof Error ? e.message : 'Sign-in did not work. Try again.');
      }
    } finally {
      setBusy(false);
      onBusy?.(false);
    }
  };

  if (!providers.length) return <T style={{ color: c.error }}>Sign-in is not set up in this build.</T>;
  return (
    <View style={{ gap: space.sm }}>
      {providers.includes('Apple') && <AppleButton dark={scheme === 'dark'} disabled={busy} onPress={() => void go('Apple')} />}
      {providers.includes('Google') && (
        <Button
          title="Sign in with Google"
          kind={providers.includes('Apple') ? 'secondary' : 'primary'}
          onPress={() => void go('Google')}
          busy={busy}
        />
      )}
      {error ? <T style={{ color: c.error, fontSize: 14 }}>{error}</T> : null}
    </View>
  );
}

/** Apple's own button, on iPhone only. Required lazily: the module reaches native code at import. */
function AppleButton({ dark, disabled, onPress }: { dark: boolean; disabled: boolean; onPress: () => void }) {
  if (Platform.OS !== 'ios') return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Apple = require('expo-apple-authentication') as typeof import('expo-apple-authentication');
  return (
    <View pointerEvents={disabled ? 'none' : 'auto'} style={{ opacity: disabled ? 0.5 : 1 }}>
      <Apple.AppleAuthenticationButton
        buttonType={Apple.AppleAuthenticationButtonType.SIGN_IN}
        buttonStyle={dark ? Apple.AppleAuthenticationButtonStyle.WHITE : Apple.AppleAuthenticationButtonStyle.BLACK}
        cornerRadius={radius.md}
        style={{ height: 50 }}
        onPress={onPress}
      />
    </View>
  );
}
