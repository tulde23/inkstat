import type { ExtractionRun, RegionResult } from '@inkstat/ocr-engine';

import {
  SCOREBOOK_PAGE_TEMPLATE,
  dropFinalFromPeriods,
  REGION,
  REQUIRED_PARTS,
  applyTemplate,
  fromLegacyLayout,
  isUsable,
  markedParts,
  newTemplate,
  normalizeTemplate,
  unmarkedParts,
  templateChecks,
  type ScorebookTemplate,
  emptyTeam,
  isPlayerName,
  gameToCsv,
  mergePlayers,
  normalizeDate,
  today,
  perPeriodScores,
  readPage,
  seasonFor,
  seasonTotals,
  validateTeam,
  validateGame,
  wasRead,
  type Game,
  type PlayerLine,
} from '..';

const player = (p: Partial<PlayerLine>): PlayerLine => ({
  number: null,
  name: null,
  fouls: null,
  fg2: null,
  fg3: null,
  ftMade: null,
  ftAttempted: null,
  points: null,
  readNotes: [],
  ...p,
});

const result = (regionId: string, tileIndex: number, data: unknown, warnings: string[] = []): RegionResult => ({
  regionId,
  tileIndex,
  tileCount: 3,
  rect: { x: 0, y: 0, w: 1, h: 1 },
  imageUri: `crop-${regionId}-${tileIndex}`,
  imageUris: [`crop-${regionId}-${tileIndex}`],
  data,
  raw: '',
  warnings,
  attempts: 1,
  durationMs: 1,
});

/** A player row as the model returns it (short keys from the template). */
const raw = (no: string, name: string, tp: number | null, extra: object = {}) => ({
  no,
  name,
  tp,
  f: 1,
  p2: 2,
  p3: 0,
  ftm: 1,
  fta: 2,
  ...extra,
});

describe('readPage', () => {
  const run: ExtractionRun = {
    templateId: 'basketball.scorebook-page',
    templateVersion: 1,
    modelId: 'fake',
    sourceUri: 'page.jpg',
    startedAt: 0,
    finishedAt: 1,
    results: [
      result('summary', 0, {
        team_name: 'Eagles',
        opponent: 'Lakeview',
        date: '11/14/26',
        location: null,
        period_scores: [12, 15, 11, 16],
        final_score: 54,
        timeouts_used: 3,
      }),
      result('players', 0, { players: [raw('3', 'Kim', 5), raw('11', 'Okafor', null)] }, ['$.players[1].f: read "1 " as 1']),
      // Overlap: Okafor appears again in the next strip with more filled in.
      result('players', 1, { players: [raw('11', 'Okafor', 5), raw('23', 'Rivera', 5)] }),
      result('players', 2, null),
    ],
  };

  const page = readPage(run);

  it('reads the summary', () => {
    expect(page.team.name).toBe('Eagles');
    expect(page.opponent).toBe('Lakeview');
    expect(page.team.periodScores).toEqual([12, 15, 11, 16]);
    expect(page.team.totalPoints).toBe(54);
  });

  it('merges players seen in overlapping strips', () => {
    expect(page.team.players.map((p) => p.number)).toEqual(['3', '11', '23']);
    expect(page.team.players[1].points).toBe(5);
  });

  it('keeps per-row read notes through the merge', () => {
    expect(page.team.players[1].readNotes).toContain('f: read "1 " as 1');
  });

  it('reports strips the model failed on', () => {
    expect(page.failures).toEqual(['players strip 3']);
  });

  it('keeps crops for review', () => {
    expect(page.team.crops.map((c) => c.regionId)).toEqual(['summary', 'players-1', 'players-2', 'players-3']);
  });

  it('fixes what the model got wrong on the real Stars sheet', () => {
    // What Qwen3-VL 2B actually returned for the summary of the Stars training sheet.
    const stars = readPage({
      ...run,
      results: [
        result('summary', 0, {
          team_name: 'STARS',
          opponent: 'HENLEY',
          date: '12-15-14',
          location: 'Henley',
          period_scores: [15, 26, 39, 50, 50],
          final_score: 150,
          timeouts_used: null,
        }),
      ],
    });
    expect(stars.team.periodScores).toEqual([15, 11, 13, 11]);
    expect(stars.opponent).toBeNull();
    expect(stars.location).toBe('Henley');
    expect(stars.notes[0]).toMatch(/running totals/);
  });
});

