#!/usr/bin/env node
/**
 * skinner-render — combine per-repo scorecards into one HTML with TOC sidebar
 *
 * Usage:
 *   skinner-render [*.html ...]                              stitch existing scorecards
 *   skinner-render --score [--since DATE] owner/repo ...     score + stitch
 *   skinner-render --score [--since DATE] owner/repo ... existing.html ...   mix
 *
 * Output: HTML to stdout. Images are embedded as base64 (portable, no server needed).
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const MAX_BUFFER = 64 * 1024 * 1024;
const IMGS_DIR = path.resolve(__dirname, '../imgs/cropped');
const README_PATH = path.resolve(__dirname, '../README.md');
const CLI_PATH = path.resolve(__dirname, 'cli.js');

// ── Types ────────────────────────────────────────────────────────────────────

interface Section {
    slug: string;
    name: string;
    score: number;
    grade: string;
    body: string;
}

interface Args {
    score: boolean;
    since: string | null;
    budget: number;
    inputs: string[]; // HTML file paths or owner/repo specs
}

// ── Arg parsing ───────────────────────────────────────────────────────────────

class UsageError extends Error {}

const USAGE = `Usage: skinner-render [--score [--since YYYY-MM-DD] [--budget N]] <inputs...>

Inputs can be:
  existing-scorecard.html     stitch an already-scored HTML file
  owner/repo                  score this repo first (requires --score)

Options:
  --score              score owner/repo inputs via principal-skinner + claude
  --since YYYY-MM-DD   passed to principal-skinner for each repo
  --budget N           char budget per repo (default 80000)
  -h, --help           show this help

Output: combined HTML to stdout.

Examples:
  # stitch existing files
  skinner-render team1.html team2.html > combined.html

  # score + stitch in one shot
  skinner-render --score --since 2026-10-08 acme/proj1 acme/proj2 > combined.html

  # mix existing scores with new repos
  skinner-render --score --since 2026-10-08 acme/new-proj already-done.html > combined.html`;

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

function gradeFromScore(n: number): string {
    if (n >= 22) return 'A';
    if (n >= 18) return 'B';
    if (n >= 14) return 'C';
    if (n >= 10) return 'D';
    return 'F';
}

function slugify(s: string, idx: number): string {
    return `team-${idx}-${s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}`;
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
        throw new Error(`README.md not found at ${README_PATH} — run skinner-render from the repo root or reinstall`);
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

// ── Extraction ────────────────────────────────────────────────────────────────

function extractSection(html: string, idx: number): Section {
    const nameMatch = html.match(/<h1[^>]*class="project-name"[^>]*>([\s\S]*?)<\/h1>/i);
    const name = nameMatch ? nameMatch[1].replace(/<[^>]+>/g, '').trim() : `Team ${idx + 1}`;

    const scoreMatch = html.match(/<span[^>]*class="big"[^>]*>(\d+)<\/span>/i);
    const score = scoreMatch ? parseInt(scoreMatch[1]) : 0;

    // Extract body: strip <head>, strip closing </body></html>, strip big script blocks
    let body = html
        .replace(/^[\s\S]*?<body[^>]*>/i, '')
        .replace(/<\/body>[\s\S]*$/i, '')
        .replace(/<script[^>]*>\s*(?:const SKINNER_IMGS|\/\/ Restructure)[\s\S]*?<\/script>/gi, '')
        .trim();

    const slug = slugify(name, idx);
    const grade = gradeFromScore(score);
    return { slug, name, score, grade, body };
}

// ── Scoring ───────────────────────────────────────────────────────────────────

async function scoreRepo(repoArg: string, since: string | null, budget: number): Promise<Section> {
    const idx = 0; // will be re-indexed by caller
    process.stderr.write(`[skinner-render] scoring ${repoArg}...\n`);

    // Step 1: run principal-skinner
    const skinnerArgs = [CLI_PATH, repoArg];
    if (since) skinnerArgs.push('--since', since);
    skinnerArgs.push('--budget', String(budget));
    const dossierJson = await run(process.argv[0], skinnerArgs);

    // Step 2: run claude -p with rubric, no tools (forces stdout output)
    const rubric = readRubric();
    const prompt = `${rubric}\n\nThe dossier JSON is provided via stdin. Output a complete standalone HTML scorecard page to stdout. Do not write any files.`;
    const html = await run('claude', ['-p', prompt, '--tools', ''], { input: dossierJson });

    process.stderr.write(`[skinner-render] scored ${repoArg}\n`);

    // claude may output markdown or HTML — extract if needed
    const htmlContent = html.includes('<!doctype') || html.includes('<html')
        ? html
        : `<pre>${html.replace(/</g, '&lt;')}</pre>`;

    return extractSection(htmlContent, idx);
}

// ── HTML generation ───────────────────────────────────────────────────────────

const GRADE_COLOR: Record<string, string> = {
    A: '#059669', B: '#0891B2', C: '#D97706', D: '#EA580C', F: '#DC2626',
};
const GRADE_BG: Record<string, string> = {
    A: '#D1FAE5', B: '#CFFAFE', C: '#FEF3C7', D: '#FFEDD5', F: '#FEE2E2',
};

function buildCombinedHtml(sections: Section[], skinnerImgs: string[]): string {
    const imgsJson = JSON.stringify(skinnerImgs);

    const sidebarItems = sections.map(s => {
        const color = GRADE_COLOR[s.grade] ?? '#566079';
        const bg = GRADE_BG[s.grade] ?? '#F1F5F9';
        return `<a class="team-item" href="#${s.slug}" data-name="${s.name.toLowerCase()}">
  <span class="team-name">${escHtml(s.name)}</span>
  <span class="team-badges">
    <span class="grade-pill" style="background:${bg};color:${color}">${s.grade}</span>
    <span class="score-num">${s.score}<span class="denom">/25</span></span>
  </span>
</a>`;
    }).join('\n');

    const contentSections = sections.map(s => `
<section id="${s.slug}" class="team-section">
${s.body}
</section>`).join('\n');

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Principal Skinner — Hackathon Scorecards (${sections.length} teams)</title>
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

/* ── Sidebar ── */
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
.sidebar-head {
  padding: 16px 14px 10px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.sidebar-title {
  font-family: var(--font-head);
  font-size: 13px;
  font-weight: 700;
  color: var(--fg);
  letter-spacing: .02em;
  margin-block-end: 8px;
}
.sidebar-count {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--fg-dim);
  letter-spacing: .06em;
  text-transform: uppercase;
  margin-block-end: 8px;
}
.search {
  width: 100%;
  padding: 6px 10px;
  font-family: var(--font-body);
  font-size: 13px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r);
  color: var(--fg);
  outline: none;
}
.search:focus { border-color: var(--accent); }
.search::placeholder { color: var(--fg-dim); }
.team-list {
  overflow-y: auto;
  flex: 1;
  padding: 6px 0;
}
.team-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  text-decoration: none;
  color: var(--fg);
  border-left: 3px solid transparent;
  transition: background .1s, border-color .1s;
  cursor: pointer;
}
.team-item:hover,
.team-item.active { background: var(--surface-2); border-left-color: var(--accent); }
.team-name {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--fg);
}
.team-badges {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.grade-pill {
  font-family: var(--font-head);
  font-size: 11px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 4px;
  line-height: 1.5;
}
.score-num {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  color: var(--score);
  white-space: nowrap;
}
.score-num .denom { color: var(--fg-dim); font-weight: 400; }
.no-match {
  padding: 20px 14px;
  font-size: 13px;
  color: var(--fg-dim);
  display: none;
}

/* ── Main content ── */
.content {
  margin-left: var(--sidebar-w);
  flex: 1;
  min-width: 0;
}
.team-section {
  max-width: 820px;
  padding: 32px 24px 48px;
  border-bottom: 3px solid var(--border);
}
.team-section:last-child { border-bottom: none; }

/* ── Passthrough styles from per-repo scorecards ── */
.header { padding-block-end: 24px; border-bottom: 1px solid var(--border); margin-block-end: 20px; }
.event-label { font-family: var(--font-mono); font-size: 11px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--accent); display: block; margin-block-end: 8px; }
.project-name { font-family: var(--font-head); font-size: clamp(22px,5vw,32px); font-weight: 800; line-height: 1.15; color: var(--fg); margin: 0 0 4px; text-wrap: balance; }
.project-sub { font-size: 14px; color: var(--fg-muted); font-weight: 300; font-style: italic; margin: 0 0 12px; }
.meta-row { display: flex; flex-wrap: wrap; gap: 10px 20px; font-size: 13px; color: var(--fg-muted); }
.meta-row span::before { content: "· "; }
.meta-row span:first-child::before { content: ""; }
.quip { background: var(--quip-bg); border: 1px solid var(--quip-bdr); border-left: 3px solid var(--quip); border-radius: var(--r); padding: 16px; margin-block-end: 20px; display: flex; align-items: center; gap: 20px; }
.quip-right { flex: 1; display: flex; flex-direction: column; gap: 8px; justify-content: center; }
.quip-label { font-family: var(--font-mono); font-size: 10px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--quip); white-space: nowrap; }
.quip-text { font-size: 13px; font-style: italic; color: var(--fg-muted); line-height: 1.55; }
.skinner-wrap { flex-shrink: 0; line-height: 0; }
.skinner-img { height: 220px; width: auto; display: block; mix-blend-mode: screen; }
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
.score-breakdown .label { font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: var(--fg-dim); font-weight: 500; margin-block-end: 8px; }
.mini-bars { display: flex; flex-direction: column; gap: 4px; }
.mini-bar-row { display: flex; align-items: center; gap: 8px; }
.dim-abbr { font-family: var(--font-mono); font-size: 10px; color: var(--fg-dim); width: 36px; flex-shrink: 0; }
.mini-bar-track { flex: 1; height: 6px; background: var(--bar-track); border-radius: 3px; overflow: hidden; }
.mini-bar-fill { height: 100%; background: var(--max); border-radius: 3px; }
.mini-bar-fill.partial { background: var(--score); }
.sc { font-family: var(--font-mono); font-size: 11px; color: var(--fg-muted); width: 14px; text-align: right; flex-shrink: 0; }
.section-head { font-family: var(--font-mono); font-size: 11px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--fg-dim); margin-block-end: 12px; }
.dimensions { display: flex; flex-direction: column; gap: 12px; }
.dim-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r); padding: 16px; }
.dim-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-block-end: 10px; }
.dim-name { font-size: 14px; font-weight: 600; color: var(--fg); line-height: 1.3; }
.dim-name small { display: block; font-size: 11px; font-weight: 400; color: var(--fg-muted); margin-block-start: 2px; }
.score-pill { font-family: var(--font-mono); font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 20px; white-space: nowrap; flex-shrink: 0; }
.score-pill.max { background: var(--max-bg); color: var(--max); }
.score-pill.high { background: var(--score-bg); color: var(--score); }
.score-pill.mid { background: var(--warn-bg); color: var(--warn); }
.score-pill.low { background: #FEE2E2; color: #DC2626; }
@media (prefers-color-scheme: dark) { .score-pill.low { background: #2A0A0A; color: #F87171; } }
.score-bar-track { height: 6px; background: var(--bar-track); border-radius: 3px; overflow: hidden; margin-block-end: 12px; }
.score-bar-fill { height: 100%; border-radius: 3px; }
.dim-body { font-size: 13px; color: var(--fg-muted); line-height: 1.6; }
.dim-body p { margin-block-end: 6px; }
.dim-body p:last-child { margin-block-end: 0; }
.dim-body code { font-family: var(--font-mono); font-size: 11px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 3px; padding: 1px 5px; color: var(--accent); }
.flag { display: inline-flex; align-items: center; gap: 6px; background: var(--warn-bg); border: 1px solid #FCD34D; border-radius: var(--r); padding: 10px 14px; font-size: 13px; color: var(--warn); margin-block-end: 16px; }
@media (prefers-color-scheme: dark) { .flag { border-color: #78350F; } }
.flag-icon { font-size: 16px; }
.footer { margin-block-start: 28px; padding-block-start: 16px; border-top: 1px solid var(--border); font-size: 12px; color: var(--fg-dim); display: flex; flex-wrap: wrap; gap: 6px 16px; }

/* ── Responsive ── */
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
    <div class="sidebar-title">Principal Skinner</div>
    <div class="sidebar-count">${sections.length} team${sections.length !== 1 ? 's' : ''}</div>
    <input class="search" type="search" placeholder="Search teams…" aria-label="Search teams">
  </div>
  <nav class="team-list" id="teamList">
${sidebarItems}
  </nav>
  <div class="no-match" id="noMatch">No teams match.</div>
</aside>

<main class="content">
${contentSections}
</main>

<script>
const SKINNER_IMGS = ${imgsJson};

// Assign random Skinner images to .skinner-wrap elements
document.querySelectorAll('.skinner-wrap').forEach(wrap => {
  if (!SKINNER_IMGS.length) return;
  const img = document.createElement('img');
  img.className = 'skinner-img';
  img.alt = 'Principal Skinner';
  img.src = SKINNER_IMGS[Math.floor(Math.random() * SKINNER_IMGS.length)];
  wrap.appendChild(img);
});

// Fix up quip structure (each scorecard may have inline structure)
document.querySelectorAll('.quip').forEach(quip => {
  const label   = quip.querySelector('.quip-label');
  const text    = quip.querySelector('.quip-text');
  const caption = quip.querySelector('.quip-caption');
  const wrap    = quip.querySelector('.skinner-wrap');
  if (!label || !text || !wrap) return;
  const right = document.createElement('div');
  right.className = 'quip-right';
  if (label) right.appendChild(label);
  if (text)  right.appendChild(text);
  if (caption) right.appendChild(caption);
  quip.innerHTML = '';
  quip.append(wrap, right);
});

// Sidebar search
const search = document.querySelector('.search');
const items  = document.querySelectorAll('.team-item');
const noMatch = document.getElementById('noMatch');
search?.addEventListener('input', () => {
  const q = search.value.toLowerCase().trim();
  let shown = 0;
  items.forEach(item => {
    const match = !q || item.dataset.name?.includes(q);
    item.style.display = match ? '' : 'none';
    if (match) shown++;
  });
  if (noMatch) noMatch.style.display = shown === 0 ? 'block' : 'none';
});

// Highlight active sidebar item on scroll
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

function escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    const sections: Section[] = [];
    let idx = 0;

    for (const input of args.inputs) {
        if (input.endsWith('.html') || input.endsWith('.htm')) {
            // Stitch existing scorecard
            if (!fs.existsSync(input)) throw new Error(`file not found: ${input}`);
            const html = fs.readFileSync(input, 'utf-8');
            const sec = extractSection(html, idx);
            sections.push(sec);
        } else if (args.score) {
            // Score a repo
            const sec = await scoreRepo(input, args.since, args.budget);
            sec.slug = slugify(sec.name, idx);
            sections.push(sec);
        } else {
            throw new UsageError(`'${input}' looks like a repo but --score was not given`);
        }
        idx++;
    }

    if (!sections.length) throw new Error('no sections to render');

    const imgs = loadSkinnerImages();
    if (!imgs.length) process.stderr.write('[skinner-render] warning: no Skinner images found — quip cards will be imageless\n');

    const html = buildCombinedHtml(sections, imgs);
    process.stdout.write(html);
}

main().catch(err => {
    if (err instanceof UsageError) {
        process.stderr.write(`error: ${err.message}\n\n${USAGE}\n`);
        process.exit(2);
    }
    process.stderr.write(`error: ${(err as Error).message ?? err}\n`);
    process.exit(1);
});
