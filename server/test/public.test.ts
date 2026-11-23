import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { json, makeServer } from './helpers';

const team = (name: string, town = 'Henley') => ({ sport: 'basketball', name, town, state: 'GA', level: 'varsity', gender: 'boys' });
const ORIGIN = 'https://inkstat.app';

async function seeded() {
  const s = await makeServer();
  const dana = (await s.signIn('dana')).accessToken;
  const miles = (await s.signIn('miles')).accessToken;
  const add = async (name: string, town?: string) => (await json(await s.call('POST', '/v1/teams', team(name, town), dana))).team;
  const stars = await add('Henley Stars');
  const comets = await add('Comets', 'Dalton');
  const rams = await add('North Rams', 'Rome');
  const report = (by: string, date: string, homeId: string, awayId: string, homeScore: number, awayScore: number) =>
    s.call('POST', '/v1/results', { sport: 'basketball', date, homeId, awayId, homeScore, awayScore }, by);
  // Confirmed (two agree), reported once, and disputed.
  await report(dana, '2026-12-01', stars.id, comets.id, 50, 46);
  await report(miles, '2026-12-01', stars.id, comets.id, 50, 46);
  await report(dana, '2026-12-05', rams.id, stars.id, 40, 44);
  await report(dana, '2026-12-08', comets.id, rams.id, 61, 59);
  await report(miles, '2026-12-08', comets.id, rams.id, 59, 61);
  // Last season.
  await report(dana, '2026-02-10', stars.id, rams.id, 30, 33);
  // A group with a roster: none of it may reach the public scoreboard.
  const group = (await json(await s.call('POST', '/v1/groups', { name: 'Secret League', kind: 'league' }, dana))).group;
  await s.call('POST', `/v1/groups/${group.id}/teams`, { teamId: stars.id }, dana);
  await s.call('PUT', `/v1/groups/${group.id}/rosters/${stars.id}?season=2026-27`, { players: [{ number: '23', name: 'Jordan Minor' }] }, dana);
  return { s, stars, comets, rams };
}

const get = (s: Awaited<ReturnType<typeof makeServer>>, path: string, headers: Record<string, string> = {}) =>
  s.app.request(path, { headers });