describe('readPage on the Stars sheet, second run', () => {
  it('drops nameless rows picked up from the running-score grid', () => {
    const page = readPage({
      templateId: 'basketball.scorebook-page',
      templateVersion: 2,
      modelId: 'fake',
      sourceUri: 'page.jpg',
      startedAt: 0,
      finishedAt: 1,
      results: [
        result('players', 0, {
          players: [
            raw('1', '', 9),
            raw('2', '', 14),
            raw('3', '', 7),
            raw('4', '8', 8),
            raw('5', 'Robinson', 4),
          ],
        }),
        result('players', 1, { players: [raw('11', 'Malone', 4), raw('12', 'Stockton', 3)] }),
      ],
    });
    expect(page.team.players.map((p) => p.name)).toEqual(['Robinson', 'Malone', 'Stockton']);
    expect(page.notes).toContain('Dropped 4 row(s) with no player name.');
  });
});

describe('perPeriodScores', () => {
  it('converts running totals ending at the final', () => {
    expect(perPeriodScores([15, 26, 39, 50], 50)).toEqual({ scores: [15, 11, 13, 11], wasCumulative: true });
  });

  it('leaves real per-period scores alone, even when they rise', () => {
    expect(perPeriodScores([10, 12, 14, 16], 52)).toEqual({ scores: [10, 12, 14, 16], wasCumulative: false });
    expect(perPeriodScores([12, 15, 11, 16], 54).wasCumulative).toBe(false);
  });

  it('does not guess with gaps', () => {
    expect(perPeriodScores([15, null, 39, 50], 50).wasCumulative).toBe(false);
  });
});

describe('mergePlayers', () => {
  it('treats "#07" and "7" as the same player, and drops empty rows', () => {
    const merged = mergePlayers([player({ number: '#07', name: 'A' }), player({}), player({ number: '7', fouls: 2, name: 'A' })]);
    expect(merged).toHaveLength(1);
    expect(merged[0].fouls).toBe(2);
  });
});

