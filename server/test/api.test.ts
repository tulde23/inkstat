import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { emptyTeam, type Game } from '@inkstat/basketball';

import { parseKeys } from '../src/auth/keys';
import { makeServer } from './helpers';

// Response bodies are untyped JSON; tests assert on their shape directly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response): Promise<any> => res.json();

const EAGLES_KEY = 'e'.repeat(40);
const LAKEVIEW_KEY = 'l'.repeat(40);

function makeGame(id: string, updatedAt: number, points = 10): Game {
  return {
    id,
    date: '2026-11-14',
    location: null,
    season: '2026-27',
    home: {
      ...emptyTeam(),
      name: 'Eagles',
      totalPoints: points,
      pageUri: 'file:///data/user/0/com.inkstat.app/files/pages/x/home.jpg',
      crops: [{ regionId: 'summary', uri: 'file:///crop.png' }],
      players: [
        { number: '23', name: 'Rivera', fouls: 1, fg2: 5, fg3: 0, ftMade: 0, ftAttempted: 0, points, readNotes: [] },
      ],
    },
    away: { ...emptyTeam(), name: 'Lakeview' },
    modelId: 'qwen3-vl-2b-q8',
    createdAt: 1,
    updatedAt,
  };
}

describe('inkstat api', () => {
  let app: Awaited<ReturnType<typeof makeServer>>['app'];

  const call = (method: string, path: string, body?: unknown, key = EAGLES_KEY) =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeEach(async () => {
    ({ app } = await makeServer({ keys: `eagles:${EAGLES_KEY},lakeview:${LAKEVIEW_KEY}` }));
  });

  it('shows the logo at the root', async () => {
    const res = await app.request('/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await res.text(), /aria-label="InkStat"/);
    assert.equal((await app.request('/favicon.svg')).headers.get('content-type'), 'image/svg+xml');
  });

  it('serves health without auth', async () => {
    const res = await app.request('/health');
    assert.equal(res.status, 200);
    assert.equal((await json(res)).ok, true);
  });

  it('rejects missing or wrong keys', async () => {
    assert.equal((await app.request('/v1/games')).status, 401);
    assert.equal((await call('GET', '/v1/games', undefined, 'x'.repeat(40))).status, 401);
  });

  it('stores a game, strips device file paths, and returns it with issues', async () => {
    const put = await call('PUT', '/v1/games/abc123', makeGame('abc123', 1000));
    assert.equal(put.status, 200);
    assert.equal((await json(put)).seq, 1);

    const res = await call('GET', '/v1/games/abc123');
    const body = await json(res);
    assert.equal(body.game.home.pageUri, null);
    assert.deepEqual(body.game.home.crops, []);
    assert.ok(Array.isArray(body.issues));
  });

  it('validates the body and the id', async () => {
    const bad = await call('PUT', '/v1/games/abc123', { ...makeGame('abc123', 1), season: 'winter' });
    assert.equal(bad.status, 400);
    assert.match((await json(bad)).issues[0], /^season/);

    const mismatch = await call('PUT', '/v1/games/zzz999', makeGame('abc123', 1));
    assert.equal(mismatch.status, 400);
  });

  it('rejects timestamps far in the future', async () => {
    const res = await call('PUT', '/v1/games/abc123', makeGame('abc123', Date.now() + 3 * 86_400_000));
    assert.equal(res.status, 400);
  });

  it('resolves conflicts last-writer-wins and is idempotent', async () => {
    await call('PUT', '/v1/games/abc123', makeGame('abc123', 2000, 20));
    const stale = await call('PUT', '/v1/games/abc123', makeGame('abc123', 1000, 10));
    assert.equal(stale.status, 409);
    assert.equal((await json(stale)).current.game.home.totalPoints, 20);

    const again = await call('PUT', '/v1/games/abc123', makeGame('abc123', 2000, 20));
    assert.equal((await json(again)).seq, 1, 'same version does not bump seq');
  });

  it('feeds changes since a cursor, including deletes, in pages', async () => {
    for (const [i, id] of ['game001', 'game002', 'game003'].entries()) {
      await call('PUT', `/v1/games/${id}`, makeGame(id, 1000 + i));
    }
    await call('DELETE', '/v1/games/game002?deletedAt=5000');

    const first = await json(await call('GET', '/v1/games?since=0&limit=2'));
    assert.deepEqual(first.changes.map((c: { id: string }) => c.id), ['game001', 'game003']);
    assert.equal(first.more, true);

    const rest = await json(await call('GET', `/v1/games?since=${first.cursor}`));
    assert.equal(rest.changes.length, 1);
    assert.deepEqual(
      { id: rest.changes[0].id, deleted: rest.changes[0].deleted, game: rest.changes[0].game },
      { id: 'game002', deleted: true, game: null },
    );
    assert.equal(rest.more, false);

    assert.equal((await call('GET', '/v1/games/game002')).status, 404);
  });

  it('refuses a delete older than the latest edit', async () => {
    await call('PUT', '/v1/games/abc123', makeGame('abc123', 5000));
    assert.equal((await call('DELETE', '/v1/games/abc123?deletedAt=4000')).status, 409);
  });

  it('keeps spaces apart', async () => {
    await call('PUT', '/v1/games/abc123', makeGame('abc123', 1000));
    const other = await json(await call('GET', '/v1/games', undefined, LAKEVIEW_KEY));
    assert.equal(other.changes.length, 0);
    assert.equal((await call('GET', '/v1/games/abc123', undefined, LAKEVIEW_KEY)).status, 404);
  });

  it('serves season stats and CSV exports', async () => {
    await call('PUT', '/v1/games/game001', makeGame('game001', 1000, 10));
    await call('PUT', '/v1/games/game002', makeGame('game002', 1001, 14));

    const seasons = await json(await call('GET', '/v1/seasons'));
    assert.deepEqual(seasons.seasons, [{ season: '2026-27', games: 2 }]);

    const stats = await json(await call('GET', '/v1/seasons/2026-27/stats?team=Eagles'));
    assert.equal(stats.players[0].points, 24);
    assert.equal(stats.players[0].games, 2);

    const csv = await call('GET', '/v1/seasons/2026-27/stats?format=csv');
    assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
    assert.match(await csv.text(), /^team,number,name,games/);

    const gameCsv = await call('GET', '/v1/games/game001/export?format=csv');
    assert.match(await gameCsv.text(), /Eagles,Lakeview,23,Rivera/);
  });
});

describe('parseKeys', () => {
  it('requires a space name and a long key', () => {
    assert.throws(() => parseKeys('short:abc'), /at least 32/);
    assert.throws(() => parseKeys(`${'x'.repeat(40)}`), /space name/);
    assert.equal(parseKeys(`a:${'k'.repeat(32)}, b:${'j'.repeat(32)}`).size, 2);
    assert.equal(parseKeys(undefined).size, 0);
  });
});

describe('group invite page', () => {
  it('shows a well-formed code with a link into the app, and never looks it up', async () => {
    const s = await makeServer();
    const res = await s.call('GET', '/join/abcd2345');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const html = await res.text();
    assert.ok(html.includes('ABCD2345'));
    assert.ok(html.includes('href="inkstat://join/ABCD2345"'));
    // Not an invite alphabet (0, O, 1, I, L), too short, or markup: no page.
    for (const bad of ['ABCD0123', 'ABC', '%3Cscript%3E']) assert.equal((await s.call('GET', `/join/${bad}`)).status, 404);
  });

  it("does not reveal a real group's name", async () => {
    const s = await makeServer();
    const a = await s.signIn('owner');
    const created = await json(await s.call('POST', '/v1/groups', { name: 'Lakeview Eagles', kind: 'team' }, a.accessToken));
    const html = await (await s.call('GET', `/join/${created.group.inviteCode}`)).text();
    assert.ok(html.includes(created.group.inviteCode));
    assert.ok(!html.includes('Lakeview'));
  });
});
