import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { emptyTeam, type Game } from '@inkstat/basketball';

import { editDistance, normalizeName } from '../src/registry';
import { isPrintedVocabulary } from '../src/sanitize';
import { json, makeServer } from './helpers';

const team = (name: string, town = 'Henley') => ({ sport: 'basketball', name, town, state: 'GA', level: 'varsity', gender: 'boys' });

describe('team registry', () => {
  it('normalizes names', () => {
    assert.equal(normalizeName("St. Mary's High School"), 'st marys');
    assert.equal(normalizeName('Café Élan HS'), 'cafe elan');
    assert.equal(editDistance('starz', 'stars'), 1);
  });

  it('finds the same team instead of adding it twice, and offers near-misses', async () => {
    const s = await makeServer();
    const { accessToken: t } = await s.signIn('dana');
    const a = await s.call('POST', '/v1/teams', team('Henley Stars'), t);
    assert.equal(a.status, 201);
    const again = await s.call('POST', '/v1/teams', team('henley stars'), t);
    assert.equal(again.status, 200);
    assert.equal((await json(again)).team.id, (await json(a)).team.id);
    const near = await json(await s.call('POST', '/v1/teams', team('Henley Starz'), t));
    assert.equal(near.created, true);
    assert.equal(near.similar[0].name, 'Henley Stars');
  });

  it('searches by name and alias, best match first', async () => {
    const s = await makeServer();
    const { accessToken: t } = await s.signIn('dana');
    const stars = (await json(await s.call('POST', '/v1/teams', team('Henley Stars'), t))).team;
    await s.call('POST', '/v1/teams', team('Comets', 'Dalton'), t);
    await s.call('POST', `/v1/teams/${stars.id}/aliases`, { alias: 'HHS Stars' }, t);
    const found = await json(await s.call('GET', '/v1/teams?sport=basketball&q=hhs', undefined, t));
    assert.equal(found.teams[0].id, stars.id);
    const byName = await json(await s.call('GET', '/v1/teams?q=henley%20st', undefined, t));
    assert.equal(byName.teams[0].name, 'Henley Stars');
  });

  it('merges two teams once two scorekeepers agree, moving results', async () => {
    const s = await makeServer();
    const dana = (await s.signIn('dana')).accessToken;
    const miles = (await s.signIn('miles')).accessToken;
    const stars = (await json(await s.call('POST', '/v1/teams', team('Henley Stars'), dana))).team;
    const starz = (await json(await s.call('POST', '/v1/teams', team('Henley Starz'), dana))).team;
    const comets = (await json(await s.call('POST', '/v1/teams', team('Comets', 'Dalton'), dana))).team;
    await s.call('POST', '/v1/results', { sport: 'basketball', date: '2026-12-01', homeId: starz.id, awayId: comets.id, homeScore: 50, awayScore: 46 }, dana);

    const one = await json(await s.call('POST', `/v1/teams/${starz.id}/merge`, { intoId: stars.id }, dana));
    assert.equal(one.merged, false);
    const dup = await json(await s.call('POST', `/v1/teams/${starz.id}/merge`, { intoId: stars.id }, dana));
    assert.equal(dup.votes, 1, 'the same person voting twice is one vote');
    const two = await json(await s.call('POST', `/v1/teams/${starz.id}/merge`, { intoId: stars.id }, miles));
    assert.equal(two.merged, true);
    assert.ok(two.into.aliases.includes('Henley Starz'));

    // The old id follows the merge, and the result now belongs to Stars.
    assert.equal((await json(await s.call('GET', `/v1/teams/${starz.id}`, undefined, dana))).team.id, stars.id);
    const res = await json(await s.call('GET', `/v1/teams/${stars.id}/results?season=2026-27`, undefined, dana));
    assert.equal(res.results.length, 1);
    assert.deepEqual(res.record, { w: 1, l: 0, pf: 50, pa: 46, disputed: 0 });
  });
});