describe('public scoreboard', () => {
  it('needs no sign-in and shows the newest season by default', async () => {
    const { s, stars, comets } = await seeded();
    const res = await get(s, '/v1/public/scoreboard');
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.season, '2026-27');
    assert.deepEqual(body.seasons, [{ season: '2026-27', games: 3 }, { season: '2025-26', games: 1 }]);
    assert.equal(body.results.length, 3);
    assert.deepEqual(body.results.map((r: { date: string }) => r.date), ['2026-12-08', '2026-12-05', '2026-12-01']);
    const first = body.results[2];
    assert.deepEqual(first, { id: first.id, date: '2026-12-01', home: { id: stars.id, score: 50 }, away: { id: comets.id, score: 46 }, status: 'confirmed' });
    assert.equal(body.results[1].status, 'reported');
    const disputed = body.results[0];
    assert.equal(disputed.status, 'disputed');
    assert.equal(disputed.home.score, null, 'a disputed result shows no score');
    assert.equal(disputed.away.score, null);
    const t = body.teams.find((x: { id: string }) => x.id === stars.id);
    assert.deepEqual(t, { id: stars.id, name: 'Henley Stars', town: 'Henley', state: 'GA', level: 'varsity', gender: 'boys' });
  });

  it('reads another season on request', async () => {
    const { s } = await seeded();
    const body = await json(await get(s, '/v1/public/scoreboard?season=2025-26'));
    assert.equal(body.season, '2025-26');
    assert.equal(body.results.length, 1);
    assert.equal(body.teams.length, 2);
    assert.equal((await get(s, '/v1/public/scoreboard?season=nope')).status, 400);
    assert.equal((await get(s, '/v1/public/scoreboard?sport=curling')).status, 400);
  });

  it('never leaks players, groups, scorekeepers or report counts', async () => {
    const { s } = await seeded();
    const text = await (await get(s, '/v1/public/scoreboard')).text();
    for (const secret of ['Jordan Minor', 'Secret League', 'dana', 'miles', 'example.com', 'reports', 'players', 'roster']) {
      assert.ok(!text.includes(secret), `public scoreboard must not include "${secret}"`);
    }
  });

  it('leaves a game off until both scores are in, and still leaks nothing', async () => {
    const { s, stars, rams } = await seeded();
    const priya = (await s.signIn('priya')).accessToken;
    const ozzie = (await s.signIn('ozzie')).accessToken;
    // One scorekeeper read only Stars' page.
    const one = { sport: 'basketball', date: '2026-12-12', homeId: stars.id, awayId: rams.id, homeScore: 55, sourceId: 'game0042' };
    assert.equal((await s.call('POST', '/v1/results', one, priya)).status, 200);
    let body = await json(await get(s, '/v1/public/scoreboard'));
    assert.equal(body.results.length, 3, 'a partial game is not listed');
    assert.deepEqual(body.seasons[0], { season: '2026-27', games: 3 });
    // The Rams' scorekeeper reports their side, the next day and the other way round.
    const other = { sport: 'basketball', date: '2026-12-13', homeId: rams.id, awayId: stars.id, homeScore: 41 };
    assert.equal((await s.call('POST', '/v1/results', other, ozzie)).status, 200);
    const res = await get(s, '/v1/public/scoreboard');
    const text = await res.clone().text();
    body = await json(res);
    assert.equal(body.results.length, 4);
    assert.deepEqual(body.seasons[0], { season: '2026-27', games: 4 });
    const g = body.results[0];
    assert.deepEqual(g, { id: g.id, date: '2026-12-12', home: { id: stars.id, score: 55 }, away: { id: rams.id, score: 41 }, status: 'reported' });
    for (const secret of ['Jordan Minor', 'Secret League', 'dana', 'miles', 'priya', 'ozzie', 'example.com', 'reports', 'players', 'roster', 'game0042', 'known', 'partial']) {
      assert.ok(!text.includes(secret), `public scoreboard must not include "${secret}"`);
    }
  });

  it('is empty, not an error, before anyone reports a score', async () => {
    const s = await makeServer();
    const body = await json(await get(s, '/v1/public/scoreboard'));
    assert.deepEqual(body.results, []);
    assert.deepEqual(body.teams, []);
    assert.deepEqual(body.seasons, []);
    assert.match(body.season, /^\d{4}-\d{2}$/);
    assert.deepEqual(await json(await get(s, '/v1/public/seasons')), { seasons: [] });
  });

  it('allows inkstat.app across origins, read-only, and caches briefly', async () => {
    const s = await makeServer();
    const res = await get(s, '/v1/public/scoreboard', { origin: ORIGIN });
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
    const other = await get(s, '/v1/public/scoreboard', { origin: 'https://evil.example' });
    assert.equal(other.headers.get('access-control-allow-origin'), null);
    const pre = await s.app.request('/v1/public/scoreboard', {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'GET' },
    });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-methods'), 'GET');
    assert.equal((await s.app.request('/v1/public/scoreboard', { method: 'POST' })).status, 404);
    // Signed-in areas keep their same-origin policy.
    assert.equal((await get(s, '/health')).headers.get('cross-origin-resource-policy'), 'same-origin');
  });

  it('rate limits each address', async () => {
    const s = await makeServer();
    const headers = { 'x-forwarded-for': '203.0.113.9' };
    for (let i = 0; i < 120; i++) assert.equal((await get(s, '/v1/public/seasons', headers)).status, 200);
    const limited = await get(s, '/v1/public/seasons', headers);
    assert.equal(limited.status, 429);
    assert.equal((await json(limited)).code, 'TooManyRequests');
    assert.equal((await get(s, '/v1/public/seasons', { 'x-forwarded-for': '203.0.113.10' })).status, 200);
  });
});
