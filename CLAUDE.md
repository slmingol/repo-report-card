# Principal Skinner — Claude instructions

## Output format

When scoring a repo dossier, write a **standalone HTML file** to the local filesystem.
Never publish to claude.ai (no Artifact tool calls).

Default output path: `<repo-slug>-scorecard.html` in the current working directory.
Example: `fall-hackathon-2026-vibe-scorecard.html`

Overwrite silently if the file already exists.

## Report style

The HTML report must be a **full standalone page** (`<!doctype html>` through `</html>`).
It requires no server, CDN, or internet connection to open.

Weave in **Principal Skinner quips** throughout — one per dimension card, one in the
header, one in the CI/flags callout, one at the end. Voice: pompous mid-level bureaucrat,
backhanded compliments, deflated optimism, mild Vietnam non-sequiturs, mother references,
oblique self-pity. Never actually mean — just the sad confidence of a man who peaked at
assistant principal.

## Rubric

Apply the Technical Complexity Rubric from README.md exactly as written.
Score each dimension 1–5. Total out of 25. Cite specific files as evidence.

## Required HTML structure

Use **exactly** this structure and these class names. `skinner-render` extracts the
project name via `h1.project-name` and the score via `.total-score .big`. Quip images
are injected into empty `.skinner-wrap` divs at runtime — leave them empty.

