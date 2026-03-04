"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.cloneRepository = cloneRepository;
exports.getRepoFiles = getRepoFiles;
exports.getFileContent = getFileContent;
exports.cleanupRepo = cleanupRepo;
exports.cloneRepositoryWithPR = cloneRepositoryWithPR;
const simple_git_1 = __importDefault(require("simple-git"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const CLONE_DIR = path.join(os.tmpdir(), 'repo-report-card');
async function cloneRepository(repoUrl) {
    const repoName = repoUrl.split('/').pop()?.replace('.git', '') || 'repo';
    const timestamp = Date.now();
    const repoPath = path.join(CLONE_DIR, `${repoName}_${timestamp}`);
    if (!fs.existsSync(CLONE_DIR)) {
        fs.mkdirSync(CLONE_DIR, { recursive: true });
    }
    const git = (0, simple_git_1.default)();
    await git.clone(repoUrl, repoPath, ['--depth', '1']);
    const files = await getRepoFiles(repoPath);
    console.log(`Found ${files.length} files in repository ${repoName}`);
    if (files.length === 0) {
        throw new Error(`No analyzable code files found in repository. The repository may be empty or contain only non-code files.`);
    }
    const fileContents = files.slice(0, 20).map(filePath => ({
        path: path.relative(repoPath, filePath),
        content: getFileContent(filePath, 5000)
    }));
    return {
        name: repoName,
        url: repoUrl,
        path: repoPath,
        files: fileContents
    };
}
async function getRepoFiles(repoPath) {
    const files = [];
    const extensions = [
        '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', // JavaScript/TypeScript
        '.py', '.pyw', // Python
        '.java', // Java
        '.go', // Go
        '.rb', '.rake', // Ruby
        '.rs', // Rust
        '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', // C/C++
        '.cs', // C#
        '.php', // PHP
        '.swift', // Swift
        '.kt', '.kts', // Kotlin
        '.scala', // Scala
        '.sh', '.bash', // Shell
        '.sql', // SQL
        '.yaml', '.yml', // YAML
        '.json', // JSON
        '.xml', // XML
        '.tf', // Terraform
        '.hcl', // HCL
        '.dockerfile', '.Dockerfile' // Docker
    ];
    const ignoreDirs = ['node_modules', 'dist', 'build', '.next', 'coverage', '.git', 'vendor', 'target', '__pycache__', '.venv', 'venv'];
    const specialFiles = ['Dockerfile', 'Makefile', 'Rakefile', 'Gemfile', 'Vagrantfile', 'Jenkinsfile'];
    function traverseDir(dir) {
        const items = fs.readdirSync(dir);
        for (const item of items) {
            const fullPath = path.join(dir, item);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                if (!ignoreDirs.includes(item)) {
                    traverseDir(fullPath);
                }
            }
            else if (stat.isFile()) {
                const hasMatchingExtension = extensions.some(ext => item.endsWith(ext));
                const isSpecialFile = specialFiles.includes(item);
                if (hasMatchingExtension || isSpecialFile) {
                    files.push(fullPath);
                }
            }
        }
    }
    traverseDir(repoPath);
    return files;
}
function getFileContent(filePath, maxChars = 100000) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return content.slice(0, maxChars);
    }
    catch (error) {
        return '';
    }
}
function cleanupRepo(repoPath) {
    if (fs.existsSync(repoPath)) {
        fs.rmSync(repoPath, { recursive: true, force: true });
    }
}
/**
 * Clones a repository and fetches a specific pull request
 * PR URL format: https://github.com/owner/repo/pull/123
 */
async function cloneRepositoryWithPR(prUrl) {
    // Parse the PR URL
    const match = prUrl.match(/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
    if (!match) {
        throw new Error('Invalid GitHub PR URL. Expected format: https://github.com/owner/repo/pull/123');
    }
    const [, owner, repo, prNumber] = match;
    const repoUrl = `https://github.com/${owner}/${repo}.git`;
    const repoName = repo;
    const timestamp = Date.now();
    const repoPath = path.join(CLONE_DIR, `${repoName}_pr${prNumber}_${timestamp}`);
    if (!fs.existsSync(CLONE_DIR)) {
        fs.mkdirSync(CLONE_DIR, { recursive: true });
    }
    const git = (0, simple_git_1.default)();
    // Clone the repository
    await git.clone(repoUrl, repoPath, ['--depth', '1']);
    // Fetch the PR
    const gitRepo = (0, simple_git_1.default)(repoPath);
    await gitRepo.fetch('origin', `pull/${prNumber}/head:pr-${prNumber}`);
    await gitRepo.checkout(`pr-${prNumber}`);
    // Fetch main branch with more depth to establish merge base
    await gitRepo.fetch('origin', 'main:refs/remotes/origin/main', ['--depth', '50']);
    // Get the diff to find changed files
    let changedFiles = [];
    try {
        const diff = await gitRepo.diff(['origin/main...HEAD', '--name-only']);
        changedFiles = diff.split('\n').filter(f => f.trim());
    }
    catch (error) {
        // If three-dot diff fails (no merge base), try two-dot diff
        try {
            const diff = await gitRepo.diff(['origin/main..HEAD', '--name-only']);
            changedFiles = diff.split('\n').filter(f => f.trim());
        }
        catch (fallbackError) {
            // If diff still fails, we'll analyze all files
            console.warn('Unable to determine changed files, analyzing all files');
        }
    }
    // Get the full file list for context, but prioritize changed files
    const allFiles = await getRepoFiles(repoPath);
    // Prioritize changed files and include up to 20 files total
    const changedFilePaths = changedFiles
        .map(f => path.join(repoPath, f))
        .filter(f => fs.existsSync(f) && fs.statSync(f).isFile());
    const remainingSlots = Math.max(0, 20 - changedFilePaths.length);
    const otherFiles = allFiles
        .filter(f => !changedFilePaths.includes(f))
        .slice(0, remainingSlots);
    const filesToAnalyze = [...changedFilePaths, ...otherFiles];
    const fileContents = filesToAnalyze.map(filePath => ({
        path: path.relative(repoPath, filePath),
        content: getFileContent(filePath, 5000),
        isChanged: changedFilePaths.includes(filePath)
    }));
    return {
        name: `${repoName} (PR #${prNumber})`,
        url: prUrl,
        path: repoPath,
        files: fileContents,
        isPR: true,
        prNumber: parseInt(prNumber, 10)
    };
}
//# sourceMappingURL=git.js.map