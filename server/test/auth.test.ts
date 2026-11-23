import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LOST_ANSWER_WINDOW_MS, REPLAY_GRACE_MS } from '../src/auth/accounts';
import { nonceMatches } from '../src/auth/identity';
import { json, makeServer, sha256 } from './helpers';

describe('sign in with Google and Apple', () => {
  it('creates an account from a verified Google token and answers /me', async () => {
    const s = await makeServer();
    const session = await s.signIn('dana');
    assert.ok(session.accessToken && session.refreshToken);
    assert.equal(session.user.displayName, 'dana');
    const me = await json(await s.call('GET', '/v1/me', undefined, session.accessToken));
    assert.equal(me.user.email, 'dana@example.com');
    assert.deepEqual(me.providers, ['Google']);
  });

  it('refuses a token for another audience, an expired one, or a forged one, all alike', async () => {
    const s = await makeServer();
    const tries = [
      await s.google.sign({ sub: 'x', email: 'x@example.com', email_verified: true }, { aud: 'someone-else' }),
      await s.google.sign({ sub: 'x', email: 'x@example.com', email_verified: true }, { expSeconds: -600 }),
      await s.apple.sign({ sub: 'x', email: 'x@example.com', email_verified: true }, { aud: 'web-client.apps.googleusercontent.com', iss: 'https://accounts.google.com' }),
    ];
    for (const idToken of tries) {
      const res = await s.call('POST', '/v1/auth/social', { provider: 'Google', idToken });
      assert.equal(res.status, 401);
      assert.equal((await json(res)).code, 'InvalidIdentityToken');
    }
  });

  it('needs a verified address to create or link an account', async () => {
    const s = await makeServer();
    const idToken = await s.google.sign({ sub: 'g-x', email: 'x@example.com', email_verified: false });
    const res = await s.call('POST', '/v1/auth/social', { provider: 'Google', idToken });
    assert.equal(res.status, 400);
    assert.equal((await json(res)).code, 'IdentityEmailRequired');
  });

  it('links Apple to the same account through the verified address, and requires the nonce', async () => {
    const s = await makeServer();
    const first = await s.signIn('dana');
    const nonce = 'raw-nonce-123';
    const noNonce = await s.apple.sign({ sub: 'a-dana', email: 'Dana@Example.com', email_verified: 'true' });
    assert.equal((await s.call('POST', '/v1/auth/social', { provider: 'Apple', idToken: noNonce })).status, 401);

    const idToken = await s.apple.sign({ sub: 'a-dana', email: 'Dana@Example.com', email_verified: 'true', nonce: sha256(nonce) });
    const res = await s.call('POST', '/v1/auth/social', { provider: 'Apple', idToken, nonce, authorizationCode: 'code1' });
    assert.equal(res.status, 200);
    const second = await json(res);
    assert.equal(second.user.id, first.user.id);
    const me = await json(await s.call('GET', '/v1/me', undefined, second.accessToken));
    assert.deepEqual(me.providers.sort(), ['Apple', 'Google']);
  });

  it('accepts a Google token with its own nonce when the app sent none', () => {
    assert.equal(nonceMatches('Google', undefined, 'sdk-nonce'), true);
    assert.equal(nonceMatches('Apple', undefined, 'x'), false);
    assert.equal(nonceMatches('Apple', 'abc', sha256('abc')), true);
    assert.equal(nonceMatches('Apple', 'abc', 'abc'), true);
    assert.equal(nonceMatches('Apple', 'abc', sha256('abd')), false);
  });

  it('revokes the kept Apple token when the account is deleted', async () => {
    const s = await makeServer();
    const nonce = 'n1';
    const idToken = await s.apple.sign({ sub: 'a-1', email: 'r@privaterelay.appleid.com', email_verified: true, is_private_email: 'true', nonce: sha256(nonce) });
    const session = await json(await s.call('POST', '/v1/auth/social', { provider: 'Apple', idToken, nonce, authorizationCode: 'c9' }));
    // A relay address's random local part is never used as a name.
    assert.equal(session.user.displayName, 'InkStat scorekeeper');
    assert.equal((await s.call('DELETE', '/v1/me', undefined, session.accessToken)).status, 204);
    assert.deepEqual(s.revoked, ['apple-refresh-for-c9']);
    assert.equal((await s.call('GET', '/v1/me', undefined, session.accessToken)).status, 401);
  });

  it('keeps working with a Hide My Email relay address', async () => {
    const s = await makeServer();
    const relay = 'x7k2p9q4@privaterelay.appleid.com';
    // First sign-in: Apple gives the name to the app, and the token carries the relay address (claims as strings).
    const first = await s.apple.sign({ sub: 'a-relay', email: relay, email_verified: 'true', is_private_email: 'true', nonce: sha256('r1') });
    const a = await json(await s.call('POST', '/v1/auth/social', { provider: 'Apple', idToken: first, nonce: 'r1', displayName: 'Dana Ghastly' }));
    assert.equal(a.user.displayName, 'Dana Ghastly');

    // The person turns forwarding off for InkStat: Apple says so, and nothing ends.
    const notice = await s.apple.sign({ events: JSON.stringify({ type: 'email-disabled', sub: 'a-relay', email: relay }) });
    assert.equal((await s.call('POST', '/v1/auth/apple/notifications', { payload: notice })).status, 200);

    // A later sign-in finds the account by Apple's subject alone, even with no address in the token.
    const later = await s.apple.sign({ sub: 'a-relay', nonce: sha256('r2') });
    const b = await json(await s.call('POST', '/v1/auth/social', { provider: 'Apple', idToken: later, nonce: 'r2' }));
    assert.equal(b.user.id, a.user.id);
    assert.equal((await s.call('GET', '/v1/me', undefined, b.accessToken)).status, 200);
  });

  it("Apple's consent-revoked removes the link and ends sessions only when it was the last way in", async () => {
    const s = await makeServer();
    const nonce = 'n2';
    const idToken = await s.apple.sign({ sub: 'a-2', email: 'only@example.com', email_verified: true, nonce: sha256(nonce) });
    const session = await json(await s.call('POST', '/v1/auth/social', { provider: 'Apple', idToken, nonce }));
    const payload = await s.apple.sign({ events: JSON.stringify({ type: 'consent-revoked', sub: 'a-2' }) });
    assert.equal((await s.call('POST', '/v1/auth/apple/notifications', { payload })).status, 200);
    const refresh = await s.call('POST', '/v1/auth/refresh', { refreshToken: session.refreshToken });
    assert.equal(refresh.status, 401);
  });
});