describe('results', () => {
  it('confirms when two scorekeepers agree and flags disagreement', async () => {
    const s = await makeServer();
    const dana = (await s.signIn('dana')).accessToken;
    const miles = (await s.signIn('miles')).accessToken;
    const priya = (await s.signIn('priya')).accessToken;
    const h = (await json(await s.call('POST', '/v1/teams', team('Henley Stars'), dana))).team.id;
    const a = (await json(await s.call('POST', '/v1/teams', team('Comets', 'Dalton'), dana))).team.id;
    const game = { sport: 'basketball', date: '2026-12-01', homeId: h, awayId: a, homeScore: 50, awayScore: 46 };
    assert.equal((await json(await s.call('POST', '/v1/results', game, dana))).result.status, 'reported');
    assert.equal((await json(await s.call('POST', '/v1/results', game, miles))).result.status, 'confirmed');
    const third = await json(await s.call('POST', '/v1/results', { ...game, homeScore: 51 }, priya));
    assert.equal(third.result.status, 'disputed');
    // Retracting the odd one out restores agreement.
    await s.call('DELETE', `/v1/results/${third.result.id}`, undefined, priya);
    assert.equal((await json(await s.call('GET', `/v1/results/${third.result.id}`, undefined, dana))).result.status, 'confirmed');
  });

  /** Two teams and four scorekeepers; Stars' and Comets' scorekeepers each read only their own book. */
  async function oneSided() {
    const s = await makeServer();
    const [dana, miles, priya, eve] = await Promise.all(['dana', 'miles', 'priya', 'eve'].map(async (n) => (await s.signIn(n)).accessToken));
    const stars = (await json(await s.call('POST', '/v1/teams', team('Henley Stars'), dana))).team.id;
    const comets = (await json(await s.call('POST', '/v1/teams', team('Comets', 'Dalton'), dana))).team.id;
    const report = async (by: string, body: Record<string, unknown>) => {
      const res = await s.call('POST', '/v1/results', { sport: 'basketball', ...body }, by);
      assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
      return (await json(res)).result;
    };
    return { s, dana, miles, priya, eve, stars, comets, report };
  }

  it('combines one-sided reports from both scorekeepers, flipped and a day apart', async () => {
    const { s, dana, miles, priya, eve, stars, comets, report } = await oneSided();
    // Stars' scorekeeper: Stars at home on Dec 1, their own score only.
    const first = await report(dana, { date: '2026-12-01', homeId: stars, awayId: comets, homeScore: 50, awayScore: null, periods: { home: [12, 14, 10, 14] } });
    assert.equal(first.status, 'partial');
    assert.equal(first.home.state, 'known');
    assert.equal(first.away.state, 'unknown');
    assert.equal(first.away.score, null);
    // Comets' scorekeeper has Comets as home, and the next day's date.
    const second = await report(miles, { date: '2026-12-02', homeId: comets, awayId: stars, homeScore: 46, periods: { home: [10, 12, 12, 12] } });
    assert.equal(second.id, first.id, 'the same game');
    assert.equal(second.date, '2026-12-01');
    assert.deepEqual(
      [second.home.id, second.home.score, second.away.id, second.away.score, second.status, second.reports],
      [stars, 50, comets, 46, 'reported', 2],
    );
    assert.deepEqual([second.home.reports, second.away.reports], [1, 1]);

    const third = await report(priya, { date: '2026-12-01', homeId: stars, awayId: comets, homeScore: 50, awayScore: 46 });
    assert.equal(third.id, first.id);
    assert.equal(third.status, 'confirmed');
    assert.deepEqual([third.home.reports, third.away.reports], [2, 2]);

    // A conflicting report a day off is another game (nothing a day apart may conflict)...
    const elsewhere = await report(eve, { date: '2026-12-02', homeId: comets, awayId: stars, homeScore: 48, awayScore: 50 });
    assert.notEqual(elsewhere.id, first.id);
    await s.call('DELETE', `/v1/results/${elsewhere.id}`, undefined, eve);
    // ...but on the game's own date it joins and disputes it.
    const odd = await report(eve, { date: '2026-12-01', homeId: comets, awayId: stars, homeScore: 48, awayScore: 50 });
    assert.equal(odd.id, first.id);
    assert.equal(odd.status, 'disputed');
    assert.equal(odd.away.state, 'conflicting');
    assert.equal(odd.home.state, 'known');

    // Retracting the odd one out restores agreement; retracting everyone removes the game.
    assert.equal((await s.call('DELETE', `/v1/results/${first.id}`, undefined, eve)).status, 204);
    assert.equal((await json(await s.call('GET', `/v1/results/${first.id}`, undefined, dana))).result.status, 'confirmed');
    for (const t of [dana, miles, priya]) await s.call('DELETE', `/v1/results/${first.id}`, undefined, t);
    assert.equal((await s.call('GET', `/v1/results/${first.id}`, undefined, dana)).status, 404);
  });

  it('refuses a report with no score at all', async () => {
    const { dana, stars, comets, s } = await oneSided();
    const res = await s.call('POST', '/v1/results', { sport: 'basketball', date: '2026-12-01', homeId: stars, awayId: comets, homeScore: null }, dana);
    assert.equal(res.status, 400);
  });

  it('keeps a doubleheader as two games', async () => {
    const { s, dana, miles, priya, stars, comets, report } = await oneSided();
    const date = '2026-12-05';
    const g1 = await report(dana, { date, homeId: stars, awayId: comets, homeScore: 50, awayScore: 46, sourceId: 'game0001' });
    assert.equal((await report(miles, { date, homeId: stars, awayId: comets, awayScore: 46, sourceId: 'scan0001' })).id, g1.id);
    // Game two: the same scorekeepers, the same day, each a new scanned game.
    const g2 = await report(dana, { date, homeId: stars, awayId: comets, homeScore: 60, awayScore: 55, sourceId: 'game0002' });
    assert.notEqual(g2.id, g1.id);
    const m2 = await report(miles, { date, homeId: stars, awayId: comets, awayScore: 55, sourceId: 'scan0002' });
    assert.equal(m2.id, g2.id);
    // A third scorekeeper's game-two score joins the game it agrees with, not game one.
    const p2 = await report(priya, { date, homeId: comets, awayId: stars, homeScore: 55, awayScore: 60 });
    assert.equal(p2.id, g2.id);
    assert.equal(p2.status, 'confirmed');
    // Game one is untouched.
    const one = (await json(await s.call('GET', `/v1/results/${g1.id}`, undefined, dana))).result;
    assert.deepEqual([one.home.score, one.away.score, one.status, one.reports], [50, 46, 'confirmed', 2]);
  });

  it('replaces a re-report instead of counting it twice', async () => {
    const { dana, miles, stars, comets, report } = await oneSided();
    const first = await report(dana, { date: '2026-12-01', homeId: stars, awayId: comets, homeScore: 50, awayScore: 64 });
    // A corrected read: the same scorekeeper, the same game, flipped.
    const again = await report(dana, { date: '2026-12-01', homeId: comets, awayId: stars, homeScore: 46, awayScore: 50 });
    assert.equal(again.id, first.id);
    assert.equal(again.reports, 1);
    assert.deepEqual([again.home.score, again.away.score, again.status], [50, 46, 'reported']);
    // With the app's game id, a re-report finds the game even on a corrected date.
    const scanned = await report(miles, { date: '2026-12-10', homeId: stars, awayId: comets, awayScore: 40, sourceId: 'scan0009' });
    const moved = await report(miles, { date: '2026-12-11', homeId: stars, awayId: comets, awayScore: 41, sourceId: 'scan0009' });
    assert.equal(moved.id, scanned.id);
    assert.equal(moved.reports, 1);
    assert.equal(moved.away.score, 41);
  });

  it('leaves partial games out of standings', async () => {
    const { s, dana, miles, stars, comets, report } = await oneSided();
    await report(dana, { date: '2026-12-01', homeId: stars, awayId: comets, homeScore: 50 });
    let res = await json(await s.call('GET', `/v1/teams/${stars}/results?season=2026-27`, undefined, dana));
    assert.equal(res.results.length, 1, 'listed for signed-in scorekeepers');
    assert.equal(res.results[0].status, 'partial');
    assert.deepEqual(res.record, { w: 0, l: 0, pf: 0, pa: 0, disputed: 0 });
    await report(miles, { date: '2026-12-01', homeId: stars, awayId: comets, awayScore: 46 });
    res = await json(await s.call('GET', `/v1/teams/${stars}/results?season=2026-27`, undefined, dana));
    assert.deepEqual(res.record, { w: 1, l: 0, pf: 50, pa: 46, disputed: 0 });
  });

  it('refuses a team playing itself', async () => {
    const s = await makeServer();
    const t = (await s.signIn('dana')).accessToken;
    const h = (await json(await s.call('POST', '/v1/teams', team('Henley Stars'), t))).team.id;
    const res = await s.call('POST', '/v1/results', { sport: 'basketball', date: '2026-12-01', homeId: h, awayId: h, homeScore: 1, awayScore: 0 }, t);
    assert.equal(res.status, 400);
  });
});

