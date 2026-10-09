import * as fs from 'fs';
import * as path from 'path';

const MAX_TREE = 500;
const MAX_OMITTED = 200;
const MAX_DEPTH = 64;

const IGNORE_DIRS = new Set([
    '.git', 'node_modules', 'bower_components', 'jspm_packages', 'dist', 'build', 'out', '.next', '.nuxt',
    '.svelte-kit', '.output', '.turbo', '.cache', '.parcel-cache', 'coverage', '.nyc_output', 'vendor',
    'target', '__pycache__', '.venv', 'venv', 'env', '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache',
    '.terraform', '.gradle', '.idea', '.vs', 'Pods', 'DerivedData', '.dart_tool', '.expo',
]);

const LOCKFILES = new Set([
    'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock',
    'poetry.lock', 'Pipfile.lock', 'uv.lock', 'pdm.lock', 'Cargo.lock', 'go.sum', 'composer.lock',
    'Gemfile.lock', 'Podfile.lock', 'pubspec.lock', 'mix.lock', 'flake.lock', '.terraform.lock.hcl',
    'packages.lock.json', 'gradle.lockfile',
]);

const GENERATED = [
    /\.min\.(js|css|mjs)$/i,
    /\.(js|css)\.map$/i,
    /\.bundle\.js$/i,
    /[-.]chunk\.[a-z0-9]+\.js$/i,
    /\.pb\.go$/,
    /_pb2(_grpc)?\.pyi?$/,
    /\.generated\.[a-z]+$/i,
    /\.g\.dart$/,
    /(^|\/)\.DS_Store$/,
];

export interface FileEntry {
    path: string;
    size: number;
}

export interface Inventory {
    total_files: number;
    tree: string[];
    tree_truncated: boolean;
    omitted_files: string[];
}

export interface WalkResult {
    files: FileEntry[];
    omitted: string[];
}

export function walk(root: string): WalkResult {
    const files: FileEntry[] = [];
    const omitted: string[] = [];

    const visit = (rel: string, depth: number) => {
        if (depth > MAX_DEPTH) {
            omitted.push(`${rel}/`);
            return;
        }
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
        } catch {
            return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const e of entries) {
            const p = rel ? `${rel}/${e.name}` : e.name;
            if (e.isSymbolicLink()) continue;
            if (e.isDirectory()) {
                if (IGNORE_DIRS.has(e.name)) {
                    if (e.name !== '.git' || rel) omitted.push(`${p}/`);
                    continue;
                }
                visit(p, depth + 1);
            } else if (e.isFile()) {
                if (LOCKFILES.has(e.name) || GENERATED.some((re) => re.test(p))) {
                    omitted.push(p);
                    continue;
                }
                let size = 0;
                try {
                    size = fs.lstatSync(path.join(root, p)).size;
                } catch {
                    continue;
                }
                files.push({ path: p, size });
            }
        }
    };

    visit('', 0);
    return { files, omitted };
}

export function summarize(w: WalkResult): Inventory {
    return {
        total_files: w.files.length,
        tree: w.files.slice(0, MAX_TREE).map((f) => f.path),
        tree_truncated: w.files.length > MAX_TREE,
        omitted_files: w.omitted.slice(0, MAX_OMITTED),
    };
}
