import * as fs from 'fs';
import * as path from 'path';
import { FileEntry } from './inventory';
import { isCiFile, isDockerFile, isManifest, isTestFile } from './signals';

const MAX_READ_BYTES = 1024 * 1024;
const MIN_USEFUL_CHARS = 400;

const SOURCE_EXT = new Set([
    'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte', 'astro', 'py', 'java', 'go', 'rb', 'rs', 'c', 'cc',
    'cpp', 'cxx', 'h', 'hpp', 'cs', 'fs', 'php', 'swift', 'kt', 'kts', 'scala', 'dart', 'ex', 'exs', 'erl',
    'clj', 'lua', 'r', 'jl', 'zig', 'sh', 'bash', 'ps1', 'sql', 'graphql', 'proto', 'tf', 'hcl', 'sol', 'm',
    'mm', 'hs', 'ml', 'elm', 'nim', 'html', 'css', 'scss',
]);

const ENTRY = /^(index|main|app|server|cli|__main__|manage|program|lib|mod)\.[a-z0-9]+$/i;
const README = /^readme(\.[a-z]+)?$/i;
const PERIPHERAL = /(^|\/)(docs?|docs_src|examples?|samples?|demos?|fixtures|benchmarks?|scripts?|\.github|\.devcontainer)\//i;
const SENSITIVE = /(^|\/)(\.env(\.[^/]*)?|\.npmrc|\.pypirc|\.netrc|credentials(\.[a-z]+)?|secrets?\.[a-z]+|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?)$|\.(pem|key|p12|pfx|jks|keystore|crt)$/i;

export interface Sample {
    path: string;
    content: string;
    truncated: boolean;
}

export interface Sampling {
    budget: number;
    used_chars: number;
    files_sampled: number;
    eligible_files: number;
}

function ext(p: string): string {
    const i = p.lastIndexOf('.');
    return i === -1 ? '' : p.slice(i + 1).toLowerCase();
}

function depth(p: string): number {
    return p.split('/').length - 1;
}

function readText(root: string, rel: string): string | null {
    try {
        const buf = fs.readFileSync(path.join(root, rel));
        const head = buf.subarray(0, 8000);
        if (head.includes(0)) return null;
        return buf.toString('utf-8');
    } catch {
        return null;
    }
}

function roundRobin(files: FileEntry[]): FileEntry[] {
    const groups = new Map<string, FileEntry[]>();
    for (const f of files) {
        const dir = path.posix.dirname(f.path);
        if (!groups.has(dir)) groups.set(dir, []);
        groups.get(dir)!.push(f);
    }
    const queues = [...groups.entries()]
        .sort(([a], [b]) => depth(a) - depth(b) || a.localeCompare(b))
        .map(([, g]) => g.sort((a, b) => b.size - a.size));

    const out: FileEntry[] = [];
    for (let round = 0; out.length < files.length; round++) {
        for (const q of queues) if (round < q.length) out.push(q[round]);
    }
    return out;
}

export function selectSamples(root: string, files: FileEntry[], budget: number): { samples: Sample[]; sampling: Sampling } {
    const eligible = files.filter((f) => f.size > 0 && f.size <= MAX_READ_BYTES && !SENSITIVE.test(f.path));
    const byShallow = (a: FileEntry, b: FileEntry) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path);

    const core = eligible.filter((f) => !PERIPHERAL.test(f.path));
    const peripheral = eligible.filter((f) => PERIPHERAL.test(f.path));
    const isSource = (f: FileEntry) => SOURCE_EXT.has(ext(f.path));

    const readmes = eligible.filter((f) => README.test(path.posix.basename(f.path))).sort(byShallow).slice(0, 2);
    const manifests = core.filter((f) => isManifest(f.path)).sort(byShallow).slice(0, 4);
    const entries = core.filter((f) => ENTRY.test(path.posix.basename(f.path)) && isSource(f) && !isTestFile(f.path)).sort(byShallow).slice(0, 4);
    const docker = eligible.filter((f) => isDockerFile(f.path)).sort(byShallow).slice(0, 2);
    const ciRank = (f: FileEntry) => (/(^|[/_.-])(ci|tests?|build|deploy|release)[_.-]/i.test(path.posix.basename(f.path)) ? 0 : 1);
    const ci = eligible.filter((f) => isCiFile(f.path)).sort((a, b) => ciRank(a) - ciRank(b) || byShallow(a, b)).slice(0, 1);
    const source = core.filter((f) => isSource(f) && !isTestFile(f.path));
    const tests = eligible.filter((f) => isSource(f) && isTestFile(f.path));
    const extra = peripheral.filter((f) => isSource(f) && !isTestFile(f.path));

    const ordered: FileEntry[] = [];
    const seen = new Set<string>();
    for (const f of [...readmes, ...manifests, ...entries, ...docker, ...ci, ...roundRobin(source), ...roundRobin(tests), ...roundRobin(extra)]) {
        if (!seen.has(f.path)) {
            seen.add(f.path);
            ordered.push(f);
        }
    }

    const perFileCap = Math.max(MIN_USEFUL_CHARS, Math.floor(budget / 4));
    const samples: Sample[] = [];
    let used = 0;

    for (const f of ordered) {
        const remaining = budget - used;
        if (remaining < MIN_USEFUL_CHARS) break;
        const text = readText(root, f.path);
        if (text === null || !text.trim()) continue;
        const cap = Math.min(perFileCap, remaining);
        let content = text.length > cap ? text.slice(0, cap) : text;
        if (content.length < text.length && /[\uD800-\uDBFF]$/.test(content)) content = content.slice(0, -1);
        samples.push({ path: f.path, content, truncated: content.length < text.length });
        used += content.length;
    }

    return {
        samples,
        sampling: { budget, used_chars: used, files_sampled: samples.length, eligible_files: seen.size },
    };
}
