import * as fs from 'fs';
import * as path from 'path';
import { FileEntry } from './inventory';

const MAX_DEPS = 300;
const MAX_MANIFEST_BYTES = 512 * 1024;

const MANIFEST_NAMES = new Set([
    'package.json', 'requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py', 'go.mod', 'Cargo.toml',
    'Gemfile', 'composer.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'pubspec.yaml', 'mix.exs',
    'Package.swift', 'deno.json',
]);

const TEST_DIR = /(^|\/)(tests?|__tests__|specs?|e2e|cypress|playwright|integration[-_]tests?)\//i;
const TEST_FILE = /(\.(test|spec)\.[a-z0-9]+$)|((^|\/)test_[^/]+\.py$)|(_test\.(go|py|rb|exs)$)|((Test|Tests|Spec)\.(java|kt|cs|swift|scala)$)/;
const CI = /^(\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.ya?ml|\.circleci\/config\.ya?ml|Jenkinsfile|azure-pipelines\.ya?ml|\.travis\.ya?ml|bitbucket-pipelines\.ya?ml|\.buildkite\/.+|\.drone\.ya?ml)$/;
const DOCKER = /(^|\/)(Dockerfile[^/]*|[^/]+\.dockerfile|(docker-)?compose(\.[^/]+)?\.ya?ml|Containerfile)$/i;

export interface Signals {
    has_tests: boolean;
    has_ci: boolean;
    has_docker: boolean;
    manifests: string[];
    dependencies: string[];
    dependencies_truncated: boolean;
}

export function isManifest(p: string): boolean {
    const base = path.posix.basename(p);
    return MANIFEST_NAMES.has(base) || /^requirements[-_.\w]*\.txt$/.test(base);
}

export function isTestFile(p: string): boolean {
    return TEST_DIR.test(p) || TEST_FILE.test(p);
}

export function isCiFile(p: string): boolean {
    return CI.test(p);
}

export function isDockerFile(p: string): boolean {
    return DOCKER.test(p);
}

function read(root: string, rel: string): string {
    try {
        const full = path.join(root, rel);
        if (fs.lstatSync(full).size > MAX_MANIFEST_BYTES) return '';
        return fs.readFileSync(full, 'utf-8');
    } catch {
        return '';
    }
}

function tomlSection(src: string, header: RegExp): string {
    const lines = src.split('\n');
    const out: string[] = [];
    let inside = false;
    for (const line of lines) {
        const h = line.match(/^\s*\[([^\]]+)\]\s*$/);
        if (h) {
            inside = header.test(h[1].trim());
            continue;
        }
        if (inside) out.push(line);
    }
    return out.join('\n');
}

function pep508Name(spec: string): string | null {
    const m = spec.trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
    return m ? m[1].toLowerCase() : null;
}

