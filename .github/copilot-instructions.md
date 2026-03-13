# Repo Report Card Extension - Copilot Agent Instructions

## Project Overview

**Repo Report Card** is a VS Code extension that grades GitHub repositories and pull requests using AI (via GitHub Copilot). It uses Principal Skinner theming, supports grades A-F, and provides 10 specific improvement suggestions per analysis.

- **Type**: VS Code Extension
- **Languages**: TypeScript
- **Runtime**: VS Code ^1.85.0
- **Package Manager**: npm
- **Key Dependencies**: `@types/vscode ^1.85.0`, `typescript ^5.3.0`

## Project Layout

```
/
├── src/                        # Extension source code (TypeScript)
├── out/                        # Compiled output (gitignored)
├── media/                      # Icons and assets
├── .github/workflows/
│   ├── auto-release.yml        # Automated release via GitHub Actions
│   ├── release.yml             # Manual release workflow
│   └── cleanup-artifacts.yml   # Clean old artifacts
├── package.json                # Extension manifest + npm config
└── tsconfig.json               # TypeScript compiler config
```

## Build Commands (Validated)

### Prerequisites
```bash
npm install     # Install dependencies
```

### Key npm Scripts
```bash
npm run compile         # Compile TypeScript → out/
npm run watch           # Watch mode for development
npm run vscode:prepublish  # Pre-publish compile (runs before packaging)
npm run pretest         # Compile before running tests
```

### Package Extension
```bash
# Install vsce if not present
npm install -g @vscode/vsce
vsce package            # Creates .vsix file
```

### Install Locally
```bash
code --install-extension repo-report-card-*.vsix
```

## CI/CD Workflows (`.github/workflows/`)

- **auto-release.yml**: Automatically releases on push to main
- **release.yml**: Manual release trigger
- **cleanup-artifacts.yml**: Removes old build artifacts

## Development Tips
- The `out/` directory is compiled output — never edit directly
- Always run `npm run compile` before packaging or testing
- Extension entry point is defined by `main` in `package.json`
- VS Code extension APIs require matching `engines.vscode` version

## Common Pitfalls
- `out/` is gitignored — must compile before testing
- `pretest` script compiles automatically before tests run
- No test framework configured — check `src/test/` if tests are added

## Trust these instructions first. Only search if information here is incomplete.
