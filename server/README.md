# InkStat API

One small Node service (Hono + SQLite on a mounted volume) behind the InkStat app. The app works fully offline without it. With it:

- **Accounts**: Sign in with Apple or Google (Orbit's model: no passwords, identities keyed on provider + subject, rotating refresh tokens).
- **Groups**: a league, a school's program, or one team's scorekeepers. Members share games (the sync feed), a team list, standings and rosters. Join by invite code.
- **Shared registry**: teams that scorekeepers build up as they go (with aliases and merges), which scorebook template each team uses, and final scores (confirmed when two scorekeepers agree).

**Privacy rule:** player names never leave a group. The registry holds team names, layouts and scores only. Shared templates keep only printed scoresheet words as anchors (`src/sanitize.ts`), never a photo.

The basketball types, validation and season math come from `packages/basketball`, shared with the app, and are bundled into the server at build time.

## Run locally

```sh
cd server
npm install
INKSTAT_AUTH_KEY="$(openssl rand -hex 32)" GOOGLE_CLIENT_IDS="<web client id>" npm run dev   # http://localhost:8787
npm test
```

Or with Docker, built from the **repo root** so the shared packages are in the build context:

```sh
docker build -f server/Dockerfile -t inkstat-api .
docker run -p 8787:8787 -v inkstat-data:/data -e INKSTAT_AUTH_KEY="<64 hex>" inkstat-api
```

## Deploy on Railway

1. **New Project → Deploy from GitHub repo** → pick this repo.
2. In the service's **Variables**, set:

   | Variable | Value |
   | --- | --- |
   | `RAILWAY_DOCKERFILE_PATH` | `server/Dockerfile` |
   | `INKSTAT_AUTH_KEY` | `openssl rand -hex 32`. Signs access tokens; changing it signs everyone out of their current access token (refresh still works). |
   | `INKSTAT_DATA_KEY` | `openssl rand -hex 32`. Encrypts the Apple token kept for revocation. Never change it once set. |
   | `GOOGLE_CLIENT_IDS` | The Google **web** client id (the audience the app requests on Android and iOS). |
   | `APPLE_CLIENT_IDS` | `com.inkstat.app` (the iOS bundle id). |
   | `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` | The Sign in with Apple key (.p8 contents; `
` allowed). Needed to revoke Apple tokens on account deletion (App Store 5.1.1(v)). |
   | `INKSTAT_API_KEYS` | Optional, legacy: `eagles:<key>` shared-key spaces from the first sync build. |
   | `PUBLIC_WEB_ORIGINS` | Optional: more browser origins (comma-separated) allowed to read `/v1/public/*`, e.g. the web service's `*.up.railway.app` URL. `https://inkstat.app` and `https://www.inkstat.app` are always allowed. |

   A provider with no client ids is simply off (`503 NotConfigured`).
3. **Settings → Volumes → Add volume**, mount path `/data`. The server finds it through `RAILWAY_VOLUME_MOUNT_PATH`.
4. **Settings → Deploy → Healthcheck path**: `/health`.
5. **Settings → Networking → Generate domain**. That URL plus the key go into the app under **Sync**.
6. Optional: **Settings → Build → Watch paths**: `server/**`, `packages/**`, so app-only commits don't redeploy the API.
7. **Backups tab**: turn on a daily schedule. Railway snapshots the whole volume, and SQLite's WAL mode makes those snapshots safe to restore.

Railway notes:
- A service with a volume runs **one replica**, and each redeploy has a few seconds of downtime. That's fine here; the app retries on the next sync.
- The container runs as root because Railway mounts volumes as root.
- Railway supplies `PORT` (8080 on this service); the public domain's target port must match it. The server listens on `::` (IPv4 and IPv6).
- Railway refuses a `VOLUME` line in the Dockerfile; the volume is attached in Railway at `/data`.
- `railway up` from the repo root uploads only `server/` and `packages/` (`.railwayignore`).

## API

Errors are `{ code, error }`; clients switch on `code`. Signed-in routes take `Authorization: Bearer <accessToken>`. Group and registry writes share a budget of 240 a minute per account; template publishes (registry or group) also have their own, 30 a minute.

### Sign-in and sessions

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | `{ ok, version }` |
| POST | `/v1/auth/social` | `{ provider: "Apple"\|"Google", idToken, nonce?, displayName?, authorizationCode? }` → `{ accessToken, refreshToken, expiresAt, user }`. Apple needs the raw nonce. |
| POST | `/v1/auth/refresh` | `{ refreshToken }` → a new pair. `401 RefreshRaced` means *the session is alive*: re-read storage and retry; **never sign out on it**. |
| POST | `/v1/auth/logout` | `{ refreshToken }`, idempotent |
| POST | `/v1/auth/apple/notifications` | Apple's server-to-server events; set this URL in the Apple developer portal |
| GET / PATCH / DELETE | `/v1/me` | Account, its sign-in providers and groups; rename; delete (revokes Apple's token) |
| POST | `/v1/me/sign-out-everywhere` | Ends every session |

Access tokens last 15 minutes, refresh tokens 90 days. A stale copy within a minute of rotation is a race, not a leak; a rotation whose answer was lost is reissued for 30 minutes; any other replay ends that token's chain (other devices stay signed in).

### Personal sync (signed in)

Each account has its own space, so a scorekeeper's games and templates follow them across devices. Deleting the account deletes this space; games shared into a group stay with the group.

| Method | Path | Notes |
| --- | --- | --- |
| * | `/v1/me/games…`, `/v1/me/seasons…` | The games sync API below, for the account's own games |
| GET | `/v1/me/templates?since=<seq>` | Template change feed: `{ changes: [{ id, deleted, updatedAt, seq, data }], cursor, more }` |
| PUT | `/v1/me/templates/:id` | A version-3 template; `409` with `current` if the server's is newer. The photo path is dropped. |
| DELETE | `/v1/me/templates/:id?deletedAt=<ms>` | Tombstone |

### Groups

| Method | Path | Notes |
| --- | --- | --- |
| GET / POST | `/v1/groups` | List mine; create `{ name, kind: league\|school\|team }` (owner sees `inviteCode`) |
| POST | `/v1/groups/join` | `{ code }` |
| GET / PATCH | `/v1/groups/:gid` | Group and members; rename (owner) |
| POST | `/v1/groups/:gid/invite-code` | New code (owner) |
| POST | `/v1/groups/:gid/members/:uid/role` | `{ role }` (owner) |
| DELETE | `/v1/groups/:gid/members/:uid` | Leave, or remove someone (owner). The last owner can't leave others behind. |
| GET / POST / DELETE | `/v1/groups/:gid/teams[/:tid]` | The group's teams |
| GET | `/v1/groups/:gid/standings?season=` | W–L from results between the group's teams |
| GET / PUT | `/v1/groups/:gid/rosters/:tid?season=` | `{ players: [{ number, name }] }`, members only |
| * | `/v1/groups/:gid/games…`, `/v1/groups/:gid/seasons…` | The sync API below, for the group's games |
| GET / POST / DELETE | `/v1/groups/:gid/templates[/:tid]` | Templates shared with the group; see below |

### Group templates (members only)

One scorekeeper teaches InkStat a scoresheet; everyone in their league gets it. Every shared template goes through `sanitizeLayout`: catalog parts only, anchors only when they are printed scoresheet words, never the photo, never the phone's own template id. A template shared with a group is also in the registry (so it counts toward browsing below). Non-members get `404`, as for every group route.

| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| POST | `/v1/groups/:gid/templates` | Any member | Body: the app's version-3 template (photo, `test` and timestamps are ignored), or `{ templateId }` of a registry template. → `201` when newly shared, `200` when it updated one already there: `{ template, sharedBy: { userId, name }, sharedAt, mine, seq, droppedAnchors }`. The same app `id` from the same scorekeeper updates their template (in every group it's in) instead of adding one. Up to 200 live templates per group (`403 TooManyTemplates`). |
| GET | `/v1/groups/:gid/templates?since=<seq>&limit=<n>` | Any member | Change feed, oldest first: `{ changes: [{ id, deleted, updatedAt, seq, data, sharedBy, sharedAt, mine }], cursor, more }`. `data` is a version-3 template with the server's `id`, `photoUri: null` and `test: null`; unshared templates appear as `{ deleted: true, data: null }`. |
| GET | `/v1/groups/:gid/templates/:tid` | Any member | `{ template, sharedBy, sharedAt, mine, seq }`; `404` once unshared |
| DELETE | `/v1/groups/:gid/templates/:tid` | Whoever shared it, or an owner | Unshare (`403 NotYours` for other members). Leaves a tombstone in the feed; the registry copy stays. |

Templates may carry `sheet: { teams: "one"|"both", homeAt?: "top"|"bottom"|"left"|"right" }` (one team per page or both, and where home is). Personal sync, registry publish and group publish all validate and keep it.

### Registry

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/v1/teams?sport=&q=&level=&gender=&state=` | Search names and aliases, best first |
| POST | `/v1/teams` | `{ sport, name, school?, town?, state?, level, gender }` → the existing team (200) or a new one (201) with `similar` near-misses |
| GET | `/v1/teams/:id` | Team (merged ids follow to the survivor) and its templates, most used first |
| POST | `/v1/teams/:id/aliases` | `{ alias }` |
| POST | `/v1/teams/:id/merge` | `{ intoId }`: a vote; two different scorekeepers merge it |
| GET | `/v1/teams/:id/results?season=` | Record and results |
| POST | `/v1/teams/:id/templates` | `{ templateId }`: "I read this team's book with this" |
| POST / GET | `/v1/templates[/:id]` | A layout or the app's whole template; unknown parts and non-vocabulary anchors are dropped, the photo is never kept. With the app's `id`, publishing again updates it (`200`) instead of adding one (`201`): `{ id, sport, name, created, droppedAnchors }` |
| GET | `/v1/templates?sport=&q=&limit=` | Popular templates, most scorekeepers first (default 50, at most 100): `{ templates: [{ id, name, sport, users, teams, groups, lastUsed }] }`. Counts only: never which scorekeepers, teams or groups. `users` counts distinct people who published, shared or used it on a team. `q` matches the name. |
| POST | `/v1/results` | `{ sport, date, homeId, awayId, homeScore?, awayScore?, periods?: { home?, away? }, sourceId? }`: either score may be null (one team's page), not both. Joins the game other scorekeepers reported (same two teams either way round, within a day; see below) or starts one. Each side comes back as `{ id, name, score, state: known \| unknown \| conflicting, reports }`; status `partial` (a side unknown), `reported`, `confirmed` (both known, a side backed by 2+ scorekeepers) or `disputed` (a side conflicts) |
| GET / DELETE | `/v1/results/:id` | Read; withdraw my report (the game goes when nobody reports it) |

Matching a report to a game: the same sport and two teams (after merges), either way round, dated the same day or a day either side, where the reporter has no report yet. Closest date wins, then the same home team, then a game whose known scores agree. A game a day off is only joined if nothing conflicts; on the same date a conflict joins and disputes it. Scores and periods are mapped onto the stored home and away. A re-report replaces the scorekeeper's own report: the one with the same `sourceId` (the app's game id), or without ids, theirs for those teams on that date. With ids, a doubleheader stays two games. Standings count only games with both scores known and not disputed.

### Public scoreboard (anonymous, read-only)

What https://inkstat.app (`web/`) shows. No sign-in; GET only; 120 requests a minute per address; CORS for inkstat.app; `Cache-Control: public, max-age=60`. Team names, places (town, state), dates and final scores only: never players, rosters, groups, scorekeepers or report counts. A disputed result has `null` scores. A game is listed (and counted in `seasons`) only once both teams' scores are reported: partial games stay off.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/v1/public/seasons?sport=` | `{ seasons: [{ season, games }] }`, newest first |
| GET | `/v1/public/scoreboard?season=&sport=` | `{ sport, season, seasons, teams: [{ id, name, town, state, level, gender }], results: [{ id, date, home: { id, score }, away: { id, score }, status }] }`, newest first; `season` defaults to the newest with results |

### Games sync (per group, or a legacy key space at `/v1/games`)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `…/games?since=<seq>&limit=<n>` | Change feed, oldest first: `{ changes, cursor, more }`. Deletes appear as `{ deleted: true, game: null }` |
| GET | `…/games/:id` | One game plus its cross-check `issues` |
| PUT | `…/games/:id` | Create or update. `409` with `current` if the server has a newer `updatedAt` |
| DELETE | `…/games/:id?deletedAt=<ms>` | Leaves a tombstone so other devices learn about the delete |
| GET | `…/games/:id/export?format=csv\|json` | Box score export |
| GET | `…/seasons`, `…/seasons/:season/stats?team=&format=csv` | Seasons; season totals per player |

Page photos never leave the phone; the server strips their file paths on upload.