describe('groups', () => {
  const game = (id: string): Game => ({
    id,
    date: '2026-12-01',
    location: null,
    season: '2026-27',
    home: { ...emptyTeam(), name: 'Stars', totalPoints: 50, coach: 'Hill', teamFouls: [3, 4] },
    away: { ...emptyTeam(), name: 'Comets', totalPoints: 46 },
    modelId: null,
    createdAt: 1,
    updatedAt: 2,
  });

  it('shares games, teams, standings and rosters with members only', async () => {
    const s = await makeServer();
    const owner = (await s.signIn('dana')).accessToken;
    const member = (await s.signIn('miles')).accessToken;
    const outsider = (await s.signIn('eve')).accessToken;

    const group = (await json(await s.call('POST', '/v1/groups', { name: 'Region 5', kind: 'league' }, owner))).group;
    assert.ok(group.inviteCode);
    const joined = await json(await s.call('POST', '/v1/groups/join', { code: group.inviteCode.toLowerCase() }, member));
    assert.equal(joined.group.id, group.id);
    assert.equal(joined.group.inviteCode, undefined, 'members do not see the code');

    assert.equal((await s.call('PUT', `/v1/groups/${group.id}/games/game0001`, game('game0001'), member)).status, 200);
    const feed = await json(await s.call('GET', `/v1/groups/${group.id}/games`, undefined, owner));
    assert.equal(feed.changes.length, 1);
    assert.equal(feed.changes[0].game.home.coach, 'Hill', 'optional team fields survive sync');
    assert.deepEqual(feed.changes[0].game.home.teamFouls, [3, 4]);
    assert.equal((await s.call('GET', `/v1/groups/${group.id}/games`, undefined, outsider)).status, 404);

    const h = (await json(await s.call('POST', '/v1/teams', team('Henley Stars'), owner))).team.id;
    const a = (await json(await s.call('POST', '/v1/teams', team('Comets', 'Dalton'), owner))).team.id;
    await s.call('POST', `/v1/groups/${group.id}/teams`, { teamId: h }, owner);
    await s.call('POST', `/v1/groups/${group.id}/teams`, { teamId: a }, member);
    await s.call('POST', '/v1/results', { sport: 'basketball', date: '2026-12-01', homeId: h, awayId: a, homeScore: 50, awayScore: 46 }, member);
    const table = await json(await s.call('GET', `/v1/groups/${group.id}/standings?season=2026-27`, undefined, owner));
    assert.equal(table.standings[0].team.id, h);
    assert.equal(table.standings[0].w, 1);

    const roster = { players: [{ number: '10', name: 'Drexler' }] };
    assert.equal((await s.call('PUT', `/v1/groups/${group.id}/rosters/${h}?season=2026-27`, roster, member)).status, 204);
    assert.deepEqual((await json(await s.call('GET', `/v1/groups/${group.id}/rosters/${h}?season=2026-27`, undefined, owner))).players, roster.players);
    assert.equal((await s.call('GET', `/v1/groups/${group.id}/rosters/${h}`, undefined, outsider)).status, 404);
  });

  it('keeps an owner: the last owner cannot leave a group with others in it', async () => {
    const s = await makeServer();
    const owner = await s.signIn('dana');
    const member = await s.signIn('miles');
    const group = (await json(await s.call('POST', '/v1/groups', { name: 'Stars scorers', kind: 'team' }, owner.accessToken))).group;
    await s.call('POST', '/v1/groups/join', { code: group.inviteCode }, member.accessToken);
    const leave = await s.call('DELETE', `/v1/groups/${group.id}/members/${owner.user.id}`, undefined, owner.accessToken);
    assert.equal(leave.status, 409);
    await s.call('POST', `/v1/groups/${group.id}/members/${member.user.id}/role`, { role: 'owner' }, owner.accessToken);
    assert.equal((await s.call('DELETE', `/v1/groups/${group.id}/members/${owner.user.id}`, undefined, owner.accessToken)).status, 204);
  });
});

