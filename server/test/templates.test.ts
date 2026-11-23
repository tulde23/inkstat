import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { json, makeServer } from './helpers';

const team = (name: string, town = 'Henley') => ({ sport: 'basketball', name, town, state: 'GA', level: 'varsity', gender: 'boys' });

/** The app's stored template, as made on a filled-in page: names in the anchors, a photo path. */
const appTemplate = (id: string, extra: Record<string, unknown> = {}) => ({
  version: 3,
  sport: 'basketball',
  id,
  name: 'Short form book',
  enabled: ['rows', 'names', 'points', 'madeUp'],
  parts: { rows: { x: 0.1, y: 0.2, w: 0.8, h: 0.5 }, names: { x: 0.1, w: 0.2 }, madeUp: { x: 0, y: 0, w: 1, h: 1 } },
  variants: {},
  photoUri: 'file:///phone/never-shared.jpg',
  anchors: [
    { text: 'teamfouls', x: 0.5, y: 0.1 },
    { text: 'drexler', x: 0.2, y: 0.4 },
    { text: 'jordanminor', x: 0.2, y: 0.45 },
    { text: 'player', x: 0.15, y: 0.18 },
    { text: '555 0100', x: 0.9, y: 0.9 },
  ],
  sheet: { teams: 'both', homeAt: 'top' },
  test: { at: 1, seconds: 2, checks: 3, problems: 0 },
  createdAt: 1,
  updatedAt: 2,
  ...extra,
});

const texts = (t: { anchors?: { text: string }[] }) => (t.anchors ?? []).map((a) => a.text);

async function league() {
  const s = await makeServer();
  const owner = await s.signIn('dana');
  const member = await s.signIn('miles');
  const other = await s.signIn('priya');
  const outsider = await s.signIn('eve');
  const group = (await json(await s.call('POST', '/v1/groups', { name: 'Region 5', kind: 'league' }, owner.accessToken))).group;
  for (const who of [member, other]) await s.call('POST', '/v1/groups/join', { code: group.inviteCode }, who.accessToken);
  return { s, owner, member, other, outsider, gid: group.id as string };
}

