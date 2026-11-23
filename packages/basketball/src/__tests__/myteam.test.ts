import {
  assignGame,
  claimGames,
  emptyTeam,
  findMySide,
  isMyTeamName,
  learnName,
  myPlayers,
  myResult,
  sheetNames,
  teamSeason,
  type Game,
  type MyTeam,
  type PlayerLine,
  type TeamSheet,
} from '../index';

const team: MyTeam = { id: 't1', name: 'Beacon Hill JV Girls 2026', aliases: ['BEACON'], createdAt: 0, updatedAt: 0 };

const player = (number: string, points: number): PlayerLine =>
  ({ number, name: null, fg2: null, fg3: null, ftMade: null, ftAttempted: null, fouls: null, points }) as PlayerLine;

/** A side; `players` makes it a page that was read, `total` alone is a typed-in score. */
const side = (name: string | null, total: number | null, players: PlayerLine[] = []): TeamSheet => ({
  ...emptyTeam(),
  name,
  totalPoints: total,
  players,
  pageUri: players.length ? 'file://page.jpg' : null,
});

let n = 0;
const game = (home: TeamSheet, away: TeamSheet, date = '2026-11-14', extra: Partial<Game> = {}): Game => ({
  id: `g${++n}abcdef`,
  date,
  location: null,
  season: '2026-27',
  home,
  away,
  modelId: null,
  createdAt: n,
  updatedAt: n,
  ...extra,
});

describe('my team', () => {
  it('knows its names on the sheet, however they are written', () => {
    expect(isMyTeamName('Beacon.', team)).toBe(true);
    expect(isMyTeamName('beacon hill jv girls 2026', team)).toBe(true);
    expect(isMyTeamName('Lakeview', team)).toBe(false);
    expect(isMyTeamName(null, team)).toBe(false);
  });

  it('finds its side by name', () => {
    const g = game(side('Lakeview', 48, [player('3', 48)]), side('BEACON', 54, [player('23', 54)]));
    expect(findMySide(g, team)).toEqual({ side: 'away', learn: null });
  });

  it("takes the only page read as yours, and learns the name it was written under", () => {
    const g = game(side('BH', 54, [player('23', 54)]), side('Lakeview', null));
    expect(findMySide(g, team)).toEqual({ side: 'home', learn: 'BH' });
    const learned = learnName(team, 'BH', 5);
    expect(learned.aliases).toEqual(['BEACON', 'BH']);
    expect(learnName(learned, 'b.h.', 6)).toBe(learned);
  });

  it('asks when both pages were read and neither name matches', () => {
    const g = game(side('Hawks', 40, [player('1', 40)]), side('Eagles', 38, [player('2', 38)]));
    expect(findMySide(g, team)).toEqual({ ask: true });
  });

  it('works out the result, and waits for the opponent score when it is missing', () => {
    const won = assignGame(game(side('BEACON', 54, [player('23', 54)]), side('Lakeview', 48)), team, 'home');
    expect(myResult(won)).toMatchObject({ us: 54, them: 48, opponent: 'Lakeview', outcome: 'W' });
    const unknown = assignGame(game(side('BEACON', 54, [player('23', 54)]), side('Lakeview', null)), team, 'home');
    expect(myResult(unknown)).toMatchObject({ us: 54, them: null, outcome: null });
    expect(myResult(game(side('A', 1), side('B', 2)))).toBeNull();
  });

  it("keeps the season record and the current streak, newest game first", () => {
    const g = (date: string, us: number, them: number) =>
      assignGame(game(side('BEACON', us, [player('23', us)]), side('X', them), date), team, 'home');
    const games = [g('2026-11-01', 30, 40), g('2026-11-05', 50, 40), g('2026-11-09', 44, 41), g('2026-11-12', 39, 31)];
    const other = game(side('Hawks', 10), side('Eagles', 20)); // not this team's
    const s = teamSeason([...games, other], 't1');
    expect([s.wins, s.losses, s.ties]).toEqual([3, 1, 0]);
    expect(s.streak).toEqual({ kind: 'W', count: 3 });
    expect(s.results.map((r) => r.game.date)).toEqual(['2026-11-12', '2026-11-09', '2026-11-05', '2026-11-01']);
    expect(s.pointsFor).toBe(40.8);
    expect(s.pointsAgainst).toBe(38);
  });

  it("leads with your players only, even when the sheet spells the team differently", () => {
    const a = assignGame(game(side('BEACON', 20, [player('23', 12), player('5', 8)]), side('Lakeview', 18, [player('9', 18)])), team, 'home');
    const b = assignGame(game(side('Mercer', 30, [player('7', 30)]), side('BH', 25, [player('23', 15), player('5', 10)])), team, 'away');
    const lines = myPlayers([a, b], team);
    expect(lines.map((l) => [l.number, l.games, l.points])).toEqual(
      expect.arrayContaining([
        ['23', 2, 27],
        ['5', 2, 18],
      ]),
    );
    expect(lines).toHaveLength(2);
  });

  it('suggests the names on earlier games, most used first, and claims matching games', () => {
    const games = [
      game(side('STARS', 50), side('Away', 0)),
      game(side('Stars.', 40), side('Henley', 30)),
      game(side('Eagles', 54), side('Lakeview', 48)),
    ];
    expect(sheetNames(games).slice(0, 1)).toEqual(['STARS']);
    const stars: MyTeam = { ...team, id: 't2', name: 'Stars 2014', aliases: ['STARS'] };
    const claimed = claimGames(games, stars, 9);
    expect(claimed.map((g) => [g.mine, g.teamId])).toEqual([
      ['home', 't2'],
      ['home', 't2'],
    ]);
  });
});