describe('validateTeam', () => {
  it('flags points that do not add up, at the points cell', () => {
    const team = { ...emptyTeam(), totalPoints: 19, players: [player({ number: '23', fg2: 5, fg3: 2, ftMade: 1, ftAttempted: 3, points: 19 })] };
    const issues = validateTeam(team, 'home');
    expect(issues).toContainEqual(expect.objectContaining({ path: 'home.players.0.points', severity: 'warning' }));
    expect(issues.find((i) => i.path === 'home.players.0.points')?.message).toContain('add up to 17');
  });

  it('errors when free throws made exceed attempts', () => {
    const team = { ...emptyTeam(), totalPoints: 3, players: [player({ number: '1', ftMade: 3, ftAttempted: 2, points: 3 })] };
    expect(validateTeam(team, 'away')[0]).toMatchObject({ severity: 'error', path: 'away.players.0.ftMade' });
  });

  it('checks fouls, duplicate numbers, and team totals', () => {
    const team = {
      ...emptyTeam(),
      periodScores: [10, 10, 10, 10],
      totalPoints: 45,
      players: [player({ number: '5', fouls: 6, points: 20 }), player({ number: '5', points: 20 })],
    };
    const paths = validateTeam(team, 'home').map((i) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining(['home.players.0.fouls', 'home.players.1.number', 'home.totalPoints', 'home.periodScores']),
    );
  });

  it('says when known points fall short of the final (the Pixel run on the Stars sheet)', () => {
    const team = {
      ...emptyTeam(),
      periodScores: [15, 11, 13, 11],
      totalPoints: 50,
      players: [
        player({ number: '9', name: 'Jordan' }),
        player({ number: '10', name: 'Drexler' }),
        player({ number: '11', points: 4 }),
        player({ number: '12', points: 3 }),
        player({ number: '13', points: 6 }),
        player({ number: '14', points: 8 }),
        player({ number: '15', points: 2 }),
      ],
    };
    const issue = validateTeam(team, 'home').find((i) => i.path === 'home.totalPoints');
    expect(issue?.message).toBe(
      'Player points found so far add up to 23 of 50 (2 players have no points read). Some rows may be missing.',
    );
  });

  it('passes a clean sheet', () => {
    const team = {
      ...emptyTeam(),
      periodScores: [2, 3, 0, 0],
      totalPoints: 5,
      players: [player({ number: '3', fg2: 1, fg3: 1, ftMade: 0, ftAttempted: 0, fouls: 1, points: 5 })],
    };
    expect(validateTeam(team, 'home')).toEqual([]);
  });

  it("doesn't flag the other team when only one team's page was read", () => {
    const home = { ...emptyTeam(), name: 'Lions', pageUri: 'file:///home.jpg', periodScores: [2, 3, 0, 0], totalPoints: 5, players: [player({ number: '3', points: 5 })] };
    const game = { id: 'g', date: null, location: null, season: '2026-27', home, away: { ...emptyTeam(), name: 'Tigers' }, modelId: null, createdAt: 0, updatedAt: 0 };
    expect(validateGame(game)).toEqual([]);
    expect(wasRead(game.away)).toBe(false);
  });

  describe("books with quarter columns and a running score (Glover's Short Form)", () => {
    const glover = (over: Partial<ReturnType<typeof emptyTeam>> = {}) => ({
      ...emptyTeam(),
      periodScores: [7, 4, 6, 3],
      totalPoints: 20,
      halfScore: 11,
      runningScore: 20,
      players: [
        player({ number: '4', points: 12, periodPoints: [5, 2, 4, 1] }),
        player({ number: '11', points: 8, periodPoints: [2, 2, 2, 2] }),
      ],
      ...over,
    });

    it('passes when every total agrees', () => {
      expect(validateTeam(glover(), 'home')).toEqual([]);
    });

    it("flags a player whose quarter columns don't add up to their points", () => {
      const team = glover({ players: [player({ number: '4', points: 12, periodPoints: [5, 2, 4, 3] }), player({ number: '11', points: 8, periodPoints: [2, 2, 2, 2] })] });
      const issues = validateTeam(team, 'home');
      expect(issues).toContainEqual(expect.objectContaining({ path: 'home.players.0.points', message: '#4: quarter columns add up to 14, but points say 12' }));
      expect(issues).toContainEqual(expect.objectContaining({ path: 'home.periodScores.3', message: 'Player points in the 4th quarter add up to 5, but the 4th quarter box says 3' }));
    });

    it('only flags a quarter falling short when every cell was read', () => {
      const partial = glover({ players: [player({ number: '4', points: 12, periodPoints: [5, 2, 4, 1] }), player({ number: '11', points: 8, periodPoints: [null, 2, 2, 2] })] });
      expect(validateTeam(partial, 'home').map((i) => i.path)).not.toContain('home.periodScores.0');
      const full = glover({ periodScores: [9, 4, 6, 3], totalPoints: 22, runningScore: 22, halfScore: 13 });
      expect(validateTeam(full, 'home')).toContainEqual(expect.objectContaining({ path: 'home.periodScores.0' }));
    });

    it('checks the running score and half-time score against the boxes', () => {
      const paths = validateTeam(glover({ runningScore: 18, halfScore: 10 }), 'home').map((i) => i.path);
      expect(paths).toEqual(expect.arrayContaining(['home.runningScore', 'home.halfScore']));
    });

    it('names overtime periods', () => {
      const team = glover({
        periodScores: [7, 4, 6, 3, 2],
        totalPoints: 22,
        runningScore: 22,
        players: [player({ number: '4', points: 14, periodPoints: [5, 2, 4, 1, 4] }), player({ number: '11', points: 8, periodPoints: [2, 2, 2, 2, 0] })],
      });
      expect(validateTeam(team, 'home').map((i) => i.message)).toContain('Player points in the overtime add up to 4, but the overtime box says 2');
    });
  });
});

