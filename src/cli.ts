#!/usr/bin/env node
import { CliError, cloneRepo, commitStats, ensureGh, makeTempDir, parseRepo, removeDir, repoView } from './gh';
import { summarize, walk } from './inventory';
import { selectSamples } from './select';
import { extractSignals } from './signals';

const DEFAULT_BUDGET = 80_000;

const USAGE = `Usage: principal-skinner <owner/repo | github url> [--since YYYY-MM-DD] [--budget ${DEFAULT_BUDGET}]

Clones a repo with your authenticated gh CLI and prints a JSON dossier to stdout.

Options:
  --since YYYY-MM-DD   Only count commits authored on/after this date (UTC midnight)
  --budget N           Max characters of source samples (default ${DEFAULT_BUDGET})
  -h, --help           Show this help`;

class UsageError extends Error {}

interface Args {
    repo: string;
    since: Date | null;
    budget: number;
}

function parseArgs(argv: string[]): Args {
    let repo: string | undefined;
    let since: Date | null = null;
    let budget = DEFAULT_BUDGET;

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
        const value = () => {
            const v = inline ?? argv[++i];
            if (v === undefined) throw new UsageError(`${flag} requires a value`);
            return v;
        };

        if (flag === '-h' || flag === '--help') {
            process.stdout.write(USAGE + '\n');
            process.exit(0);
        } else if (flag === '--since') {
            const v = value();
            const d = new Date(`${v}T00:00:00Z`);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
                throw new UsageError(`--since must be a valid YYYY-MM-DD date, got: ${v}`);
            }
            since = d;
        } else if (flag === '--budget') {
            const v = value();
            if (!/^\d+$/.test(v) || Number(v) < 1000) throw new UsageError(`--budget must be an integer >= 1000, got: ${v}`);
            budget = Number(v);
        } else if (a.startsWith('-')) {
            throw new UsageError(`unknown option: ${a}`);
        } else if (repo === undefined) {
            repo = a;
        } else {
            throw new UsageError(`unexpected argument: ${a}`);
        }
    }

    if (!repo) throw new UsageError('missing <owner/repo | github url>');
    return { repo, since, budget };
}

const log = (msg: string) => process.stderr.write(`[skinner] ${msg}\n`);

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const ref = parseRepo(args.repo);

    await ensureGh();
    log(`fetching metadata for ${ref.owner}/${ref.repo}`);
    const metadata = await repoView(ref);

    let dir: string | undefined;
    const cleanup = () => dir && removeDir(dir);
    const onSignal = (sig: NodeJS.Signals) => {
        cleanup();
        process.exit(sig === 'SIGINT' ? 130 : 143);
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    dir = makeTempDir();

    try {
        log('cloning');
        await cloneRepo(ref, dir);
        log('reading history');
        const activity = await commitStats(dir, args.since);
        log('walking files');
        const walked = walk(dir);
        const signals = extractSignals(dir, walked.files);
        const { samples, sampling } = selectSamples(dir, walked.files, args.budget);
        log(`sampled ${sampling.files_sampled} files (${sampling.used_chars}/${sampling.budget} chars)`);

        const dossier = {
            metadata,
            activity,
            inventory: summarize(walked),
            signals,
            sampling,
            samples,
        };
        process.stdout.write(JSON.stringify(dossier) + '\n');
    } finally {
        cleanup();
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
    }
}

main().catch((err) => {
    if (err instanceof UsageError) {
        process.stderr.write(`error: ${err.message}\n\n${USAGE}\n`);
        process.exit(2);
    }
    process.stderr.write(`error: ${err instanceof CliError ? err.message : (err as Error).stack ?? err}\n`);
    process.exit(1);
});
