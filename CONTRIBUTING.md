# Contributing

## Dev setup

```bash
npm install
npm run build          # compile TypeScript → out/
make render OUT=test.html && open test.html
```

`npm run build` must pass before any commit. TypeScript errors block the pipeline.

---

## Key files

| File | What it does |
|---|---|
| `src/cli.ts` | `principal-skinner` CLI — dossier collection |
| `src/render.ts` | `skinner-render` — HTML generation, CSS, client JS |
| `CLAUDE.md` | Scoring rubric, JSON schema, Skinner persona |
| `README.md` | Docs + rubric reference (kept in sync with CLAUDE.md) |

---

## Common extension points

### Add a new score dimension

1. `CLAUDE.md` — add the dimension to the `dimensions` array in the JSON schema and the rubric table.
2. `src/render.ts` — update `gradeFromScore` thresholds if the max score changes; update the HTML generation loop if the new dimension needs special rendering.
3. `README.md` — add a `<details>` block for the new dimension under the rubric section.

### Customise the Skinner persona

Edit the **Voice and persona** section in `CLAUDE.md`. The `opening_quip`, `dimensions[].quip`, `ci_quip`, and `closing_quip` fields in the JSON schema drive the in-character text. Changes take effect on the next `make score` run.

### Extend the renderer

- **CSS:** edit `SCORECARD_CSS` (inner iframe styles) or the outer CSS string in `src/render.ts`.
- **HTML structure:** find the template literal that builds `body` for each scorecard; edit inline.
- **Client-side JS:** the `<script>` block near the end of the outer HTML handles search, theme toggle, view switching, and print functions.

### Add a new `principal-skinner` signal

In `src/cli.ts`, find the `signals` object construction. Add your detection logic there (file-tree scan, manifest parse, etc.) and include the new key in the `ScoreInput` interface so `skinner-render` can consume it.

---

## PR guidelines

- Run `npm run build` before pushing — CI will reject uncompiled changes.
- `*-score.json` and `results.html` are gitignored; do not force-add them.
- Keep rubric changes (`CLAUDE.md`) and renderer changes (`src/render.ts`) in separate commits — they're reviewed differently.
- Screenshots in `media/screenshots/` should use synthetic data (no real team names or contributor handles).