describe('dates and seasons', () => {
  it('normalizes common scorebook dates', () => {
    expect(normalizeDate('11/14/26')).toBe('2026-11-14');
    expect(normalizeDate('2026-1-5')).toBe('2026-01-05');
    expect(normalizeDate('Nov 14', 2026)).toBeNull();
    expect(normalizeDate('13/40/26')).toBeNull();
  });

  it("gives today's date on the phone's own calendar, for a sheet with no date", () => {
    // 11:30 pm local on Nov 23 is already Nov 24 in UTC: the game was still played on the 23rd.
    expect(today(new Date(2026, 10, 23, 23, 30))).toBe('2026-11-23');
    expect(today(new Date(2027, 0, 5, 0, 5))).toBe('2027-01-05');
  });

  it('puts fall and winter games in the same season', () => {
    expect(seasonFor('2026-11-14')).toBe('2026-27');
    expect(seasonFor('2027-02-01')).toBe('2026-27');
    expect(seasonFor('2027-08-15')).toBe('2027-28');
  });
});

const game = (id: string, players: PlayerLine[]): Game => ({
  id,
  date: '2026-11-14',
  location: null,
  season: '2026-27',
  home: { ...emptyTeam(), name: 'Eagles', players },
  away: { ...emptyTeam(), name: 'Lakeview, North' },
  modelId: null,
  createdAt: 0,
  updatedAt: 0,
});

describe('season totals and export', () => {
  it('rolls up a player across games by team and number', () => {
    const lines = seasonTotals([
      game('a', [player({ number: '23', name: 'Rivera', points: 20, ftMade: 2, ftAttempted: 4 })]),
      game('b', [player({ number: '23', points: 10, ftMade: 1, ftAttempted: 1 })]),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ name: 'Rivera', games: 2, points: 30, ftMade: 3, ftAttempted: 5 });
  });

  it('escapes CSV fields with commas', () => {
    const csv = gameToCsv(game('a', [player({ number: '3', name: 'Kim', points: 5 })]));
    expect(csv.split('\n')[1]).toBe('2026-11-14,Eagles,"Lakeview, North",3,Kim,,,,,,5');
  });
});

