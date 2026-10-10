#!/usr/bin/env node
/**
 * skinner-render — combine per-repo score JSON files into one HTML with sidebar
 *
 * Usage:
 *   skinner-render [*.score.json ...]   stitch JSON score files (new format)
 *   skinner-render [*.html ...]         stitch legacy HTML scorecards
 *   skinner-render --score [--since DATE] owner/repo ...   score + stitch
 *
 * Output: HTML to stdout.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const MAX_BUFFER = 64 * 1024 * 1024;
const IMGS_DIR = path.resolve(__dirname, '../imgs/cropped');
const README_PATH = path.resolve(__dirname, '../README.md');
const CLI_PATH = path.resolve(__dirname, 'cli.js');

// ── Types ────────────────────────────────────────────────────────────────────

interface Dimension {
    name: string;
    subtitle: string;
    score: number;
    evidence: string;
    quip: string;
}

interface ScoreData {
    repo: string;
    event: string;
    project_name: string;
    description: string;
    contributors: string[];
    dates: string;
    hours: string;
    total_score: number;
    opening_quip: string;
    dimensions: Dimension[];
    stats: {
        commits: number;
        files: number;
        contributors: number;
        bytes: string;
        test_files: string;
    };
    signals: {
        has_tests: boolean;
        has_ci: boolean;
        has_docker: boolean;
        is_fork: boolean;
    };
    ci_note: string | null;
    ci_quip: string | null;
    closing_quip: string;
    scored_at: string;
    files_sampled: number;
    eligible_files: number;
}

interface Section {
    slug: string;
    name: string;
    score: number;
    grade: string;
    body: string;   // full HTML for iframe srcdoc
    tldr: string;
    stats: Record<string, string>;
    event: string;
}

interface Args {
    score: boolean;
    since: string | null;
    budget: number;
    inputs: string[];
}

// ── Arg parsing ───────────────────────────────────────────────────────────────

class UsageError extends Error {}

const USAGE = `Usage: skinner-render [--score [--since YYYY-MM-DD] [--budget N]] <inputs...>

Inputs can be:
  file.score.json         stitch a JSON score file (new format)
  existing.html           stitch a legacy HTML scorecard
  owner/repo              score this repo first (requires --score)

Options:
  --score              score owner/repo inputs via principal-skinner + claude
  --since YYYY-MM-DD   passed to principal-skinner for each repo
  --budget N           char budget per repo (default 80000)
  -h, --help           show this help

Output: combined HTML to stdout.`;

function parseArgs(argv: string[]): Args {
    let score = false;
    let since: string | null = null;
    let budget = 80_000;
    const inputs: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help') { process.stdout.write(USAGE + '\n'); process.exit(0); }
        if (a === '--score') { score = true; continue; }
        if (a === '--since') {
            const v = argv[++i];
            if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new UsageError(`--since requires YYYY-MM-DD, got: ${v ?? ''}`);
            since = v; continue;
        }
        if (a === '--budget') {
            const v = argv[++i];
            if (!v || !/^\d+$/.test(v)) throw new UsageError(`--budget requires a number`);
            budget = Number(v); continue;
        }
        if (a.startsWith('-')) throw new UsageError(`unknown option: ${a}`);
        inputs.push(a);
    }

    if (!inputs.length) throw new UsageError('no inputs given');
    return { score, since, budget, inputs };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function markdownInline(s: string): string {
    return s
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code style="font-family:monospace;font-size:.88em">$1</code>');
}

function rubricToHtml(md: string): string {
    const lines = md.split('\n');
    let out = '';
    let inTable = false;
    let tableRows = '';
    let headerSeen = false;

    const flushTable = () => {
        if (inTable) { out += `<table class="rubric-table">${tableRows}</tbody></table>`; inTable = false; tableRows = ''; headerSeen = false; }
    };

    for (const line of lines) {
        const t = line.trim();
        if (!t) { flushTable(); continue; }
        if (t.startsWith('## ')) { flushTable(); out += `<p class="rubric-section-head">${markdownInline(t.slice(3))}</p>`; continue; }
        if (t.startsWith('- ') || t.startsWith('* ')) { flushTable(); out += `<p class="rubric-p">${markdownInline(t.slice(2))}</p>`; continue; }
        if (t.startsWith('**') || (/^[A-Z]/.test(t) && !t.startsWith('|'))) { flushTable(); out += `<p class="rubric-p">${markdownInline(t)}</p>`; continue; }
        if (t.startsWith('|')) {
            const cells = t.split('|').slice(1, -1).map(c => c.trim());
            if (cells.every(c => /^-+$/.test(c))) { tableRows += '</thead><tbody>'; headerSeen = true; continue; }
            if (!inTable) { inTable = true; tableRows = '<thead>'; }
            const tag = headerSeen ? 'td' : 'th';
            tableRows += `<tr>${cells.map(c => `<${tag}>${markdownInline(c)}</${tag}>`).join('')}</tr>`;
            continue;
        }
        flushTable();
        out += `<p class="rubric-p">${markdownInline(t)}</p>`;
    }
    flushTable();
    return out;
}

function gradeFromScore(n: number): string {
    if (n >= 62) return 'A';
    if (n >= 52) return 'B';
    if (n >= 42) return 'C';
    if (n >= 32) return 'D';
    return 'F';
}

function slugify(s: string, idx: number): string {
    return `team-${idx}-${s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}`;
}

function escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function run(cmd: string, args: string[], opts: { input?: string; cwd?: string } = {}): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = execFile(cmd, args, {
            maxBuffer: MAX_BUFFER,
            timeout: 300_000,
            cwd: opts.cwd,
            env: { ...process.env, NO_COLOR: '1' },
        }, (err, stdout, stderr) => {
            if (!err) return resolve(stdout);
            const e = err as NodeJS.ErrnoException & { killed?: boolean };
            if (e.code === 'ENOENT') return reject(new Error(`'${cmd}' not found on PATH`));
            if (e.killed) return reject(new Error(`'${cmd}' timed out`));
            reject(new Error(String(stderr || e.message).trim().split('\n').slice(-3).join(' | ')));
        });
        if (opts.input !== undefined && child.stdin) {
            child.stdin.write(opts.input);
            child.stdin.end();
        }
    });
}

function readRubric(): string {
    try {
        const md = fs.readFileSync(README_PATH, 'utf-8');
        const idx = md.indexOf('## Technical Complexity Rubric');
        return idx === -1 ? md : md.slice(idx);
    } catch {
        throw new Error(`README.md not found at ${README_PATH}`);
    }
}

function loadSkinnerImages(): string[] {
    try {
        return fs.readdirSync(IMGS_DIR)
            .filter(f => f.toLowerCase().endsWith('.png'))
            .sort()
            .map(f => {
                const data = fs.readFileSync(path.join(IMGS_DIR, f));
                return `data:image/png;base64,${data.toString('base64')}`;
            });
    } catch {
        return [];
    }
}

function pickImg(imgs: string[]): string {
    return imgs.length ? imgs[Math.floor(Math.random() * imgs.length)] : '';
}

// ── Scorecard CSS (single source of truth for rendering) ──────────────────────

const SCORECARD_CSS = `
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
  font-size: 21px;
  line-height: 1.6;
  color: var(--fg);
  background: var(--bg);
  padding-inline: 20px;
  padding-block: 32px;
  max-width: 1200px;
  margin: 0 auto;
}
.header { background: var(--surface); border: 1px solid var(--border); border-top: 3px solid var(--accent); border-radius: 10px; padding: 24px 28px 20px; margin-block-end: 20px; }
.event-label { font-family: var(--font-mono); font-size: 11px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--accent); display: inline-block; background: color-mix(in srgb, var(--accent) 12%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 28%, transparent); border-radius: 20px; padding: 3px 12px; margin-block-end: 14px; }
.project-name { font-family: var(--font-head); font-size: clamp(28px,6vw,46px); font-weight: 800; line-height: 1.1; color: var(--fg); margin: 0 0 6px; }
.project-sub { font-size: 19px; color: var(--fg); font-weight: 400; font-style: italic; margin: 0 0 16px; line-height: 1.5; padding-left: 14px; border-left: 3px solid var(--accent); opacity: .85; }
.meta-table { display: grid; grid-template-columns: auto 1fr; gap: 0; font-size: 15px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r); overflow: hidden; }
.meta-row-pair { display: contents; }
.meta-lbl { font-family: var(--font-mono); font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--fg-dim); white-space: nowrap; padding: 8px 14px; border-bottom: 1px solid var(--border); border-right: 1px solid var(--border); background: var(--surface); }
.meta-val { color: var(--fg-muted); line-height: 1.5; padding: 8px 14px; border-bottom: 1px solid var(--border); font-size: 15px; }
.meta-table > span:nth-last-child(-n+2) { border-bottom: none; }
.meta-val a { color: var(--accent); text-decoration: none; font-weight: 500; }
.meta-val a:hover { text-decoration: underline; }
.meta-tag { display: inline-block; font-family: var(--font-mono); font-size: 10px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 4px; padding: 1px 7px; color: var(--fg-dim); margin-inline-start: 8px; vertical-align: middle; letter-spacing: .04em; }
.quip { background: var(--quip-bg); border: 1px solid var(--quip-bdr); border-left: 3px solid var(--quip); border-radius: var(--r); padding: 16px; margin-block-end: 20px; display: flex; align-items: center; gap: 20px; }
.quip-right { flex: 1; display: flex; flex-direction: column; gap: 8px; justify-content: center; }
.quip-label { font-family: var(--font-mono); font-size: 10px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--quip); white-space: nowrap; }
.quip-text { font-size: 19px; font-style: italic; color: var(--fg-muted); line-height: 1.55; }
.skinner-wrap { flex-shrink: 0; line-height: 0; }
.skinner-img { height: 280px; width: auto; display: block; mix-blend-mode: screen; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 8px; margin-block-end: 20px; }
.stat { background: var(--surface-2); border-radius: var(--r); padding: 12px 14px; text-align: center; }
.stat .num { font-family: var(--font-head); font-size: 22px; font-weight: 800; color: var(--fg); font-variant-numeric: tabular-nums; line-height: 1.2; }
.stat .lbl { font-size: 15px; color: var(--fg-dim); text-transform: uppercase; letter-spacing: .07em; font-weight: 500; margin-block-start: 2px; }
.score-hero { display: flex; align-items: center; gap: 24px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 20px 24px; margin-block-end: 24px; flex-wrap: wrap; }
.total-score { display: flex; align-items: baseline; gap: 4px; flex-shrink: 0; }
.total-score .big { font-family: var(--font-head); font-size: clamp(48px,10vw,68px); font-weight: 800; line-height: 1; color: var(--score); font-variant-numeric: tabular-nums; }
.total-score .denom { font-family: var(--font-mono); font-size: 20px; color: var(--fg-dim); }
.score-divider { width: 1px; height: 52px; background: var(--border); flex-shrink: 0; }
.score-breakdown { flex: 1; min-width: 180px; }
.score-breakdown .label { font-family: var(--font-head); font-size: 15px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--fg-muted); margin-block-end: 10px; }
.mini-bars { display: flex; flex-direction: column; gap: 5px; }
.mini-bar-row { display: flex; align-items: center; gap: 8px; font-size: 16px; }
.mini-bar-row .dim-abbr { font-family: var(--font-mono); font-size: 10px; width: 30px; flex-shrink: 0; text-transform: uppercase; letter-spacing: .05em; color: var(--fg-muted); }
.mini-bar-track { flex: 1; height: 5px; border-radius: 3px; background: var(--bar-track); overflow: hidden; }
.mini-bar-fill { height: 100%; border-radius: 3px; background: var(--max); }
.mini-bar-fill.partial { background: var(--score); }
.mini-bar-row .sc { font-family: var(--font-mono); font-size: 10px; width: 16px; text-align: right; font-variant-numeric: tabular-nums; color: var(--fg); }
.section-head { font-family: var(--font-head); font-size: 15px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--fg-muted); margin: 0 0 12px; }
.dimensions { display: flex; flex-direction: column; gap: 12px; margin-block-end: 20px; }
.dim-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r); padding: 16px 18px; }
.dim-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-block-end: 10px; flex-wrap: wrap; }
.dim-name { font-family: var(--font-head); font-size: 19px; font-weight: 700; color: var(--fg); flex: 1; min-width: 0; }
.dim-name small { display: block; font-family: var(--font-body); font-size: 16px; font-weight: 300; color: var(--fg-muted); margin-block-start: 1px; }
.score-pill { font-family: var(--font-mono); font-size: 19px; font-weight: 600; padding: 3px 10px; border-radius: 20px; flex-shrink: 0; font-variant-numeric: tabular-nums; }
.score-pill.max  { background: var(--max-bg);   color: var(--max); }
.score-pill.near { background: var(--score-bg); color: var(--score); }
.score-bar-track { height: 5px; border-radius: 3px; background: var(--bar-track); overflow: hidden; margin-block-end: 12px; }
.score-bar-fill { height: 100%; border-radius: 3px; }
.evidence { font-size: 19px; color: var(--fg-muted); font-weight: 300; line-height: 1.55; margin-block-end: 10px; }
.evidence code { font-family: var(--font-mono); font-size: 15px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 3px; padding: 1px 5px; color: var(--accent); white-space: nowrap; }
.callout { display: flex; gap: 12px; background: var(--warn-bg); border: 1px solid var(--border); border-left: 3px solid var(--warn); border-radius: var(--r); padding: 14px 16px; margin-block-end: 20px; }
.callout-body { font-size: 19px; color: var(--fg-muted); font-weight: 300; line-height: 1.55; }
.callout-body strong { font-weight: 600; color: var(--fg); }
.badges { display: flex; flex-wrap: wrap; gap: 8px; margin-block-end: 24px; }
.badge { display: inline-flex; align-items: center; gap: 5px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 20px; padding: 3px 10px; font-size: 15px; font-family: var(--font-mono); color: var(--fg-muted); }
.badge.green { color: var(--max); background: var(--max-bg); border-color: transparent; }
.badge.grey  { color: var(--fg-dim); }
footer { border-top: 1px solid var(--border); padding-block-start: 16px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 16px; color: var(--fg-dim); font-family: var(--font-mono); }
`;

// ── Scorecard HTML renderer (from JSON) ───────────────────────────────────────

const DIM_ABBR: Record<string, string> = {
    'Architecture': 'Arch', 'Integrations': 'Intg', 'Problem Difficulty': 'Prob',
    'Scope Delivered': 'Scop', 'Engineering Rigor': 'Rigor',
    'Innovation': 'Innov', 'Operational Readiness': 'Ops',
};

function quipBlock(text: string, imgSrc: string): string {
    const imgTag = imgSrc
        ? `<img class="skinner-img" src="${imgSrc}" alt="Principal Skinner">`
        : '';
    return `<div class="quip">
  <div class="skinner-wrap">${imgTag}</div>
  <div class="quip-right">
    <span class="quip-label">Skinner</span>
    <span class="quip-text">${escHtml(text)}</span>
  </div>
</div>`;
}

function renderScorecardHtml(data: ScoreData, imgs: string[]): string {
    const repoUrl = `https://github.com/${data.repo}`;
    const pillClass = (s: number) => s === 10 ? 'max' : 'near';
    const barBg = (s: number) => s === 10 ? 'var(--max)' : 'var(--score)';
    const barW = (s: number) => `${(s / 10) * 100}%`;
    const fillClass = (s: number) => s === 10 ? 'mini-bar-fill' : 'mini-bar-fill partial';

    const miniBars = (data.dimensions ?? []).map(d => `
      <div class="mini-bar-row">
        <span class="dim-abbr">${escHtml(DIM_ABBR[d.name] ?? d.name.slice(0, 4))}</span>
        <div class="mini-bar-track"><div class="${fillClass(d.score)}" style="width:${barW(d.score)}"></div></div>
        <span class="sc">${d.score}</span>
      </div>`).join('');

    const dimCards = (data.dimensions ?? []).map(d => `
  <div class="dim-card">
    <div class="dim-top">
      <div class="dim-name">${escHtml(d.name)}<small>${escHtml(d.subtitle)}</small></div>
      <span class="score-pill ${pillClass(d.score)}">${d.score} / 10</span>
    </div>
    <div class="score-bar-track">
      <div class="score-bar-fill" style="width:${barW(d.score)};background:${barBg(d.score)}"></div>
    </div>
    <div class="evidence">${escHtml(d.evidence)}</div>
    ${quipBlock(d.quip, pickImg(imgs))}
  </div>`).join('');

    const badges = [
        data.signals?.has_tests  ? `<span class="badge green">Has tests</span>`  : `<span class="badge grey">No tests</span>`,
        data.signals?.has_ci     ? `<span class="badge green">CI</span>`          : `<span class="badge grey">No CI</span>`,
        data.signals?.has_docker ? `<span class="badge green">Docker</span>`      : '',
        data.signals?.is_fork    ? `<span class="badge grey">Fork</span>`         : '',
    ].filter(Boolean).join('\n  ');

    const ciCallout = (!data.signals?.has_ci && data.ci_note)
        ? `<div class="callout">
  <div class="callout-body">
    <strong>No CI pipeline.</strong> ${escHtml(data.ci_note)}
    ${data.ci_quip ? `<br><em>${escHtml(data.ci_quip)}</em>` : ''}
  </div>
</div>`
        : '';

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(data.project_name)} Scorecard</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;1,9..40,300&family=JetBrains+Mono:wght@400;600&display=swap">
<style>${SCORECARD_CSS}</style>
</head>
<body>

<header class="header">
  <span class="event-label">${escHtml(data.event)}</span>
  <h1 class="project-name">${escHtml(data.project_name)}</h1>
  <p class="project-sub">${escHtml(data.description)}</p>
  <div class="meta-table">
    ${(data.contributors ?? []).length ? `<span class="meta-lbl">Team</span><span class="meta-val">${escHtml((data.contributors ?? []).join(' · '))}</span>` : ''}
    <span class="meta-lbl">Window</span><span class="meta-val">${escHtml(data.dates)} &nbsp;·&nbsp; ${escHtml(data.hours)}</span>
    <span class="meta-lbl">Repo</span><span class="meta-val"><a href="${escHtml(repoUrl)}" target="_blank" rel="noopener">${escHtml(data.repo)}</a><span class="meta-tag">${data.signals?.is_fork ? 'fork' : 'private'}</span></span>
  </div>
</header>

${quipBlock(data.opening_quip, pickImg(imgs))}

<div class="stats">
  <div class="stat"><div class="num">${data.stats?.commits ?? '—'}</div><div class="lbl">Commits</div></div>
  <div class="stat"><div class="num">${data.stats?.files ?? '—'}</div><div class="lbl">Files</div></div>
  <div class="stat"><div class="num">${data.stats?.contributors ?? '—'}</div><div class="lbl">Contributors</div></div>
  <div class="stat"><div class="num">${escHtml(String(data.stats?.bytes ?? '—'))}</div><div class="lbl">Source</div></div>
  <div class="stat"><div class="num">${escHtml(String(data.stats?.test_files ?? '—'))}</div><div class="lbl">Test Files</div></div>
</div>

<div class="score-hero">
  <div class="total-score">
    <span class="big">${data.total_score}</span>
    <span class="denom">/ 70</span>
  </div>
  <div class="score-divider"></div>
  <div class="score-breakdown">
    <div class="label">Dimension Breakdown</div>
    <div class="mini-bars">${miniBars}
    </div>
  </div>
</div>

<p class="section-head">Dimension scores</p>
<div class="dimensions">
${dimCards}
</div>

${ciCallout}

<div class="badges">
  ${badges}
</div>

${quipBlock(data.closing_quip, pickImg(imgs))}

<footer>
  <span>${escHtml(data.event)} · Technical Complexity Rubric</span>
  <span>Scored ${escHtml(data.scored_at)} · ${data.files_sampled} files sampled of ${data.eligible_files} eligible</span>
</footer>

</body>
</html>`;
}

// ── JSON → Section ────────────────────────────────────────────────────────────

function fromJson(data: ScoreData, idx: number, imgs: string[]): Section {
    const name = data.project_name || `Team ${idx + 1}`;
    const score = data.total_score ?? 0;
    const stats: Record<string, string> = {
        commits:      String(data.stats?.commits ?? ''),
        files:        String(data.stats?.files ?? ''),
        contributors: String(data.stats?.contributors ?? ''),
        bytes:        String(data.stats?.bytes ?? ''),
        'test files': String(data.stats?.test_files ?? ''),
    };
    return {
        slug:  slugify(name, idx),
        name,
        score,
        grade: gradeFromScore(score),
        body:  renderScorecardHtml(data, imgs),
        tldr:  data.opening_quip ?? '',
        stats,
        event: data.event ?? '',
    };
}

// ── Legacy HTML extraction ────────────────────────────────────────────────────

function extractSection(html: string, idx: number): Section {
    const nameMatch =
        html.match(/<h1[^>]*class="project-name"[^>]*>([\s\S]*?)<\/h1>/i) ||
        html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const name = nameMatch ? nameMatch[1].replace(/<[^>]+>/g, '').trim() : `Team ${idx + 1}`;

    const scoreMatch =
        html.match(/<span[^>]*class="big"[^>]*>(\d+)<\/span>/i) ||
        html.match(/<span[^>]*class="num"[^>]*>(\d+)<\/span>/i) ||
        html.match(/>\s*(\d+)\s*<[^>]*>\s*\/\s*(?:25|70)/);
    const score = scoreMatch ? parseInt(scoreMatch[1]) : 0;

    const quipMatch = html.match(/<span[^>]*class="quip-text"[^>]*>([\s\S]*?)<\/span>/i);
    const tldr = quipMatch ? quipMatch[1].replace(/<[^>]+>/g, '').trim() : '';

    const statNums = [...html.matchAll(/<div class="num">([^<]+)<\/div>/gi)].map(m => m[1].trim());
    const statLbls = [...html.matchAll(/<div class="lbl">([^<]+)<\/div>/gi)].map(m => m[1].trim());
    const stats: Record<string, string> = {};
    statLbls.forEach((lbl, i) => { if (statNums[i]) stats[lbl.toLowerCase()] = statNums[i]; });

    const eventMatch = html.match(/<span[^>]*class="event-label"[^>]*>([\s\S]*?)<\/span>/i);
    const event = eventMatch ? eventMatch[1].replace(/<[^>]+>/g, '').trim() : '';

    return { slug: slugify(name, idx), name, score, grade: gradeFromScore(score), body: html, tldr, stats, event };
}

// ── Scoring ───────────────────────────────────────────────────────────────────

async function scoreRepo(repoArg: string, since: string | null, budget: number, imgs: string[]): Promise<Section> {
    process.stderr.write(`[skinner-render] scoring ${repoArg}...\n`);
    const skinnerArgs = [CLI_PATH, repoArg];
    if (since) skinnerArgs.push('--since', since);
    skinnerArgs.push('--budget', String(budget));
    const dossierJson = await run(process.argv[0], skinnerArgs);

    const rubric = readRubric();
    const json = await run('claude', ['-p', rubric, '--allowedTools', ''], { input: dossierJson });

    process.stderr.write(`[skinner-render] scored ${repoArg}\n`);

    try {
        const jsonStr = json.includes('{') ? json.slice(json.indexOf('{'), json.lastIndexOf('}') + 1) : json;
        const data: ScoreData = JSON.parse(jsonStr);
        return fromJson(data, 0, imgs);
    } catch {
        // fallback: treat as HTML
        return extractSection(json, 0);
    }
}

// ── HTML generation ───────────────────────────────────────────────────────────

const GRADE_COLOR: Record<string, string> = {
    A: '#059669', B: '#0891B2', C: '#D97706', D: '#EA580C', F: '#DC2626',
};
const GRADE_BG: Record<string, string> = {
    A: '#D1FAE5', B: '#CFFAFE', C: '#FEF3C7', D: '#FFEDD5', F: '#FEE2E2',
};

function injectSkinnerScript(html: string, imgs: string[]): string {
    const js = `<script>
(function(){
  var imgs=${JSON.stringify(imgs)};
  function go(){
    if(imgs.length){
      document.querySelectorAll('.skinner-wrap').forEach(function(w){
        if(w.querySelector('img'))return;
        var img=document.createElement('img');
        img.className='skinner-img';img.alt='Principal Skinner';
        img.src=imgs[Math.floor(Math.random()*imgs.length)];
        w.appendChild(img);
      });
    }
    document.querySelectorAll('.quip').forEach(function(q){
      var lbl=q.querySelector('.quip-label'),txt=q.querySelector('.quip-text'),
          cap=q.querySelector('.quip-caption'),wrap=q.querySelector('.skinner-wrap');
      if(!lbl||!txt||!wrap)return;
      var r=document.createElement('div');r.className='quip-right';
      r.appendChild(lbl);r.appendChild(txt);if(cap)r.appendChild(cap);
      q.innerHTML='';q.appendChild(wrap);q.appendChild(r);
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',go);
  else go();
})();
<\/script>`;
    return html.replace(/<\/body>/i, js + '</body>');
}

function buildCombinedHtml(sections: Section[], skinnerImgs: string[], rubric: string): string {
    const sidebarItems = sections.map(s => {
        const color = GRADE_COLOR[s.grade] ?? '#566079';
        const bg = GRADE_BG[s.grade] ?? '#F1F5F9';
        return `<a class="team-item" href="#${s.slug}" data-name="${s.name.toLowerCase()}">
  <span class="team-name">${escHtml(s.name)}</span>
  <span class="team-badges">
    <span class="grade-pill" style="background:${bg};color:${color}">${s.grade}</span>
    <span class="score-num">${s.score}<span class="denom">/70</span></span>
  </span>
</a>`;
    }).join('\n');

    const contentSections = sections.map(s => {
        // JSON-rendered sections already have images embedded; inject script only for legacy HTML
        const bodyHtml = s.body.includes('class="skinner-img"')
            ? s.body
            : injectSkinnerScript(s.body, skinnerImgs);
        const srcdoc = bodyHtml.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        return `
<section id="${s.slug}" class="team-section">
  <iframe class="scorecard-frame" srcdoc="${srcdoc}"
    title="${escHtml(s.name)}" scrolling="no" frameborder="0"></iframe>
</section>`;
    }).join('\n');

    const overviewCards = sections.map(s => {
        const color = GRADE_COLOR[s.grade] ?? '#566079';
        const bg    = GRADE_BG[s.grade]    ?? '#F1F5F9';
        const statKeys = ['commits', 'files', 'contributors', 'bytes', 'test files'];
        const statsHtml = statKeys.map(k => {
            const v = s.stats[k] || s.stats[k.replace(' ', '')] || '—';
            return `<div class="ov-stat"><div class="ov-stat-num">${escHtml(v)}</div><div class="ov-stat-lbl">${escHtml(k)}</div></div>`;
        }).join('');
        const tldr = s.tldr ? `<p class="ov-tldr">${escHtml(s.tldr.slice(0, 220))}${s.tldr.length > 220 ? '…' : ''}</p>` : '';
        return `<a class="ov-card" href="#${s.slug}" data-name="${s.name.toLowerCase()}">
  <div class="ov-card-head">
    <span class="ov-name">${escHtml(s.name)}</span>
    <span class="ov-grade" style="background:${bg};color:${color}">${s.grade} · ${s.score}/70</span>
  </div>
  <div class="ov-stats">${statsHtml}</div>
  ${tldr}
</a>`;
    }).join('\n');

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Repo Report Card — Hackathon Scorecards (${sections.length} teams)</title>
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
  --sidebar-w: 280px;
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
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body {
  font-family: var(--font-body);
  font-size: 15px;
  line-height: 1.6;
  color: var(--fg);
  background: var(--bg);
  display: flex;
}
.sidebar {
  position: fixed;
  top: 0; left: 0; bottom: 0;
  width: var(--sidebar-w);
  background: var(--surface);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  z-index: 100;
  overflow: hidden;
}
.sidebar-event { font-family: var(--font-mono); font-size: 9px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--accent); margin-block-end: 2px; }
.sidebar-head { padding: 16px 14px 10px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.sidebar-title { font-family: var(--font-head); font-size: 13px; font-weight: 700; color: var(--fg); letter-spacing: .02em; margin-block-end: 8px; }
.sidebar-count { font-family: var(--font-mono); font-size: 10px; color: var(--fg-dim); letter-spacing: .06em; text-transform: uppercase; margin-block-end: 8px; }
.search { width: 100%; padding: 6px 10px; font-family: var(--font-body); font-size: 13px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r); color: var(--fg); outline: none; }
.search:focus { border-color: var(--accent); }
.search::placeholder { color: var(--fg-dim); }
.team-list { overflow-y: auto; flex: 1; padding: 6px 0; }
.team-item { display: flex; align-items: center; gap: 8px; padding: 9px 14px; text-decoration: none; color: var(--fg); border-left: 3px solid transparent; transition: background .1s, border-color .1s; cursor: pointer; }
.team-item:hover, .team-item.active { background: var(--surface-2); border-left-color: var(--accent); }
.team-name { flex: 1; font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--fg); }
.team-badges { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.grade-pill { font-family: var(--font-head); font-size: 11px; font-weight: 700; padding: 1px 6px; border-radius: 4px; line-height: 1.5; }
.score-num { font-family: var(--font-mono); font-size: 11px; font-weight: 600; color: var(--score); white-space: nowrap; }
.score-num .denom { color: var(--fg-dim); font-weight: 400; }
.no-match { padding: 20px 14px; font-size: 13px; color: var(--fg-dim); display: none; }
.content { margin-left: var(--sidebar-w); flex: 1; min-width: 0; }
.team-section { border-bottom: 3px solid var(--border); overflow: hidden; }
.team-section:last-child { border-bottom: none; }
.scorecard-frame { width: 100%; border: none; display: block; min-height: 600px; }
.view-toggle { display: flex; gap: 4px; margin-block: 8px; }
.view-btn { flex: 1; padding: 5px 0; font-size: 11px; font-family: var(--font-mono); font-weight: 600; border: 1px solid var(--border); border-radius: var(--r); background: transparent; color: var(--fg-muted); cursor: pointer; transition: background .15s, color .15s; }
.view-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }
.overview-panel { padding: 24px 20px; }
.overview-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
.ov-card { display: block; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px; text-decoration: none; color: inherit; transition: border-color .15s, box-shadow .15s; }
.ov-card:hover { border-color: var(--accent); box-shadow: 0 2px 12px rgba(8,145,178,.15); }
.ov-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-block-end: 10px; }
.ov-name { font-family: var(--font-head); font-size: 14px; font-weight: 700; color: var(--fg); line-height: 1.3; flex: 1; min-width: 0; word-break: break-word; }
.ov-grade { font-family: var(--font-mono); font-size: 12px; font-weight: 700; padding: 3px 9px; border-radius: 20px; white-space: nowrap; flex-shrink: 0; }
.ov-stats { display: flex; flex-wrap: wrap; gap: 6px; margin-block-end: 10px; }
.ov-stat { background: var(--surface-2); border-radius: 6px; padding: 6px 10px; text-align: center; min-width: 52px; }
.ov-stat-num { font-family: var(--font-head); font-size: 15px; font-weight: 800; color: var(--fg); font-variant-numeric: tabular-nums; line-height: 1.2; }
.ov-stat-lbl { font-size: 9px; color: var(--fg-dim); text-transform: uppercase; letter-spacing: .06em; font-weight: 500; margin-block-start: 1px; }
.ov-tldr { font-size: 12px; color: var(--fg-muted); font-style: italic; line-height: 1.5; margin: 0; }
.rubric-btn { margin: 0 14px 12px; padding: 6px 10px; font-size: 10px; font-family: var(--font-mono); font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--fg-muted); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r); cursor: pointer; width: calc(100% - 28px); text-align: left; display: flex; align-items: center; gap: 6px; }
.rubric-btn:hover { border-color: var(--accent); color: var(--accent); }
.rubric-btn::before { content: '⊞'; font-size: 12px; }
.rubric-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 200; align-items: center; justify-content: center; padding: 24px; }
.rubric-overlay.open { display: flex; }
.rubric-modal { background: var(--surface); border: 1px solid var(--border); border-top: 3px solid var(--accent); border-radius: 12px; width: 100%; max-width: 980px; max-height: 85vh; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 24px 64px rgba(0,0,0,.5); }
.rubric-modal-head { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.rubric-modal-title { font-family: var(--font-head); font-size: 16px; font-weight: 700; color: var(--fg); }
.rubric-close { background: none; border: none; font-size: 20px; color: var(--fg-muted); cursor: pointer; padding: 0 4px; line-height: 1; }
.rubric-close:hover { color: var(--fg); }
.rubric-body { padding: 20px 24px; overflow-y: auto; }
.rubric-section-head { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--accent); margin: 20px 0 8px; }
.rubric-section-head:first-child { margin-top: 0; }
.rubric-p { font-size: 13px; color: var(--fg-muted); line-height: 1.6; margin: 0 0 8px; }
.rubric-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; margin-block-end: 16px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.rubric-table th { background: var(--surface-2); color: var(--fg-muted); font-weight: 700; text-align: left; padding: 10px 12px; border-bottom: 2px solid var(--border); font-family: var(--font-mono); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; white-space: nowrap; }
.rubric-table th:not(:last-child) { border-right: 1px solid var(--border); }
.rubric-table td { padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: top; line-height: 1.5; font-size: 12px; }
.rubric-table td:not(:last-child) { border-right: 1px solid var(--border); }
.rubric-table tbody tr:last-child td { border-bottom: none; }
.rubric-table tbody tr:hover td { background: color-mix(in srgb, var(--accent) 4%, transparent); }
/* col 1: dimension name */
.rubric-table th:nth-child(1) { width: 130px; }
.rubric-table td:nth-child(1) { font-weight: 700; color: var(--fg); font-family: var(--font-head); font-size: 13px; white-space: nowrap; }
/* col 2: what it measures */
.rubric-table td:nth-child(2) { color: var(--fg-muted); font-style: italic; }
/* score cols — colored headers + matching text tint */
.rubric-table th:nth-child(3) { color: #ef4444; background: color-mix(in srgb, #ef4444 12%, var(--surface-2)); }
.rubric-table th:nth-child(4) { color: #f97316; background: color-mix(in srgb, #f97316 12%, var(--surface-2)); }
.rubric-table th:nth-child(5) { color: #eab308; background: color-mix(in srgb, #eab308 12%, var(--surface-2)); }
.rubric-table th:nth-child(6) { color: #0891B2; background: color-mix(in srgb, #0891B2 12%, var(--surface-2)); }
.rubric-table th:nth-child(7) { color: #22c55e; background: color-mix(in srgb, #22c55e 12%, var(--surface-2)); }
.rubric-table td:nth-child(3) { color: #ef4444; opacity: .8; }
.rubric-table td:nth-child(4) { color: #f97316; opacity: .85; }
.rubric-table td:nth-child(5) { color: #ca8a04; }
.rubric-table td:nth-child(6) { color: #0891B2; }
.rubric-table td:nth-child(7) { color: #16a34a; font-weight: 500; }
@media (max-width: 700px) {
  :root { --sidebar-w: 0px; }
  .sidebar { display: none; }
  .content { margin-left: 0; }
}
</style>
</head>
<body>

<aside class="sidebar">
  <div class="sidebar-head">
    <div class="sidebar-title">Repo Report Card</div>
    ${(() => { const ev = sections.find(s => s.event)?.event; return ev ? `<div class="sidebar-event">${escHtml(ev)}</div>` : ''; })()}
    <div class="sidebar-count">${sections.length} team${sections.length !== 1 ? 's' : ''}</div>
    <div class="view-toggle">
      <button class="view-btn active" id="btnDetail" onclick="setView('detail')">Detail</button>
      <button class="view-btn" id="btnOverview" onclick="setView('overview')">Overview</button>
    </div>
    <input class="search" type="search" placeholder="Search teams…" aria-label="Search teams">
  </div>
  <nav class="team-list" id="teamList">
${sidebarItems}
  </nav>
  <div class="no-match" id="noMatch">No teams match.</div>
  <button class="rubric-btn" onclick="document.getElementById('rubricOverlay').classList.add('open')">Scoring Rubric</button>
</aside>

<div class="rubric-overlay" id="rubricOverlay" onclick="if(event.target===this)this.classList.remove('open')">
  <div class="rubric-modal">
    <div class="rubric-modal-head">
      <span class="rubric-modal-title">Technical Complexity Rubric</span>
      <button class="rubric-close" onclick="document.getElementById('rubricOverlay').classList.remove('open')">&times;</button>
    </div>
    <div class="rubric-body">${rubricToHtml(rubric)}</div>
  </div>
</div>

<main class="content">
<div id="overviewPanel" class="overview-panel" style="display:none">
  <div class="overview-grid" id="overviewGrid">
${overviewCards}
  </div>
</div>
<div id="detailPanel">
${contentSections}
</div>
</main>

<script>
function resizeFrame(f) {
  try {
    var h = f.contentDocument.documentElement.scrollHeight;
    if (h > 200) f.style.height = h + 'px';
  } catch(e) {}
}
document.querySelectorAll('.scorecard-frame').forEach(function(f) {
  f.addEventListener('load', function() { resizeFrame(this); });
  if (f.contentDocument && f.contentDocument.readyState === 'complete') resizeFrame(f);
});

var currentView = 'detail';
function setView(v) {
  currentView = v;
  document.getElementById('detailPanel').style.display = v === 'detail' ? '' : 'none';
  document.getElementById('overviewPanel').style.display = v === 'overview' ? '' : 'none';
  document.getElementById('btnDetail').classList.toggle('active', v === 'detail');
  document.getElementById('btnOverview').classList.toggle('active', v === 'overview');
  if (v === 'overview') applySearch(document.querySelector('.search')?.value || '');
}

// Overview tile → switch to detail view and scroll to section
document.querySelectorAll('.ov-card').forEach(function(card) {
  card.addEventListener('click', function(e) {
    e.preventDefault();
    var href = card.getAttribute('href');
    setView('detail');
    if (href) {
      var target = document.querySelector(href);
      if (target) setTimeout(function() { target.scrollIntoView({ behavior: 'smooth' }); }, 0);
    }
  });
});

const search = document.querySelector('.search');
const items  = document.querySelectorAll('.team-item');
const noMatch = document.getElementById('noMatch');
function applySearch(raw) {
  const q = raw.toLowerCase().trim();
  let shown = 0;
  items.forEach(item => {
    const match = !q || item.dataset.name?.includes(q);
    item.style.display = match ? '' : 'none';
    if (match) shown++;
  });
  document.querySelectorAll('.ov-card').forEach(card => {
    const match = !q || card.dataset.name?.includes(q);
    card.style.display = match ? '' : 'none';
  });
  if (noMatch) noMatch.style.display = shown === 0 ? 'block' : 'none';
}
search?.addEventListener('input', () => applySearch(search.value));

const sections = document.querySelectorAll('.team-section');
const observer = new IntersectionObserver(entries => {
  entries.forEach(e => {
    if (e.isIntersecting) {
      const id = e.target.id;
      items.forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + id));
    }
  });
}, { threshold: 0.2 });
sections.forEach(s => observer.observe(s));
</script>
</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const imgs = loadSkinnerImages();
    if (!imgs.length) process.stderr.write('[skinner-render] warning: no Skinner images found\n');

    const sections: Section[] = [];
    let idx = 0;

    for (const input of args.inputs) {
        if (input.endsWith('.json')) {
            if (!fs.existsSync(input)) throw new Error(`file not found: ${input}`);
            const raw = fs.readFileSync(input, 'utf-8');
            const start = raw.indexOf('{');
            const end = raw.lastIndexOf('}');
            if (start === -1 || end === -1) throw new Error(`no JSON object found in ${input}`);
            const data: ScoreData = JSON.parse(raw.slice(start, end + 1));
            const sec = fromJson(data, idx, imgs);
            sections.push(sec);
        } else if (input.endsWith('.html') || input.endsWith('.htm')) {
            if (!fs.existsSync(input)) throw new Error(`file not found: ${input}`);
            const html = fs.readFileSync(input, 'utf-8');
            sections.push(extractSection(html, idx));
        } else if (args.score) {
            const sec = await scoreRepo(input, args.since, args.budget, imgs);
            sec.slug = slugify(sec.name, idx);
            sections.push(sec);
        } else {
            throw new UsageError(`'${input}' looks like a repo but --score was not given`);
        }
        idx++;
    }

    if (!sections.length) throw new Error('no sections to render');

    process.stdout.write(buildCombinedHtml(sections, imgs, readRubric()));
}

main().catch(err => {
    if (err instanceof UsageError) {
        process.stderr.write(`error: ${err.message}\n\n${USAGE}\n`);
        process.exit(2);
    }
    process.stderr.write(`error: ${(err as Error).message ?? err}\n`);
    process.exit(1);
});