### Head / CSS

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>REPO NAME Scorecard</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;1,9..40,300&family=JetBrains+Mono:wght@400;600&display=swap">
<style>
:root {
  --bg:        #F4F6FA;
  --surface:   #FFFFFF;
  --surface-2: #EDF0F7;
  --border:    #D8DDE8;
  --fg:        #0C1525;
  --fg-muted:  #566079;
  --fg-dim:    #8E97AA;
  --accent:    #0891B2;
  --score:     #D97706;
  --score-bg:  #FEF3C7;
  --bar-track: #D8DDE8;
  --max:       #059669;
  --max-bg:    #D1FAE5;
  --warn:      #B45309;
  --warn-bg:   #FFFBEB;
  --quip:      #7C3AED;
  --quip-bg:   #F5F3FF;
  --quip-bdr:  #C4B5FD;
  --r:         6px;
  --font-head: 'Outfit', system-ui, sans-serif;
  --font-body: 'DM Sans', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', 'Courier New', monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg:        #080E18;
    --surface:   #0F1826;
    --surface-2: #162035;
    --border:    #1F2E45;
    --fg:        #E4EAF5;
    --fg-muted:  #8897B4;
    --fg-dim:    #4A5A75;
    --accent:    #22D3EE;
    --score:     #FBBF24;
    --score-bg:  #1C1408;
    --bar-track: #1F2E45;
    --max:       #34D399;
    --max-bg:    #062316;
    --warn:      #F59E0B;
    --warn-bg:   #1A1200;
    --quip:      #A78BFA;
    --quip-bg:   #13102A;
    --quip-bdr:  #4C3D8A;
    color-scheme: dark;
  }
}
*, *::before, *::after { box-sizing: border-box; }
body {
  font-family: var(--font-body);
  font-size: 17px;
  line-height: 1.6;
  color: var(--fg);
  background: var(--bg);
  padding-inline: 20px;
  padding-block: 32px;
  max-width: 1200px;
  margin: 0 auto;
}
.header { padding-block-end: 24px; border-bottom: 1px solid var(--border); margin-block-end: 20px; }
.event-label { font-family: var(--font-mono); font-size: 11px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--accent); display: block; margin-block-end: 8px; }
.project-name { font-family: var(--font-head); font-size: clamp(22px,5vw,32px); font-weight: 800; line-height: 1.15; color: var(--fg); margin: 0 0 4px; }
.project-sub { font-size: 14px; color: var(--fg-muted); font-weight: 300; font-style: italic; margin: 0 0 12px; }
.meta-row { display: flex; flex-wrap: wrap; gap: 10px 20px; font-size: 13px; color: var(--fg-muted); }
.meta-row span::before { content: "· "; }
.meta-row span:first-child::before { content: ""; }
.quip { background: var(--quip-bg); border: 1px solid var(--quip-bdr); border-left: 3px solid var(--quip); border-radius: var(--r); padding: 16px; margin-block-end: 20px; display: flex; align-items: center; gap: 20px; }
.quip-right { flex: 1; display: flex; flex-direction: column; gap: 8px; justify-content: center; }
.quip-label { font-family: var(--font-mono); font-size: 10px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--quip); white-space: nowrap; }
.quip-text { font-size: 13px; font-style: italic; color: var(--fg-muted); line-height: 1.55; }
.skinner-wrap { flex-shrink: 0; line-height: 0; }
.skinner-img { height: 280px; width: auto; display: block; mix-blend-mode: screen; }
.quip-caption { font-family: var(--font-mono); font-size: 10px; color: var(--quip); opacity: .7; font-style: normal; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 8px; margin-block-end: 20px; }
.stat { background: var(--surface-2); border-radius: var(--r); padding: 12px 14px; text-align: center; }
.stat .num { font-family: var(--font-head); font-size: 22px; font-weight: 800; color: var(--fg); font-variant-numeric: tabular-nums; line-height: 1.2; }
.stat .lbl { font-size: 11px; color: var(--fg-dim); text-transform: uppercase; letter-spacing: .07em; font-weight: 500; margin-block-start: 2px; }
.score-hero { display: flex; align-items: center; gap: 24px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 20px 24px; margin-block-end: 24px; flex-wrap: wrap; }
.total-score { display: flex; align-items: baseline; gap: 4px; flex-shrink: 0; }
.total-score .big { font-family: var(--font-head); font-size: clamp(48px,10vw,68px); font-weight: 800; line-height: 1; color: var(--score); font-variant-numeric: tabular-nums; }
.total-score .denom { font-family: var(--font-mono); font-size: 20px; color: var(--fg-dim); }
.score-divider { width: 1px; height: 52px; background: var(--border); flex-shrink: 0; }
.score-breakdown { flex: 1; min-width: 180px; }
.score-breakdown .label { font-family: var(--font-head); font-size: 11px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--fg-muted); margin-block-end: 10px; }
.mini-bars { display: flex; flex-direction: column; gap: 5px; }
.mini-bar-row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.mini-bar-row .dim-abbr { font-family: var(--font-mono); font-size: 10px; width: 30px; flex-shrink: 0; text-transform: uppercase; letter-spacing: .05em; color: var(--fg-muted); }
.mini-bar-track { flex: 1; height: 5px; border-radius: 3px; background: var(--bar-track); overflow: hidden; }
.mini-bar-fill { height: 100%; border-radius: 3px; background: var(--max); }
.mini-bar-fill.partial { background: var(--score); }
.mini-bar-row .sc { font-family: var(--font-mono); font-size: 10px; width: 16px; text-align: right; font-variant-numeric: tabular-nums; color: var(--fg); }
.section-head { font-family: var(--font-head); font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--fg-muted); margin: 0 0 12px; }
.dimensions { display: flex; flex-direction: column; gap: 12px; margin-block-end: 20px; }
.dim-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r); padding: 16px 18px; }
.dim-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-block-end: 10px; flex-wrap: wrap; }
.dim-name { font-family: var(--font-head); font-size: 15px; font-weight: 700; color: var(--fg); flex: 1; min-width: 0; }
.dim-name small { display: block; font-family: var(--font-body); font-size: 12px; font-weight: 300; color: var(--fg-muted); margin-block-start: 1px; }
.score-pill { font-family: var(--font-mono); font-size: 13px; font-weight: 600; padding: 3px 10px; border-radius: 20px; flex-shrink: 0; font-variant-numeric: tabular-nums; }
.score-pill.max  { background: var(--max-bg);   color: var(--max); }
.score-pill.near { background: var(--score-bg); color: var(--score); }
.score-bar-track { height: 5px; border-radius: 3px; background: var(--bar-track); overflow: hidden; margin-block-end: 12px; }
.score-bar-fill { height: 100%; border-radius: 3px; }
.evidence { font-size: 13px; color: var(--fg-muted); font-weight: 300; line-height: 1.55; margin-block-end: 10px; }
.evidence code { font-family: var(--font-mono); font-size: 11px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 3px; padding: 1px 5px; color: var(--accent); white-space: nowrap; }
.callout { display: flex; gap: 12px; background: var(--warn-bg); border: 1px solid var(--border); border-left: 3px solid var(--warn); border-radius: var(--r); padding: 14px 16px; margin-block-end: 20px; }
.callout-body { font-size: 13px; color: var(--fg-muted); font-weight: 300; line-height: 1.55; }
.callout-body strong { font-weight: 600; color: var(--fg); }
.badges { display: flex; flex-wrap: wrap; gap: 8px; margin-block-end: 24px; }
.badge { display: inline-flex; align-items: center; gap: 5px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 20px; padding: 3px 10px; font-size: 11px; font-family: var(--font-mono); color: var(--fg-muted); }
.badge.green { color: var(--max); background: var(--max-bg); border-color: transparent; }
.badge.grey  { color: var(--fg-dim); }
footer { border-top: 1px solid var(--border); padding-block-start: 16px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 12px; color: var(--fg-dim); font-family: var(--font-mono); }
</style>
</head>
```

### Body skeleton

```html
<body>

