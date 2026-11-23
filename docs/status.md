# Where InkStat stands

_Last updated 2026-11-23, on branch `feat/scan-recognition`._

## Direction

InkStat turns a paper scoresheet page into a checked box score for **one team: yours**.
It is not league software. Standings, a public scoreboard and cross-team game matching
are parked (the code stays, nothing new gets built on them).

- **Who:** the volunteer or parent who keeps a team's book, after the game, on a phone.
- **What they want:** their team's box score, the win or loss, the season record and team leaders,
  and an easy way to share or export them.
- **Sign-in is optional.** Scanning, checking and exporting never ask for it. Google / Apple sign-in
  is used only for backup across phones, groups (a team's scorekeepers and coaches) and
  sharing templates. Apple "Hide My Email" relay addresses work.

## In this branch

**Reading the page**
- Recognise the scoresheet first (`recognizeForm` / `recognizeSheet`): sure, partly, none, or no text.
  Built-in books, the league's templates and your own are all candidates.
- Glover's Short Form is a built-in book (printed-label anchors only).
- Alignment adds a perspective (homography) refinement after the affine fit, for tilted photos.
- Two-page spreads are detected and split; one team's page is enough to read a game.

**Checking the numbers**
- Maths checks: quarter columns against points, per-quarter sums against the score box,
  running score against final, Q1+Q2 against the half score.
- A side that wasn't scanned isn't flagged. It shows "Waiting for scores", with a way to type the score in.
- The check screen and photo viewer have "See the whole page" for when a crop is too small to settle a value.
- With no date on the sheet, a game gets today's date (phone's calendar, not UTC).

**Scan flow:** photo first, then recognised / not sure / new scoresheet / retake.
Template building moved behind More › Advanced.

**Account and groups**
- More › Account: sign in (Apple on iPhone, Google), name, groups, sign out, delete account.
- Groups are joined by invite link: `https://<api>/join/<CODE>` shows the code and opens
  `inkstat://join/<CODE>` in the app. The page never looks the code up.

**Server**
- Template sharing: publish to a group, incremental group feed, browse. Shared templates keep printed
  vocabulary only, and template names are filtered (no people's names).
- Game matching between two scorekeepers' reports (parked, see Direction).

## Not finished / known issues

- The invite page and Account changes aren't deployed to the API yet.
- `api.inkstat.app` DNS isn't confirmed, and invite links are built from it.
- Glover's 1999 edition not yet checked against the built-in layout.
- Glover's team fouls and timeouts (women's/men's rows) aren't read.
- Halves (instead of quarters) aren't a template option yet.
- ✓ renders as √ in IBM Plex; replace with a drawn check icon.
- The Pixel_10_Pro emulator image (16 KB pages) shows a blank screen with the dev build; a standard x86_64 image is untested.

## Next: My team (`feat/my-team`)

Designs: the "My team" page of the design canvas.

- First run asks which team you keep the book for. Its name is free text and editable
  ("Beacon Hill JV Girls 2026").
- A team also has **names on the scoresheet** ("BEACON", "BH"), learned when you confirm a scan
  and used only to find your team on a page.
- After a scan: find your side by those names; ask "Which team is yours?" only when unsure; ask
  "What did they score?" only when the sheet has no opponent score.
- Home: record and streak, points for and against, Scan, your games (W/L), team leaders.
  Standings / Scores / Leaders tabs go.
- Home and away become a detail of the game. Opponent players stay with the game, out of your leaders.
- More than one team allowed (team switcher), designed for one.
