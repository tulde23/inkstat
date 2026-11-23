import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';

import { signOut, useSession } from '@/auth/session';
import { syncNow, type SyncResult } from '@/sync/client';

import { Button, ProgressBar, T } from './components';
import { SignInButtons } from './SignInButtons';
import { fonts, radius, space, useColors } from './theme';

type Phase =
  | { kind: 'signin'; busy?: boolean }
  | { kind: 'syncing'; fraction: number; step: string }
  | { kind: 'done'; result: SyncResult }
  | { kind: 'error'; message: string };

const summary = (r: SyncResult) => {
  const moved = r.pushed + r.pulled + r.deleted;
  if (!moved) return 'Everything was already up to date.';
  return [
    r.pushed ? `${r.pushed} sent` : null,
    r.pulled ? `${r.pulled} received` : null,
    r.deleted ? `${r.deleted} removed` : null,
  ]
    .filter(Boolean)
    .join(' · ');
};

/**
 * The sync button's window: "Syncing" with a progress bar, then "Done". Signs in
 * first (Apple on iPhone, Google) when there is no account on this phone.
 */
export function SyncSheet({ visible, onClose, onSynced }: { visible: boolean; onClose: () => void; onSynced?: () => void }) {
  const db = useSQLiteContext();
  const c = useColors();
  const session = useSession();
  const [phase, setPhase] = useState<Phase>({ kind: 'syncing', fraction: 0, step: 'Starting' });
  const started = useRef(false);

  const run = async () => {
    setPhase({ kind: 'syncing', fraction: 0.02, step: 'Starting' });
    try {
      const result = await syncNow(db, (fraction, step) => setPhase({ kind: 'syncing', fraction, step }));
      setPhase({ kind: 'done', result });
      onSynced?.();
    } catch (e) {
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  useEffect(() => {
    if (!visible) {
      started.current = false;
      return;
    }
    if (started.current) return;
    started.current = true;
    // Opening the window is the whole action: sync straight away, or sign in first.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the window's first state depends on the session at open time
    if (!session) setPhase({ kind: 'signin' });
    else void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const busy = phase.kind === 'syncing' || (phase.kind === 'signin' && phase.busy);

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={() => { if (!busy) onClose(); }}>
      <Pressable
        accessibilityLabel="Close"
        onPress={() => { if (!busy) onClose(); }}
        style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(34,32,28,0.45)' }]}
      />
      <View pointerEvents="box-none" style={styles.center}>
        <View style={[styles.box, { backgroundColor: c.card, borderColor: c.text }]} accessibilityLiveRegion="polite">
          {phase.kind === 'signin' && (
            <>
              <T style={styles.title}>Sign in to sync</T>
              <T muted style={styles.body}>
                Your games and templates are kept with your account, so they are on every phone you sign in on.
              </T>
              <SignInButtons onSignedIn={run} onBusy={(busy) => setPhase((p) => (p.kind === 'signin' ? { kind: 'signin', busy } : p))} />
              {!phase.busy && <Button title="Not now" kind="secondary" onPress={onClose} />}
            </>
          )}
          {phase.kind === 'syncing' && (
            <>
              <T style={styles.title}>Syncing</T>
              <ProgressBar fraction={phase.fraction} />
              <T muted style={styles.body}>{phase.step}…</T>
            </>
          )}
          {phase.kind === 'done' && (
            <>
              <T style={[styles.title, { color: c.ok }]}>Done ✓</T>
              <ProgressBar fraction={1} />
              <T muted style={styles.body}>{summary(phase.result)}</T>
              <Button title="OK" onPress={onClose} />
              {session && (
                <View style={styles.account}>
                  <T muted style={{ fontSize: 13, flex: 1 }}>{`Signed in as ${session.user.displayName}`}</T>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      void signOut();
                      onClose();
                    }}
                    style={styles.link}>
                    <T style={{ color: c.accent, fontFamily: fonts.bodySemiBold, fontSize: 13 }}>Sign out</T>
                  </Pressable>
                </View>
              )}
            </>
          )}
          {phase.kind === 'error' && (
            <>
              <T style={[styles.title, { color: c.error }]}>Sync did not finish</T>
              <T style={styles.body}>{phase.message}</T>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <Button title="Close" kind="secondary" onPress={onClose} />
                </View>
                <View style={{ flex: 1 }}>
                  <Button title="Try again" onPress={() => (session ? void run() : setPhase({ kind: 'signin' }))} />
                </View>
              </View>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', padding: 20 },
  box: { borderWidth: 1.5, borderRadius: radius.lg, padding: 20, gap: space.md },
  title: { fontSize: 20, fontFamily: fonts.bodyBold },
  body: { fontSize: 15, lineHeight: 21 },
  account: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  link: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
});