describe('sessions', () => {
  it('rotates refresh tokens', async () => {
    const s = await makeServer();
    const a = await s.signIn('miles');
    const b = await json(await s.call('POST', '/v1/auth/refresh', { refreshToken: a.refreshToken }));
    assert.notEqual(b.refreshToken, a.refreshToken);
    assert.equal(b.user.id, a.user.id);
  });

  it('answers RefreshRaced to a stale copy inside the grace and keeps the session', async () => {
    const s = await makeServer();
    const a = await s.signIn('priya');
    const b = await json(await s.call('POST', '/v1/auth/refresh', { refreshToken: a.refreshToken }));
    s.clock.t += 1000;
    const raced = await s.call('POST', '/v1/auth/refresh', { refreshToken: a.refreshToken });
    assert.equal(raced.status, 401);
    assert.equal((await json(raced)).code, 'RefreshRaced');
    // The winner's token still works.
    assert.equal((await s.call('POST', '/v1/auth/refresh', { refreshToken: b.refreshToken })).status, 200);
  });

  it('reissues when the rotation answer was lost (replacement never used)', async () => {
    const s = await makeServer();
    const a = await s.signIn('theo');
    await s.call('POST', '/v1/auth/refresh', { refreshToken: a.refreshToken });
    s.clock.t += REPLAY_GRACE_MS + 5 * 60_000;
    const again = await s.call('POST', '/v1/auth/refresh', { refreshToken: a.refreshToken });
    assert.equal(again.status, 200);
  });

  it('ends the chain on a real replay, but not the account', async () => {
    const s = await makeServer();
    const phone = await s.signIn('rafi');
    const tablet = await s.signIn('rafi');
    const b = await json(await s.call('POST', '/v1/auth/refresh', { refreshToken: phone.refreshToken }));
    // The replacement gets used, so a later copy of the old token is a leak.
    s.clock.t += 2 * REPLAY_GRACE_MS;
    const c = await json(await s.call('POST', '/v1/auth/refresh', { refreshToken: b.refreshToken }));
    s.clock.t += LOST_ANSWER_WINDOW_MS + 60_000;
    assert.equal((await s.call('POST', '/v1/auth/refresh', { refreshToken: phone.refreshToken })).status, 401);
    // That chain's head is dead...
    assert.equal((await s.call('POST', '/v1/auth/refresh', { refreshToken: c.refreshToken })).status, 401);
    // ...the other device's chain is not.
    assert.equal((await s.call('POST', '/v1/auth/refresh', { refreshToken: tablet.refreshToken })).status, 200);
  });

  it('logs out idempotently', async () => {
    const s = await makeServer();
    const a = await s.signIn('ines');
    assert.equal((await s.call('POST', '/v1/auth/logout', { refreshToken: a.refreshToken })).status, 204);
    assert.equal((await s.call('POST', '/v1/auth/logout', { refreshToken: a.refreshToken })).status, 204);
    assert.equal((await s.call('POST', '/v1/auth/refresh', { refreshToken: a.refreshToken })).status, 401);
  });

  it('refuses signed-in routes without a session, and keeps legacy keys working', async () => {
    const key = 'k'.repeat(40);
    const s = await makeServer({ keys: `eagles:${key}` });
    assert.equal((await s.call('GET', '/v1/me')).status, 401);
    assert.equal((await s.call('GET', '/v1/me', undefined, key)).status, 401);
    assert.equal((await s.call('GET', '/v1/space', undefined, key)).status, 200);
    const a = await s.signIn('bev');
    assert.equal((await s.call('GET', '/v1/games', undefined, a.accessToken)).status, 401);
  });
});
