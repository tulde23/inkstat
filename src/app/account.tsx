import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Share, StyleSheet, View } from 'react-native';

import {
  createGroup,
  deleteAccount,
  getMe,
  inviteLink,
  isInviteCode,
  joinGroup,
  leaveGroup,
  rename,
  type Group,
  type Me,
} from '@/auth/account';
import { ApiError, signOut, useSession } from '@/auth/session';
import { Button, Card, T } from '@/ui/components';
import { useDialog } from '@/ui/Dialog';
import { EditSheet, type SheetField } from '@/ui/EditSheet';
import { SignInButtons } from '@/ui/SignInButtons';
import { base, fonts, space, useColors } from '@/ui/theme';

type Editing = 'name' | 'group' | 'join' | null;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * More › Account. Signing in is optional: scanning and exporting never need it. An
 * account keeps games on every phone (Sync) and lets a team's scorekeepers share them
 * in a group, joined by an invite link.
 */
export default function Account() {
  const c = useColors();
  const dialog = useDialog();
  const session = useSession();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setMe(await getMe());
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setMe(null);
      else setError(message(e));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (session) void load();
    }, [session, load]),
  );

  /** Runs a change, then reloads; errors go to a notice. */
  const act = async (what: () => Promise<unknown>, failTitle: string) => {
    setBusy(true);
    try {
      await what();
      await load();
    } catch (e) {
      await dialog.notice(failTitle, message(e));
    } finally {
      setBusy(false);
    }
  };

  if (!session) {
    return (
      <ScrollView style={[base.screen, { backgroundColor: c.bg }]} contentContainerStyle={base.content}>
        <T style={base.h1}>Account</T>
        <T style={styles.body}>You don’t need an account to scan, check or export games.</T>
        <T muted style={styles.body}>Sign in when you want to:</T>
        <View style={{ gap: 4 }}>
          <T style={styles.body}>• keep your games on every phone you use</T>
          <T style={styles.body}>• share games with your team’s other scorekeepers in a group</T>
        </View>
        <T muted style={styles.small}>InkStat keeps your name and email address only. Your photos stay on this phone.</T>
        <SignInButtons onSignedIn={load} />
      </ScrollView>
    );
  }

  const user = me?.user ?? { id: session.user.id, displayName: session.user.displayName };
  const providers = me?.providers ?? [];

  const shareInvite = (g: Group) => {
    if (!g.inviteCode) return;
    void Share.share({ message: `Join “${g.name}” on InkStat to share our team’s scoresheets: ${inviteLink(g.inviteCode)}` });
  };

  const openGroup = (g: Group) =>
    dialog.actions(
      g.name,
      [
        ...(g.inviteCode
          ? [{ label: 'Share invite link', hint: `Code ${g.inviteCode}`, onPress: () => shareInvite(g) }]
          : []),
        {
          label: 'Leave group',
          destructive: true,
          onPress: async () => {
            const last = g.members <= 1;
            const ok = await dialog.confirm({
              title: last ? 'Leave and delete this group?' : 'Leave this group?',
              subject: { label: g.name },
              body: last
                ? 'You’re its only member, so the group and the games shared in it are deleted.'
                : 'Games you shared stay with the group. You can rejoin with an invite link.',
              confirm: last ? 'Leave and delete' : 'Leave group',
              destructive: true,
            });
            if (ok) await act(() => leaveGroup(g.id, user.id), 'Couldn’t leave the group');
          },
        },
      ],
      `${g.members} member${g.members === 1 ? '' : 's'} · ${g.role === 'owner' ? 'you’re an owner' : 'member'}`,
    );

  const removeAccount = async () => {
    const ok = await dialog.confirm({
      title: 'Delete your account?',
      subject: { label: user.displayName },
      body:
        'Your account and the games and templates synced to it are deleted from InkStat’s server. Games on this phone stay. ' +
        'Games you shared in a group stay with the group. This can’t be undone.',
      confirm: 'Delete account',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await deleteAccount();
      setMe(null);
    } catch (e) {
      await dialog.notice('Couldn’t delete your account', message(e));
    } finally {
      setBusy(false);
    }
  };

  const sheet: { title: string; fields: SheetField[]; save: (v: string) => Promise<unknown>; fail: string } | null =
    editing === 'name'
      ? { title: 'Your name', fields: [{ key: 'v', label: 'Shown to people in your groups', value: user.displayName }], save: rename, fail: 'Couldn’t change your name' }
      : editing === 'group'
        ? { title: 'New group', fields: [{ key: 'v', label: 'Group name', value: '', placeholder: 'Lakeview 7th grade girls' }], save: createGroup, fail: 'Couldn’t make the group' }
        : editing === 'join'
          ? {
              title: 'Join a group',
              fields: [{ key: 'v', label: 'Invite code', value: '', placeholder: 'ABCD2345' }],
              save: async (v: string) => {
                if (!isInviteCode(v)) throw new Error('That doesn’t look like an invite code. It’s 8 letters and numbers.');
                return joinGroup(v);
              },
              fail: 'Couldn’t join the group',
            }
          : null;

  return (
    <>
      <ScrollView style={[base.screen, { backgroundColor: c.bg }]} contentContainerStyle={base.content}>
        <Card>
          <Pressable accessibilityRole="button" accessibilityHint="Change your name" onPress={() => setEditing('name')} style={styles.row}>
            <View style={{ flex: 1 }}>
              <T style={base.h2}>{user.displayName}</T>
              <T muted style={styles.small}>
                {providers.length ? `Signed in with ${providers.join(' and ')}` : 'Signed in'}
              </T>
            </View>
            <T style={{ color: c.accent, fontFamily: fonts.bodySemiBold }}>Edit</T>
          </Pressable>
        </Card>

        <View style={styles.heading}>
          <T style={base.h2}>Groups</T>
          {busy && <ActivityIndicator color={c.accent} />}
        </View>
        <T muted style={styles.small}>A group shares its games among your team’s scorekeepers and coaches. Invite people with a link.</T>
        {error ? <T style={{ color: c.error }}>{error}</T> : null}
        {me?.groups.map((g) => (
          <Pressable key={g.id} accessibilityRole="button" onPress={() => openGroup(g)}>
            <Card>
              <View style={styles.row}>
                <View style={{ flex: 1 }}>
                  <T style={{ fontFamily: fonts.bodySemiBold, fontSize: 16 }}>{g.name}</T>
                  <T muted style={styles.small}>
                    {`${g.members} member${g.members === 1 ? '' : 's'}${g.role === 'owner' ? ' · owner' : ''}`}
                  </T>
                </View>
                {g.inviteCode && (
                  <Pressable accessibilityRole="button" onPress={() => shareInvite(g)} hitSlop={8} style={styles.link}>
                    <T style={{ color: c.accent, fontFamily: fonts.bodySemiBold }}>Invite</T>
                  </Pressable>
                )}
              </View>
            </Card>
          </Pressable>
        ))}
        {me && !me.groups.length && <T muted style={styles.small}>You’re not in any groups yet.</T>}
        <View style={styles.buttons}>
          <View style={{ flex: 1 }}>
            <Button title="New group" onPress={() => setEditing('group')} disabled={busy} />
          </View>
          <View style={{ flex: 1 }}>
            <Button title="Join with a code" kind="secondary" onPress={() => setEditing('join')} disabled={busy} />
          </View>
        </View>

        <View style={[styles.heading, { marginTop: space.lg }]}>
          <T style={base.h2}>Account</T>
        </View>
        <Button
          title="Sign out"
          kind="secondary"
          onPress={async () => {
            await signOut();
            setMe(null);
          }}
          disabled={busy}
        />
        <Button title="Delete account" kind="danger" onPress={() => void removeAccount()} disabled={busy} />
      </ScrollView>

      <EditSheet
        visible={sheet !== null}
        title={sheet?.title ?? ''}
        fields={sheet?.fields ?? []}
        onClose={() => setEditing(null)}
        onSave={(draft) => {
          const s = sheet;
          setEditing(null);
          const v = (draft.v ?? '').trim();
          if (!s || !v) return;
          void act(() => s.save(v), s.fail);
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  body: { fontSize: 16, lineHeight: 23 },
  small: { fontSize: 14, lineHeight: 20 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  buttons: { flexDirection: 'row', gap: space.sm },
  link: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
});

