import { ApiError, apiFetch, apiUrl, signOut } from './session';

/**
 * The signed-in account and its groups, for More › Account and invite links.
 * Every call needs a session; without one apiFetch throws ApiError(401, 'SignedOut').
 */

export interface Me {
  user: { id: string; displayName: string };
  /** 'Apple' and/or 'Google'. */
  providers: string[];
  groups: Group[];
}

export interface Group {
  id: string;
  name: string;
  kind: 'league' | 'school' | 'team';
  role: 'owner' | 'member';
  members: number;
  /** Owners only. */
  inviteCode?: string;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await apiFetch(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
  if (!res.ok) throw new ApiError(res.status, json.code ?? 'Error', json.error ?? `Server answered ${res.status}`);
  return json as T;
}

export const getMe = () => call<Me>('GET', '/v1/me');

export const rename = async (displayName: string) =>
  (await call<{ user: Me['user'] }>('PATCH', '/v1/me', { displayName })).user;

/** Deletes the account on the server (its own synced games and templates too), then forgets it here. */
export async function deleteAccount(): Promise<void> {
  await call('DELETE', '/v1/me');
  await signOut();
}

export const createGroup = async (name: string) =>
  (await call<{ group: Group }>('POST', '/v1/groups', { name, kind: 'team' })).group;

export const joinGroup = async (code: string) =>
  (await call<{ group: Group }>('POST', '/v1/groups/join', { code: normalizeCode(code) })).group;

/** Leaving as the last member also deletes the group; the server refuses a last owner with others in it. */
export const leaveGroup = (groupId: string, userId: string) =>
  call<void>('DELETE', `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`);

// Same alphabet as the server's codes: no 0/O or 1/I/L.
const CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6,12}$/;

export const normalizeCode = (raw: string) => raw.replace(/[\s-]/g, '').toUpperCase();
export const isInviteCode = (raw: string) => CODE.test(normalizeCode(raw));

/** The link an owner shares: a web page that opens the app at /join/<code>. */
export const inviteLink = (code: string) => `${apiUrl()}/join/${code}`;

/** The code in an inkstat://join/<code> link, or null when it isn't one. */
export function codeFromParam(raw: string | string[] | undefined): string | null {
  const code = normalizeCode(Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? ''));
  return isInviteCode(code) ? code : null;
}
