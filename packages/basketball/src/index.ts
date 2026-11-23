export * from './types';
export { SCOREBOOK_PAGE_TEMPLATE } from './template';
export { dropFinalFromPeriods, isPlayerName, mergePlayers, normalizeDate, perPeriodScores, readPage, today, type PageReading } from './assemble';
export { DEFAULT_RULES, teamScore, validateGame, validateTeam, type ValidationRules, wasRead } from './validate';
export { pct, perGame, seasonFor, seasonTotals, teamNames, type SeasonLine } from './stats';
export { formatGamesBehind, formatPct, gameResults, standings, teamKey, type StandingRow, type TeamResult } from './standings';
export {
  assignGame,
  claimGames,
  findMySide,
  isMyTeamName,
  learnName,
  myPlayers,
  myResult,
  nameKey,
  opponentScore,
  other,
  sheetNames,
  teamSeason,
  type MyResult,
  type MyTeam,
  type Outcome,
  type TeamSeason,
} from './myteam';
export { gameToCsv, gameToJson, seasonToCsv } from './export';
export {
  DEFAULT_ENABLED,
  DEFAULT_PARTS,
  DETAIL_PARTS,
  PARTS,
  PART_GROUPS,
  REGION,
  REQUIRED_PARTS,
  applyTemplate,
  fromLegacyLayout,
  isUsable,
  migrateTemplate,
  markedParts,
  newTemplate,
  normalizeTemplate,
  partSpec,
  unmarkedParts,
  variantOf,
  type Band,
  type LegacyScorebookLayout,
  type PartGroup,
  type PartId,
  type PartSpec,
  type PartStatus,
  type PartVariant,
  type ScorebookTemplate,
} from './scorebook';
export { templateChecks, type PartCheck } from './templateCheck';
export { placeParts, suggestParts, type Placement } from './autoPlace';
export { scoreReading, truthTeam, type BenchScore, type BenchTruth } from './bench';
export { CATALOG, SPORT_ID } from "./scorebook";
export { LIBRARY, alignParts, anchorsForTemplate, matchLibrary, recognizeSheet, templateForPhoto, type BuiltinLayout, type LibraryMatch, type Recognition, type TemplateSource } from './library';

import type { SportModule } from '@inkstat/ocr-engine';
import { readPage as readBasketballPage } from './assemble';
import { placeParts as placeBasketball } from './autoPlace';
import { LIBRARY as BASKETBALL_LIBRARY } from './library';
import { CATALOG as BASKETBALL_CATALOG, applyTemplate as applyBasketball, type PartGroup as BasketballGroup, type PartId as BasketballPart } from './scorebook';
import { SCOREBOOK_PAGE_TEMPLATE as BASKETBALL_PAGE } from './template';
import { templateChecks as basketballChecks } from './templateCheck';

/** Basketball, plugged into the shared template machinery. */
export const BASKETBALL: SportModule<BasketballPart, BasketballGroup> = {
  id: 'basketball',
  name: 'Basketball',
  pageNoun: 'scorebook page',
  catalog: BASKETBALL_CATALOG,
  library: BASKETBALL_LIBRARY,
  placeParts: placeBasketball,
  documentFor: (t) => applyBasketball(BASKETBALL_PAGE, t),
  checks: (t, run) => basketballChecks(t, readBasketballPage(run)),
};