describe('shared templates', () => {
  it('keeps printed labels and drops anything that could be a name', async () => {
    assert.equal(isPrintedVocabulary('teamfouls'), true);
    assert.equal(isPrintedVocabulary('timeouts'), true);
    assert.equal(isPrintedVocabulary('2nd'), true);
    assert.equal(isPrintedVocabulary('drexler'), false);
    assert.equal(isPrintedVocabulary('jordan'), false);

    const s = await makeServer();
    const t = (await s.signIn('dana')).accessToken;
    const layout = {
      sport: 'basketball',
      name: 'Stars home book',
      enabled: ['rows', 'names', 'points', 'madeUp'],
      parts: { rows: { x: 0.1, y: 0.2, w: 0.8, h: 0.5 }, names: { x: 0.1, w: 0.2 }, madeUp: { x: 0, y: 0, w: 1, h: 1 } },
      variants: {},
      anchors: [{ text: 'teamfouls', x: 0.5, y: 0.1 }, { text: 'drexler', x: 0.2, y: 0.4 }, { text: 'player', x: 0.15, y: 0.18 }],
      photoUri: 'file:///never/shared.jpg',
    };
    const res = await s.call('POST', '/v1/templates', layout, t);
    assert.equal(res.status, 201);
    const made = await json(res);
    assert.equal(made.droppedAnchors, 1);
    const back = (await json(await s.call('GET', `/v1/templates/${made.id}`, undefined, t))).template.layout;
    assert.deepEqual(back.anchors.map((a: { text: string }) => a.text), ['teamfouls', 'player']);
    assert.equal(back.parts.madeUp, undefined);
    assert.equal(back.photoUri, undefined);
    assert.deepEqual(back.enabled, ['rows', 'names', 'points']);

    const stars = (await json(await s.call('POST', '/v1/teams', team('Henley Stars'), t))).team.id;
    await s.call('POST', `/v1/teams/${stars}/templates`, { templateId: made.id }, t);
    const used = await json(await s.call('GET', `/v1/teams/${stars}`, undefined, t));
    assert.equal(used.templates[0].id, made.id);
  });
});
