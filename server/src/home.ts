/**
 * What a browser sees at the API's root: the InkStat logo and nothing else.
 * The Viewfinder mark from src/ui/Logo.tsx, in the Scorebook Paper colors, light and dark.
 */

const mark = (size: number) => `<svg width="${size}" height="${size}" viewBox="0 0 72 72" aria-hidden="true">
  <g class="b" fill="none" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M6 22 L6 6 L22 6"/><path d="M50 6 L66 6 L66 22"/><path d="M6 50 L6 66 L22 66"/><path d="M66 50 L66 66 L50 66"/>
  </g>
  <g class="l" stroke-width="6" stroke-linecap="round">
    <path d="M20 28 L52 28"/><path d="M16 38 L56 38" opacity="0.65"/><path d="M24 48 L46 48" opacity="0.4"/>
  </g>
</svg>`;

export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">
  <style>.b{stroke:#22201C}.l{stroke:#2F5DA8}@media (prefers-color-scheme:dark){.b{stroke:#EFE8D8}.l{stroke:#8FB2EC}}</style>
  ${mark(72).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '')}
</svg>`;

export const HOME_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>InkStat</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  :root { --bg: #F7F3EA; --ink: #22201C; --line: #2F5DA8; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1A1814; --ink: #EFE8D8; --line: #8FB2EC; } }
  html, body { height: 100%; margin: 0; }
  body { background: var(--bg); display: flex; align-items: center; justify-content: center; }
  .logo { display: flex; align-items: center; gap: 22px; }
  .b { stroke: var(--ink); } .l { stroke: var(--line); }
  .word { font: 600 64px/1 'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif; color: var(--ink); letter-spacing: -1px; }
  .word span { color: var(--line); }
  @media (max-width: 480px) { .logo { gap: 14px; } .logo svg { width: 52px; height: 52px; } .word { font-size: 44px; } }
</style>
</head>
<body>
  <div class="logo" role="img" aria-label="InkStat">${mark(76)}<div class="word" aria-hidden="true">Ink<span>Stat</span></div></div>
</body>
</html>`;

/** Invite codes use this alphabet (no 0/O or 1/I/L); see groups.ts. */
export const INVITE_CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6,12}$/;

/**
 * What a shared invite link opens in a browser: the code, a button into the app, and
 * what to do without the app. It never looks the code up, so it says nothing about
 * whether a group exists or what it is called.
 */
export const joinHtml = (code: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Join a group on InkStat</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  :root { --bg: #F7F3EA; --ink: #22201C; --muted: #6B665C; --line: #2F5DA8; --on-line: #FFFFFF; --card: #FFFDF8; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1A1814; --ink: #EFE8D8; --muted: #A9A292; --line: #8FB2EC; --on-line: #14120E; --card: #23201B; } }
  html, body { margin: 0; }
  body { background: var(--bg); color: var(--ink); font: 400 17px/1.5 'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;
         min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px 16px; box-sizing: border-box; }
  main { width: 100%; max-width: 420px; display: flex; flex-direction: column; gap: 18px; }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 22px; }
  .brand span { color: var(--line); }
  .b { stroke: var(--ink); } .l { stroke: var(--line); }
  h1 { font-size: 26px; line-height: 1.2; margin: 0; }
  .code { background: var(--card); border: 1.5px solid var(--ink); border-radius: 8px; padding: 14px; text-align: center;
          font: 600 30px/1 'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace; letter-spacing: 4px; }
  a.open { display: block; text-align: center; background: var(--line); color: var(--on-line); text-decoration: none;
           font-weight: 600; padding: 14px; border-radius: 6px; }
  p { margin: 0; color: var(--muted); }
</style>
</head>
<body>
<main>
  <div class="brand">${mark(30)}<div>Ink<span>Stat</span></div></div>
  <h1>You’ve been invited to a group on InkStat</h1>
  <div class="code" aria-label="Invite code">${code}</div>
  <a class="open" href="inkstat://join/${code}">Open in InkStat</a>
  <p>Don’t have the app yet? Install InkStat, then go to More › Account › Join a group and enter the code above.</p>
</main>
</body>
</html>`;