function parseManifest(base: string, src: string): string[] {
    const deps: string[] = [];
    const push = (n: string | null | undefined) => {
        if (n) deps.push(n);
    };

    switch (true) {
        case base === 'package.json' || base === 'composer.json' || base === 'deno.json': {
            try {
                const j = JSON.parse(src);
                for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'require', 'require-dev', 'imports']) {
                    for (const n of Object.keys(j[key] ?? {})) if (n !== 'php' && !n.startsWith('ext-')) push(n);
                }
            } catch {
                /* malformed manifest */
            }
            break;
        }
        case /^requirements[-_.\w]*\.txt$/.test(base):
            for (const line of src.split('\n')) {
                const t = line.replace(/#.*/, '').trim();
                if (!t || t.startsWith('-')) continue;
                push(pep508Name(t));
            }
            break;
        case base === 'pyproject.toml': {
            const project = tomlSection(src, /^project$/);
            const arr = project.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
            if (arr) for (const m of arr[1].matchAll(/["']([^"']+)["']/g)) push(pep508Name(m[1]));
            const poetry = tomlSection(src, /^tool\.poetry\.(dev-)?dependencies$|^tool\.poetry\.group\.[^.]+\.dependencies$/);
            for (const m of poetry.matchAll(/^\s*([A-Za-z0-9._-]+)\s*=/gm)) if (m[1] !== 'python') push(m[1].toLowerCase());
            break;
        }
        case base === 'Pipfile': {
            const sec = tomlSection(src, /^(dev-)?packages$/);
            for (const m of sec.matchAll(/^\s*["']?([A-Za-z0-9._-]+)["']?\s*=/gm)) push(m[1].toLowerCase());
            break;
        }
        case base === 'setup.py': {
            const arr = src.match(/install_requires\s*=\s*\[([\s\S]*?)\]/);
            if (arr) for (const m of arr[1].matchAll(/["']([^"']+)["']/g)) push(pep508Name(m[1]));
            break;
        }
        case base === 'go.mod': {
            for (const m of src.matchAll(/^\s*require\s+([^\s(]+)\s+v/gm)) push(m[1]);
            for (const block of src.matchAll(/require\s*\(([\s\S]*?)\)/g)) {
                for (const line of block[1].split('\n')) {
                    const t = line.replace(/\/\/.*/, '').trim();
                    if (t) push(t.split(/\s+/)[0]);
                }
            }
            break;
        }
        case base === 'Cargo.toml': {
            const sec = tomlSection(src, /^(dev-|build-)?dependencies$|^target\..+\.dependencies$|^workspace\.dependencies$/);
            for (const m of sec.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)) push(m[1]);
            break;
        }
        case base === 'Gemfile':
            for (const m of src.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)) push(m[1]);
            break;
        case base === 'pom.xml': {
            for (const dep of src.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
                const g = dep[1].match(/<groupId>\s*([^<\s]+)\s*<\/groupId>/);
                const a = dep[1].match(/<artifactId>\s*([^<\s]+)\s*<\/artifactId>/);
                if (a) push(g ? `${g[1]}:${a[1]}` : a[1]);
            }
            break;
        }
        case base === 'build.gradle' || base === 'build.gradle.kts':
            for (const m of src.matchAll(/^\s*(?:implementation|api|compileOnly|runtimeOnly|testImplementation|kapt|ksp)\s*\(?\s*["']([^:"']+:[^:"']+)/gm)) push(m[1]);
            break;
        case base === 'pubspec.yaml': {
            const lines = src.split('\n');
            let inside = false;
            for (const line of lines) {
                if (/^(dev_)?dependencies:\s*$/.test(line)) {
                    inside = true;
                    continue;
                }
                if (/^\S/.test(line)) inside = false;
                const m = inside && line.match(/^ {2}([A-Za-z0-9_]+):/);
                if (m && m[1] !== 'flutter') push(m[1]);
            }
            break;
        }
        case base === 'mix.exs':
            for (const m of src.matchAll(/\{\s*:([a-z0-9_]+)\s*,/g)) push(m[1]);
            break;
        case base === 'Package.swift':
            for (const m of src.matchAll(/\.package\s*\([^)]*url:\s*"([^"]+)"/g)) push(m[1].replace(/\.git$/, '').split('/').pop());
            break;
    }
    return deps;
}

export function extractSignals(root: string, files: FileEntry[]): Signals {
    const paths = files.map((f) => f.path);
    const manifests = paths.filter(isManifest);
    const deps = new Set<string>();
    for (const m of manifests) {
        for (const d of parseManifest(path.posix.basename(m), read(root, m))) deps.add(d);
    }
    const sorted = [...deps].sort();

    return {
        has_tests: paths.some(isTestFile),
        has_ci: paths.some(isCiFile),
        has_docker: paths.some(isDockerFile),
        manifests,
        dependencies: sorted.slice(0, MAX_DEPS),
        dependencies_truncated: sorted.length > MAX_DEPS,
    };
}