<header class="header">
  <span class="event-label">EVENT NAME · Hackathon YEAR</span>
  <h1 class="project-name">PROJECT NAME</h1>
  <p class="project-sub">One-line description from metadata</p>
  <div class="meta-row">
    <span>Contributor names</span>
    <span>Date range · ~N hours</span>
    <span>owner/repo · visibility</span>
  </div>
</header>

<!-- Opening Skinner quip — REQUIRED, leave skinner-wrap empty -->
<div class="quip">
  <span class="quip-label">Skinner</span>
  <div>
    <span class="quip-text">OPENING QUIP IN CHARACTER</span>
    <div class="skinner-wrap"></div>
    <div class="quip-caption skinner-ep"></div>
  </div>
</div>

<!-- Stats strip — fill from dossier activity/inventory -->
<div class="stats">
  <div class="stat"><div class="num">N</div><div class="lbl">Commits</div></div>
  <div class="stat"><div class="num">N</div><div class="lbl">Files</div></div>
  <div class="stat"><div class="num">N</div><div class="lbl">Contributors</div></div>
  <div class="stat"><div class="num">NM</div><div class="lbl">Bytes</div></div>
  <div class="stat"><div class="num">N+</div><div class="lbl">Test files</div></div>
</div>

<!-- Score hero — .big MUST contain only the integer score (skinner-render extracts it) -->
<div class="score-hero">
  <div class="total-score">
    <span class="big">SCORE</span>
    <span class="denom">/ 25</span>
  </div>
  <div class="score-divider"></div>
  <div class="score-breakdown">
    <div class="label">Dimension breakdown</div>
    <div class="mini-bars">
      <!-- one row per dimension; use class="mini-bar-fill" for 5/5, "mini-bar-fill partial" for <5 -->
      <div class="mini-bar-row">
        <span class="dim-abbr">Arch</span>
        <div class="mini-bar-track"><div class="mini-bar-fill" style="width:100%"></div></div>
        <span class="sc">5</span>
      </div>
      <!-- repeat for Intg, Prob, Scop, Rigor -->
    </div>
  </div>
  <!-- Optional fork/window note inline here -->
</div>

<!-- Dimension cards -->
<p class="section-head">Dimension scores</p>
<div class="dimensions">

  <div class="dim-card">
    <div class="dim-top">
      <div class="dim-name">
        DIMENSION NAME
        <small>What it measures</small>
      </div>
      <!-- use class="score-pill max" for 5, "score-pill near" for 3-4, "score-pill low" for 1-2 -->
      <span class="score-pill max">5 / 5</span>
    </div>
    <div class="score-bar-track">
      <!-- width: score/5 * 100%; background var(--max) for 5, var(--score) for partial -->
      <div class="score-bar-fill" style="width:100%; background:var(--max)"></div>
    </div>
    <div class="evidence">
      Evidence text. Use <code>file/paths</code> inline.
    </div>
    <!-- Per-dimension Skinner quip — REQUIRED -->
    <div class="quip">
      <span class="quip-label">Skinner</span>
      <div>
        <span class="quip-text">DIMENSION QUIP</span>
        <div class="skinner-wrap"></div>
        <div class="quip-caption skinner-ep"></div>
      </div>
    </div>
  </div>

  <!-- repeat dim-card for each of the 5 dimensions -->

</div>

<!-- CI/flags callout if has_ci:false or other issues -->
<div class="callout">
  <div class="callout-body">
    <strong>Issue title.</strong> Explanation with <code>signal</code> inline.
    Skinner quip about this here.
  </div>
</div>

<!-- Signal badges -->
<div class="badges">
  <span class="badge green">Has tests</span>
  <span class="badge green">Has Docker</span>
  <span class="badge grey">No CI</span>
  <!-- add/remove based on dossier signals -->
</div>

<!-- Closing Skinner quip — REQUIRED -->
<div class="quip">
  <span class="quip-label">Skinner</span>
  <div>
    <span class="quip-text">CLOSING VERDICT QUIP — include final grade, parting remark about standards, one moment of self-reflection.</span>
    <div class="skinner-wrap"></div>
    <div class="quip-caption skinner-ep"></div>
  </div>
</div>

<footer>
  <span>EVENT · Hackathon YEAR · Technical Complexity Rubric</span>
  <span>Scored YYYY-MM-DD · N files sampled of M eligible</span>
</footer>

</body>
</html>
```

## Critical class names (do not rename)

| Element | Required class | Used by |
|---|---|---|
| Project title `<h1>` | `project-name` | skinner-render sidebar extraction |
| Score integer `<span>` | `big` inside `.total-score` | skinner-render score extraction |
| Quip image slot `<div>` | `skinner-wrap` (empty) | runtime image injection |
| Quip text `<span>` | `quip-text` | quip restructuring JS |
| Quip label `<span>` | `quip-label` | quip restructuring JS |