describe('scorebook templates', () => {
  const marked = (): ScorebookTemplate => ({
    ...newTemplate('t1', 'Stars', null, 0),
    parts: {
      rows: { x: 0.1, y: 0.36, w: 0.8, h: 0.4 },
      names: { x: 0.11, w: 0.17 },
      points: { x: 0.83, w: 0.03 },
      fouls: { x: 0.45, w: 0.08 },
      teamName: { x: 0.06, y: 0.02, w: 0.3, h: 0.05 },
      coach: { x: 0.4, y: 0.02, w: 0.2, h: 0.05 },
      location: { x: 0.64, y: 0.02, w: 0.18, h: 0.05 },
      date: { x: 0.84, y: 0.02, w: 0.14, h: 0.05 },
      timeouts: { x: 0.03, y: 0.19, w: 0.28, h: 0.1 },
      teamFouls: { x: 0.33, y: 0.19, w: 0.34, h: 0.1 },
      quarters: { x: 0.69, y: 0.19, w: 0.29, h: 0.1 },
    },
  });

  it('reads points from names | TP, and fouls in their own names | fouls pass', () => {
    const t = applyTemplate(SCOREBOOK_PAGE_TEMPLATE, marked());
    const players = t.regions.find((r) => r.id === 'players')!;
    expect(players.rect).toEqual({ x: 0.1, y: 0.36, w: 0.8, h: 0.4 });
    expect(players.joinColumns).toBe(true);
    expect(players.columns?.map((c) => c.x)).toEqual([0.11, 0.83]);
    expect(players.prompt).toContain('use null for f');
    const fouls = t.regions.find((r) => r.id === REGION.fouls)!;
    expect(fouls.columns?.map((c) => c.x)).toEqual([0.11, 0.45]);
    expect(fouls.prompt).toContain('crossed off');
  });

  it('asks for the F total instead when the book writes one', () => {
    const t = applyTemplate(SCOREBOOK_PAGE_TEMPLATE, { ...marked(), variants: { fouls: 'total' } });
    expect(t.regions.find((r) => r.id === REGION.fouls)!.columns?.[1].label).toBe('fouls (F total)');
  });

  it('reads each game detail in its own small read', () => {
    const ids = applyTemplate(SCOREBOOK_PAGE_TEMPLATE, marked()).regions.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['detail_team_name', 'detail_coach', 'detail_location', 'detail_date']));
    expect(ids).not.toContain(REGION.details);
  });

  it('puts fouls from their own pass onto the right players by number', () => {
    const run: ExtractionRun = {
      templateId: 't',
      templateVersion: 1,
      modelId: 'test',
      sourceUri: 'page',
      startedAt: 0,
      finishedAt: 1,
      results: [
        result('players', 0, { players: [{ no: '5', name: 'Robinson', tp: 4, f: null }, { no: '6', name: 'Ewing', tp: 2, f: null }] }),
        result(REGION.fouls, 0, { players: [{ no: '06', f: 2 }, { no: '5', f: 1 }] }),
        result('detail_date', 0, { date: '12-15-14' }),
      ],
    };
    const page = readPage(run);
    expect(page.team.players.map((p) => [p.number, p.fouls])).toEqual([['5', 1], ['6', 2]]);
    expect(page.date).toBe('12-15-14');
  });

  it('skips the whole-page summary only when everything it covers is marked', () => {
    expect(applyTemplate(SCOREBOOK_PAGE_TEMPLATE, marked()).regions.map((r) => r.id)).not.toContain('summary');
    const noQuarters = { ...marked(), enabled: marked().enabled.filter((id) => id !== 'quarters') };
    const ids = applyTemplate(SCOREBOOK_PAGE_TEMPLATE, noQuarters).regions.map((r) => r.id);
    expect(ids).toContain('summary');
    expect(ids).not.toContain(REGION.quarters);
  });

  it('leaves out parts that are switched off or not marked', () => {
    const t = { ...marked(), enabled: REQUIRED_PARTS };
    const players = applyTemplate(SCOREBOOK_PAGE_TEMPLATE, t).regions.find((r) => r.id === 'players')!;
    expect(players.columns).toHaveLength(2);
    expect(players.prompt).toContain('use null for f');
    expect(isUsable(t)).toBe(true);
    expect(isUsable({ ...t, parts: { rows: t.parts.rows } })).toBe(false);
    expect(unmarkedParts({ ...marked(), parts: {} })[0]).toBe('rows');
  });

  it('keeps bands inside the rows box and boxes inside the page', () => {
    const t = normalizeTemplate({
      ...marked(),
      parts: { rows: { x: 0.9, y: -0.2, w: 0.5, h: 2 }, names: { x: 0, w: 0.5 }, coach: { x: 1.2, y: 0.5, w: 0.3, h: 0.1 } },
    });
    const rows = t.parts.rows as { x: number; y: number; w: number; h: number };
    expect(rows.x + rows.w).toBeLessThanOrEqual(1);
    expect(rows.y).toBe(0);
    expect(t.parts.names!.x).toBeGreaterThanOrEqual(rows.x);
    expect(t.parts.coach!.x + t.parts.coach!.w).toBeLessThanOrEqual(1);
  });

  it('turns a layout saved before templates into a template', () => {
    const t = fromLegacyLayout(
      { version: 1, table: { x: 0.1, y: 0.3, w: 0.8, h: 0.5 }, nameColumn: { x: 0.12, w: 0.2 }, pointsColumn: { x: 0.8, w: 0.04 }, teamName: { x: 0.1, y: 0.02, w: 0.3, h: 0.05 } },
      'legacy',
    );
    expect(markedParts(t)).toEqual(['rows', 'names', 'points', 'teamName']);
    expect(isUsable(t)).toBe(true);
  });

  it('fills the box score from the marked boxes, preferring them over the whole page', () => {
    const run: ExtractionRun = {
      templateId: SCOREBOOK_PAGE_TEMPLATE.id,
      templateVersion: SCOREBOOK_PAGE_TEMPLATE.version,
      modelId: 'test',
      sourceUri: 'page',
      startedAt: 0,
      finishedAt: 1,
      results: [
        result('summary', 0, { team_name: 'W.B. WOB', location: 'Henley', period_scores: [1, 2, 3, 4], final_score: 10, timeouts_used: 0 }),
        result(REGION.details, 0, { team_name: ' Stars ', coach: 'Daly', date: '12-15-14' }),
        result(REGION.quarters, 0, { period_scores: [15, 26, 39, 50, 0], final_score: 50 }),
        result(REGION.timeouts, 0, { timeouts_used: 5 }),
        result(REGION.teamFouls, 0, { team_fouls: [5, 4] }),
      ],
    };
    const page = readPage(run);
    expect(page.team).toMatchObject({
      name: 'Stars',
      coach: 'Daly',
      periodScores: [15, 11, 13, 11],
      totalPoints: 50,
      timeoutsUsed: 5,
      teamFouls: [5, 4],
    });
    expect(page.date).toBe('12-15-14');
    expect(page.location).toBe('Henley');
    expect(page.team.crops.map((c) => c.regionId)).toEqual(['summary', 'details', 'quarters', 'timeouts', 'team_fouls']);
  });
});

