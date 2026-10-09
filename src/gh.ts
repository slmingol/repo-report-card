import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const MAX_BUFFER = 64 * 1024 * 1024;
const NAME = /^[A-Za-z0-9_.-]+$/;
const HOST = /^[A-Za-z0-9.-]+(:\d+)?$/;

const ENV = {
    ...process.env,
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GIT_TERMINAL_PROMPT: '0',
    NO_COLOR: '1',
};

export class CliError extends Error {}

function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            cmd,
            args,
            { cwd: opts.cwd, env: ENV, maxBuffer: MAX_BUFFER, timeout: opts.timeoutMs ?? 120_000 },
            (err, stdout, stderr) => {
                if (!err) return resolve(stdout);
                const e = err as NodeJS.ErrnoException & { killed?: boolean };
                if (e.code === 'ENOENT') return reject(new CliError(`'${cmd}' not found on PATH`));
                if (e.killed) return reject(new CliError(`'${cmd} ${args[0]}' timed out`));
                const msg = String(stderr || e.message).trim().split('\n').slice(-3).join(' | ');
                reject(new CliError(`${cmd} ${args.slice(0, 2).join(' ')} failed: ${msg}`));
            },
        );
    });
}

export interface RepoRef {
    host?: string;
    owner: string;
    repo: string;
}

export function repoSpec(ref: RepoRef): string {
    return ref.host ? `${ref.host}/${ref.owner}/${ref.repo}` : `${ref.owner}/${ref.repo}`;
}

export function parseRepo(input: string): RepoRef {
    const s = input.trim();
    let host: string | undefined;
    let parts: string[];

    if (/^https?:\/\//i.test(s)) {
        let url: URL;
        try {
            url = new URL(s);
        } catch {
            throw new CliError(`invalid repo URL: ${input}`);
        }
        if (url.hostname.toLowerCase() !== 'github.com' && url.hostname.toLowerCase() !== 'www.github.com') {
            host = url.host;
        }
        parts = url.pathname.split('/').filter(Boolean).slice(0, 2);
    } else {
        parts = s.split('/').filter(Boolean);
        if (parts.length === 3) host = parts.shift();
    }

    if (parts.length !== 2) throw new CliError(`expected owner/repo or https URL, got: ${input}`);
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, '');
    if (!NAME.test(owner) || !NAME.test(repo) || owner.startsWith('-') || repo.startsWith('-') || repo === '.' || repo === '..') {
        throw new CliError(`invalid owner/repo: ${input}`);
    }
    if (host !== undefined && !HOST.test(host)) throw new CliError(`invalid host: ${host}`);
    return { host, owner, repo };
}

export async function ensureGh(): Promise<void> {
    await run('gh', ['--version'], { timeoutMs: 10_000 });
    await run('git', ['--version'], { timeoutMs: 10_000 });
}

export interface RepoMetadata {
    name: string;
    url: string;
    description: string;
    is_fork: boolean;
    is_private: boolean;
    default_branch: string | null;
    created_at: string;
    pushed_at: string;
    language_bytes: Record<string, number>;
}

export async function repoView(ref: RepoRef): Promise<RepoMetadata> {
    const fields = 'nameWithOwner,url,description,isFork,isPrivate,defaultBranchRef,createdAt,pushedAt,languages';
    const raw = await run('gh', ['repo', 'view', repoSpec(ref), '--json', fields], { timeoutMs: 60_000 });
    let j;
    try {
        j = JSON.parse(raw);
    } catch {
        throw new CliError(`gh repo view returned unexpected output for ${repoSpec(ref)}`);
    }
    const language_bytes: Record<string, number> = {};
    for (const l of j.languages ?? []) language_bytes[l.node.name] = l.size;
    return {
        name: j.nameWithOwner,
        url: j.url,
        description: j.description ?? '',
        is_fork: j.isFork,
        is_private: j.isPrivate,
        default_branch: j.defaultBranchRef?.name || null,
        created_at: j.createdAt,
        pushed_at: j.pushedAt,
        language_bytes,
    };
}

export function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'principal-skinner-'));
}

export function removeDir(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
}

export async function cloneRepo(ref: RepoRef, dest: string): Promise<void> {
    await run(
        'gh',
        ['repo', 'clone', repoSpec(ref), dest, '--no-upstream', '--', '--filter=tree:0', '--single-branch', '--no-tags', '--quiet'],
        { timeoutMs: 600_000 },
    );
}

export interface Activity {
    since: string | null;
    commits: number;
    contributors: number;
    first_commit: string | null;
    last_commit: string | null;
    commits_before_since: number | null;
    total_commits: number;
}

async function hasCommits(dir: string): Promise<boolean> {
    try {
        await run('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: dir, timeoutMs: 30_000 });
        return true;
    } catch {
        return false;
    }
}

export async function commitStats(dir: string, since: Date | null): Promise<Activity> {
    let out = '';
    if (await hasCommits(dir)) {
        out = await run('git', ['log', '--format=%aI%x09%ae'], { cwd: dir, timeoutMs: 300_000 });
    }

    const all = out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            const [date, email] = line.split('\t');
            return { time: Date.parse(date), email: (email || '').toLowerCase() };
        })
        .filter((c) => !Number.isNaN(c.time));

    const inWindow = since ? all.filter((c) => c.time >= since.getTime()) : all;
    const times = inWindow.map((c) => c.time);
    const day = (t: number) => new Date(t).toISOString().slice(0, 10);

    return {
        since: since ? since.toISOString().slice(0, 10) : null,
        commits: inWindow.length,
        contributors: new Set(inWindow.map((c) => c.email)).size,
        first_commit: times.length ? day(times.reduce((a, b) => Math.min(a, b))) : null,
        last_commit: times.length ? day(times.reduce((a, b) => Math.max(a, b))) : null,
        commits_before_since: since ? all.length - inWindow.length : null,
        total_commits: all.length,
    };
}