describe('group templates', () => {
  it('shares a template with the group stripped of names and the photo, keeping sheet', async () => {
    const { s, member, owner, gid } = await league();
    const res = await s.call('POST', `/v1/groups/${gid}/templates`, appTemplate('local-1'), member.accessToken);
    assert.equal(res.status, 201);
    const made = await json(res);
    assert.equal(made.droppedAnchors, 3);
    assert.equal(made.mine, true);
    assert.equal(made.sharedBy.name, 'miles');

    const feed = await json(await s.call('GET', `/v1/groups/${gid}/templates`, undefined, owner.accessToken));
    assert.equal(feed.changes.length, 1);
    const t = feed.changes[0].data;
    assert.equal(feed.changes[0].mine, false);
    assert.equal(t.version, 3);
    assert.equal(t.id, made.template.id);
    assert.notEqual(t.id, 'local-1', 'the app id stays with its owner');
    assert.equal(t.photoUri, null);
    assert.equal(t.test, null);
    assert.deepEqual(texts(t), ['teamfouls', 'player']);
    assert.equal(t.parts.madeUp, undefined);
    assert.deepEqual(t.enabled, ['rows', 'names', 'points']);
    assert.deepEqual(t.sheet, { teams: 'both', homeAt: 'top' });

    // Fetch one, and the registry copy: the same stripped layout everywhere.
    const one = await json(await s.call('GET', `/v1/groups/${gid}/templates/${t.id}`, undefined, owner.accessToken));
    assert.deepEqual(texts(one.template), ['teamfouls', 'player']);
    const reg = (await json(await s.call('GET', `/v1/templates/${t.id}`, undefined, owner.accessToken))).template.layout;
    assert.deepEqual(texts(reg), ['teamfouls', 'player']);
    assert.equal(reg.photoUri, undefined);
    assert.equal(reg.id, undefined);
    assert.ok(!JSON.stringify(feed).includes('drexler') && !JSON.stringify(feed).includes('never-shared'));
  });

  it('updates on re-publish of the same app template by the same scorekeeper, and the feed is incremental', async () => {
    const { s, member, owner, other, gid } = await league();
    const first = await json(await s.call('POST', `/v1/groups/${gid}/templates`, appTemplate('local-1'), member.accessToken));
    const feed = await json(await s.call('GET', `/v1/groups/${gid}/templates?since=0`, undefined, owner.accessToken));
    assert.equal((await json(await s.call('GET', `/v1/groups/${gid}/templates?since=${feed.cursor}`, undefined, owner.accessToken))).changes.length, 0);

    s.clock.t += 1000;
    const again = await s.call('POST', `/v1/groups/${gid}/templates`, appTemplate('local-1', { name: 'Short form book 2' }), member.accessToken);
    assert.equal(again.status, 200);
    assert.equal((await json(again)).template.id, first.template.id);
    const next = await json(await s.call('GET', `/v1/groups/${gid}/templates?since=${feed.cursor}`, undefined, owner.accessToken));
    assert.equal(next.changes.length, 1);
    assert.equal(next.changes[0].data.name, 'Short form book 2');
    assert.ok(next.changes[0].data.updatedAt > feed.changes[0].data.updatedAt);

    // Someone else with the same app id is a different template.
    const theirs = await json(await s.call('POST', `/v1/groups/${gid}/templates`, appTemplate('local-1'), other.accessToken));
    assert.notEqual(theirs.template.id, first.template.id);
    assert.equal((await json(await s.call('GET', `/v1/groups/${gid}/templates`, undefined, owner.accessToken))).changes.length, 2);
  });

  it('re-publishing to the registry by app id updates instead of duplicating', async () => {
    const { s, member } = await league();
    const a = await s.call('POST', '/v1/templates', appTemplate('local-9'), member.accessToken);
    assert.equal(a.status, 201);
    const b = await s.call('POST', '/v1/templates', appTemplate('local-9', { name: 'Blue book' }), member.accessToken);
    assert.equal(b.status, 200);
    const [ja, jb] = [await json(a), await json(b)];
    assert.equal(jb.id, ja.id);
    assert.equal(jb.droppedAnchors, 3);
    assert.equal((await json(await s.call('GET', `/v1/templates/${ja.id}`, undefined, member.accessToken))).template.name, 'Blue book');
  });

  it('shares a registry template by id, and refuses an unknown one', async () => {
    const { s, member, owner, gid } = await league();
    const reg = await json(await s.call('POST', '/v1/templates', appTemplate('local-2'), owner.accessToken));
    const res = await s.call('POST', `/v1/groups/${gid}/templates`, { templateId: reg.id }, member.accessToken);
    assert.equal(res.status, 201);
    assert.deepEqual(texts((await json(res)).template), ['teamfouls', 'player']);
    assert.equal((await s.call('POST', `/v1/groups/${gid}/templates`, { templateId: reg.id }, owner.accessToken)).status, 200);
    const missing = await s.call('POST', `/v1/groups/${gid}/templates`, { templateId: '00000000-0000-4000-8000-000000000000' }, member.accessToken);
    assert.equal(missing.status, 404);
  });

  it('keeps non-members out with 404, and signed-out callers with 401', async () => {
    const { s, member, outsider, gid } = await league();
    const made = await json(await s.call('POST', `/v1/groups/${gid}/templates`, appTemplate('local-1'), member.accessToken));
    const id = made.template.id;
    const t = outsider.accessToken;
    assert.equal((await s.call('GET', `/v1/groups/${gid}/templates`, undefined, t)).status, 404);
    assert.equal((await s.call('GET', `/v1/groups/${gid}/templates/${id}`, undefined, t)).status, 404);
    assert.equal((await s.call('POST', `/v1/groups/${gid}/templates`, appTemplate('x'), t)).status, 404);
    assert.equal((await s.call('POST', `/v1/groups/${gid}/templates`, { templateId: id }, t)).status, 404);
    assert.equal((await s.call('DELETE', `/v1/groups/${gid}/templates/${id}`, undefined, t)).status, 404);
    assert.equal((await s.call('GET', `/v1/groups/${gid}/templates`)).status, 401);
    // Nothing the outsider tried got shared.
    assert.equal((await json(await s.call('GET', `/v1/groups/${gid}/templates`, undefined, member.accessToken))).changes.length, 1);
  });

  it('lets only the sharer or an owner unshare, leaving a tombstone in the feed', async () => {
    const { s, owner, member, other, gid } = await league();
    const a = (await json(await s.call('POST', `/v1/groups/${gid}/templates`, appTemplate('a'), member.accessToken))).template.id;
    const b = (await json(await s.call('POST', `/v1/groups/${gid}/templates`, appTemplate('b'), member.accessToken))).template.id;
    const feed = await json(await s.call('GET', `/v1/groups/${gid}/templates`, undefined, other.accessToken));

    const refused = await s.call('DELETE', `/v1/groups/${gid}/templates/${a}`, undefined, other.accessToken);
    assert.equal(refused.status, 403);
    assert.equal((await json(refused)).code, 'NotYours');
    assert.equal((await s.call('DELETE', `/v1/groups/${gid}/templates/${a}`, undefined, member.accessToken)).status, 204);
    assert.equal((await s.call('DELETE', `/v1/groups/${gid}/templates/${b}`, undefined, owner.accessToken)).status, 204);
    assert.equal((await s.call('DELETE', `/v1/groups/${gid}/templates/${b}`, undefined, owner.accessToken)).status, 404);
    assert.equal((await s.call('GET', `/v1/groups/${gid}/templates/${a}`, undefined, other.accessToken)).status, 404);

    const after = await json(await s.call('GET', `/v1/groups/${gid}/templates?since=${feed.cursor}`, undefined, other.accessToken));
    assert.deepEqual(after.changes.map((c: { id: string; deleted: boolean; data: unknown }) => [c.id, c.deleted, c.data]), [[a, true, null], [b, true, null]]);

    // Sharing again brings it back, with the new sharer.
    const back = await s.call('POST', `/v1/groups/${gid}/templates`, { templateId: a }, other.accessToken);
    assert.equal(back.status, 201);
    assert.equal((await json(back)).sharedBy.name, 'priya');
    assert.equal((await s.call('DELETE', `/v1/groups/${gid}/templates/${a}`, undefined, other.accessToken)).status, 204);
  });

  it('validates sheet on every path, and personal sync keeps it', async () => {
    const { s, member, gid } = await league();
    const bad = appTemplate('bad', { sheet: { teams: 'three' } });
    assert.equal((await s.call('POST', `/v1/groups/${gid}/templates`, bad, member.accessToken)).status, 400);
    assert.equal((await s.call('POST', '/v1/templates', bad, member.accessToken)).status, 400);
    assert.equal((await s.call('PUT', '/v1/me/templates/bad', bad, member.accessToken)).status, 400);
    const badHome = appTemplate('bad', { sheet: { teams: 'one', homeAt: 'middle' } });
    assert.equal((await s.call('POST', `/v1/groups/${gid}/templates`, badHome, member.accessToken)).status, 400);

    const one = appTemplate('mine', { sheet: { teams: 'one' } });
    assert.equal((await s.call('PUT', '/v1/me/templates/mine', one, member.accessToken)).status, 200);
    const feed = await json(await s.call('GET', '/v1/me/templates', undefined, member.accessToken));
    assert.deepEqual(feed.changes[0].data.sheet, { teams: 'one' });
    // No sheet is fine too.
    const { sheet: _drop, ...plain } = appTemplate('plain');
    void _drop;
    const made = await json(await s.call('POST', `/v1/groups/${gid}/templates`, plain, member.accessToken));
    assert.equal(made.template.sheet, undefined);
  });

  it('rate limits publishing', async () => {
    const { s, member } = await league();
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await s.call('POST', '/v1/templates', appTemplate(`t${i}`), member.accessToken)).status;
    assert.equal(last, 429);
  });
});