describe('isPlayerName', () => {
  it('rejects digits and printed form labels', () => {
    expect(isPlayerName('Robinson')).toBe(true);
    expect(isPlayerName('Running Score')).toBe(false);
    expect(isPlayerName('Player Scoring')).toBe(false);
    expect(isPlayerName('14')).toBe(false);
    expect(isPlayerName(null)).toBe(false);
  });
});

describe('templateChecks', () => {
  it('passes parts that were read and cross-check, and explains the ones that do not', () => {
    const t = {
      ...newTemplate('t', 'x', null, 0),
      enabled: [...REQUIRED_PARTS, 'fouls', 'coach', 'quarters'] as ScorebookTemplate['enabled'],
      parts: {
        rows: { x: 0, y: 0.3, w: 1, h: 0.6 },
        names: { x: 0, w: 0.2 },
        points: { x: 0.9, w: 0.05 },
        fouls: { x: 0.5, w: 0.1 },
        coach: { x: 0.4, y: 0, w: 0.2, h: 0.05 },
        quarters: { x: 0.7, y: 0.1, w: 0.3, h: 0.1 },
      },
    };
    const team = {
      ...emptyTeam(),
      periodScores: [3, 2, 1, 0],
      totalPoints: 6,
      players: [player({ number: '5', name: 'A', points: 4, fouls: 1 }), player({ number: '6', name: 'B', points: 2 })],
    };
    const checks = templateChecks(t, { team, opponent: null, date: null, location: null, failures: [], notes: [] });
    const by = Object.fromEntries(checks.map((c) => [c.part, c]));
    expect(checks.map((c) => c.part)).toEqual(['rows', 'names', 'points', 'fouls', 'coach', 'quarters']);
    expect(by.points).toMatchObject({ ok: true, value: 'add up to 6 ✓' });
    expect(by.quarters).toMatchObject({ ok: true });
    expect(by.fouls).toMatchObject({ ok: false, value: '1 read, 1 unclear' });
    expect(by.coach).toMatchObject({ ok: false, value: 'Not read' });
  });
});

describe('dropFinalFromPeriods', () => {
  it('drops a copied Final and empty overtime boxes, but keeps a real overtime', () => {
    expect(dropFinalFromPeriods([15, 26, 39, 50, null, 50], 50)).toEqual([15, 26, 39, 50]);
    expect(dropFinalFromPeriods([15, 11, 13, 11, 0], 50)).toEqual([15, 11, 13, 11]);
    expect(dropFinalFromPeriods([15, 11, 13, 11, 6], 56)).toEqual([15, 11, 13, 11, 6]);
  });
});

describe('mergePlayers across strip edges', () => {
  it('keeps the whole copy of a row cut off at the bottom of a strip', () => {
    const cut = player({ number: '10', name: 'D...', points: 3 });
    const whole = player({ number: '10', name: 'Drexler', points: 2 });
    expect(mergePlayers([cut, whole], new Set([cut]))[0].points).toBe(2);
    // A truncated name counts against a copy even without the edge flag.
    expect(mergePlayers([cut, whole])[0].name).toBe('Drexler');
  });
});
