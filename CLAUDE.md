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