describe('browsing templates', () => {
  it('ranks by scorekeepers and teams, searches names, and names nobody', async () => {
    const { s, owner, member, other, gid } = await league();
    const popular = (await json(await s.call('POST', `/v1/groups/${gid}/templates`, appTemplate('p', { name: 'Standard book' }), owner.accessToken))).template.id;
    await json(await s.call('POST', '/v1/templates', appTemplate('q', { name: 'Varsity home book' }), member.accessToken));
    await s.call('POST', '/v1/templates', { ...appTemplate('r', { name: 'Meet sheet' }), sport: 'track', enabled: [], parts: { rows: { x: 0, y: 0, w: 1, h: 1 } } }, member.accessToken);
    const stars = (await json(await s.call('POST', '/v1/teams', team('Henley Stars'), owner.accessToken))).team.id;
    const comets = (await json(await s.call('POST', '/v1/teams', team('Comets', 'Dalton'), owner.accessToken))).team.id;
    await s.call('POST', `/v1/teams/${stars}/templates`, { templateId: popular }, member.accessToken);
    await s.call('POST', `/v1/teams/${comets}/templates`, { templateId: popular }, other.accessToken);

    const res = await json(await s.call('GET', '/v1/templates?sport=basketball', undefined, member.accessToken));
    assert.equal(res.templates.length, 2);
    const top = res.templates[0];
    assert.deepEqual(Object.keys(top).sort(), ['groups', 'id', 'lastUsed', 'name', 'sport', 'teams', 'users']);
    assert.equal(top.id, popular);
    assert.equal(top.users, 3);
    assert.equal(top.teams, 2);
    assert.equal(top.groups, 1);
    assert.equal(res.templates[1].users, 1);
    const body = JSON.stringify(res);
    for (const secret of [owner.user.id, member.user.id, other.user.id, gid, stars, comets, 'dana', 'miles', 'priya', 'Region 5', 'Henley']) {
      assert.ok(!body.includes(secret), `browse leaks ${secret}`);
    }

    const found = await json(await s.call('GET', '/v1/templates?sport=basketball&q=varsity', undefined, member.accessToken));
    assert.deepEqual(found.templates.map((t: { name: string }) => t.name), ['Varsity home book']);
    assert.equal((await json(await s.call('GET', '/v1/templates?sport=basketball&q=%25', undefined, member.accessToken))).templates.length, 0);
    assert.equal((await s.call('GET', '/v1/templates?sport=curling', undefined, member.accessToken)).status, 400);
    assert.equal((await s.call('GET', '/v1/templates')).status, 401);
  });

  it('keeps templates off the public scoreboard', async () => {
    const { s, member, gid } = await league();
    await s.call('POST', `/v1/groups/${gid}/templates`, appTemplate('p'), member.accessToken);
    for (const path of ['/v1/public/templates', `/v1/public/groups/${gid}/templates`]) {
      assert.equal((await s.app.request(path)).status, 404);
    }
    const board = await (await s.app.request('/v1/public/scoreboard')).text();
    assert.ok(!board.includes('Region 5'));
  });
});

describe('shared template names', () => {
  it('keeps plain scoresheet names and drops anything that could be a person', async () => {
    const { safeTemplateName } = await import('../src/sanitize');
    assert.equal(safeTemplateName("Glover's Short Form"), "Glover's Short Form");
    assert.equal(safeTemplateName('Rec league score sheet 2'), 'Rec league score sheet 2');
    assert.equal(safeTemplateName('My scorebook'), 'My scorebook');
    assert.equal(safeTemplateName("Jordan Smith's book"), 'Shared scoresheet');
    assert.equal(safeTemplateName('Maddie stats', 'glover-short-form'), "Glover's Short Form");
  });
});
