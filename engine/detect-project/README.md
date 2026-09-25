# detect-project skill (formerly detect-branding)

Detects the CSS framework, design tokens, brand colours, fonts, and user-facing structure of a project, then compiles (or synthesises) a CSS bundle the `generate-illustrated-article` and `generate-walkthrough` skills can load so their mockups visually match the actual product. After detection it deterministically recommends a provider-agnostic `low`, `medium`, or `high` model tier for those mockups.

## Invocation

```
/detect-project [codebase_path]
```

Defaults to the current working directory.

## What it does

A six-step pipeline:

1. **Static detection** — Pure regex pass via `scripts/detect_static.js`. Finds the framework (Tailwind, Bootstrap, Bulma, Foundation, MUI, custom, none), source CSS files, `:root` design tokens, SCSS variable literals, Tailwind config extend block, Rails-style default brand colour patterns, Google Fonts URLs, external stylesheet links.

2. **In-session LLM refinement** — Claude (in your current session) reads the static-detector output and resolves what regex can't: SCSS variable chains (`$primary: $brand-blue → #...`), Tailwind config imports, `@apply` component class dependencies, brand-colour usage validation, plugin detection. No subprocess, no extra API call — just smarter use of the LLM already in the room.

3. **Source compilation** — Runs the project's own build pipeline via `scripts/compile_css.sh`: `npm install --ignore-scripts` if needed, then `npx @tailwindcss/cli` / `npx tailwindcss` / `npx sass` / `npx postcss` depending on framework. This produces the exact CSS the project would serve in production. 180s timeout per command.

4. **Fallback synthesis** — When source compilation fails (broken config, missing deps, network failure), falls back to: framework CDN download (Bootstrap, Bulma, Foundation) OR a hand-written Tailwind utility fallback (`assets/tailwind-fallback.css`, ~200 utility classes + preflight reset), plus theme-aware overrides (`scripts/theme_overrides.js`) that generate `--bs-primary` / `.btn-primary` / `--color-*` style overrides matching the detected brand colours.

5. **Sanitization** — Strips compile-time-only directives (`@tailwind`, `@apply`, `@theme`, `@plugin`, `@layer`, etc.) from the final output so browsers can parse it cleanly.

6. **Model-tier recommendation** — Classifies the completed project cache without another model call or source-tree scan. Complex runtime editors, canvas scenes, and rich desktop workspaces select `high`; specialized surfaces and degraded detection paths receive conservative floors. The parent application maps the tier to current model IDs.

## Output

Writes to `<codebase>/.rtfm/`:

| File | Purpose |
| --- | --- |
| `branding.json` | Canonical detection + compilation summary. **Plausibly checkable into version control** — small, human-readable. The article/walkthrough skills read this. |
| `project_map.json` | Structure cache plus `mockup_model_recommendation.tier` (`low`, `medium`, or `high`). **Plausibly checkable into version control.** |
| `branding.css` | Compiled or synthesised CSS bundle. Often 50-150KB. Auto-`.gitignore`'d. |
| `branding-detect.json` | Raw output of the static + refinement passes (debugging / audit). Auto-`.gitignore`'d. |
| `branding.css.method.txt` | One-word compile method tag (`tailwind_v4`, `sass`, `fallback_synthesis`, etc.). Auto-`.gitignore`'d. |
| `.gitignore` | Auto-written, so the cache dir self-manages what to ignore. |

The recommendation object also includes `schema_version`, `policy_version`, an explainable numeric `score`, and machine-readable `reasons`. The stable parent-facing contract is `project_map.json.mockup_model_recommendation.tier`.

To reclassify an existing cache after the heuristic changes without repeating project detection:

```bash
node detect-project/scripts/recommend_model_tier.js .rtfm/project_map.json .rtfm/branding.json
```

## Parent-app integration

Use the recommendation to choose the model profile for subsequent `generate-illustrated-article` and `generate-walkthrough` runs:

1. Run `detect-project` and wait for it to complete successfully. On a first run, do not launch model-tier classification in parallel: the classifier depends on the enriched and validated project cache that detection produces.
2. Read `<codebase>/.rtfm/project_map.json`.
3. Require `mockup_model_recommendation.schema_version === 1` and a `tier` of `low`, `medium`, or `high`.
4. Resolve that tier through a parent-owned configuration mapping to the current harness, model, and reasoning effort.
5. Use the resolved profile for every mockup-generating skill in that project. The recommendation is intentionally project-wide and reflects its hardest normal user-facing surface.

Example cache contract:

```json
{
  "mockup_model_recommendation": {
    "schema_version": 1,
    "policy_version": "heuristic-v1",
    "tier": "high",
    "score": 13,
    "source": "heuristic",
    "reasons": [
      {
        "code": "complex_runtime_surface",
        "weight": 7,
        "evidence": {
          "recipe_count": 2,
          "max_regions": 11,
          "max_states": 8,
          "populated_canvas": true
        }
      }
    ]
  }
}
```

Only `tier` is a routing input. Treat `score`, `policy_version`, and `reasons` as observability and debugging data; their shape and thresholds may evolve. Do not infer a model family or reasoning effort directly from the score.

Parent-side pseudocode:

```js
const recommendation = projectMap.mockup_model_recommendation;
const valid = recommendation?.schema_version === 1
  && ['low', 'medium', 'high'].includes(recommendation.tier);

// Preserve mockup quality when an old, partial, or unreadable cache is found.
const tier = valid ? recommendation.tier : 'high';
const profile = configuredMockupProfiles[tier];

await runMockupSkill({
  harness: profile.harness,
  model: profile.model,
  reasoningEffort: profile.reasoningEffort,
});
```

Keep `configuredMockupProfiles` outside this repository so model migrations do not require changing or rerunning the skill. Log the chosen tier and `policy_version` with each generation for later benchmark analysis.

When a valid `.rtfm/` cache already exists, the parent may run the cache-only classifier shown above instead of rerunning detection. It performs no source-tree exploration or model call and rewrites only `mockup_model_recommendation` in `project_map.json`. Re-run full detection when project structure, runtime surfaces, or styling changes; reclassifying stale detection data cannot discover new complexity.

## How other skills consume the cache

`generate-illustrated-article` and `generate-walkthrough` check `./.rtfm/branding.json` at their start. If present, they use it (copying `branding.css` into each generation's output dir). If absent, they fall back to running the static detector inline (no LLM refinement, no compilation) and print a one-line note suggesting `/detect-project` for better fidelity.

## Cache staleness

Manual for v1. Re-run `/detect-project` when:
- The project's `tailwind.config.{js,ts}` changes
- Brand colours in model code change
- Layout templates change (fonts, external stylesheets)
- You manually edit `branding.json` and want to regenerate `branding.css`

The article/walkthrough skills will print a warning if `branding.json` is more than 7 days old, but won't block.

## When NOT to run this

- One-off article / walkthrough generations where you don't care about visual fidelity — the fallback inline detection in the other skills is fine.
- Projects with no CSS framework at all (the skill will detect `framework=none` and produce minimal output). Run it once to confirm, but no harm in skipping.

## Limitations (v1)

- **No hash-based cache invalidation** — manual re-run.
- **Per-tenant runtime branding** — only static defaults baked into the codebase. DB-driven per-tenant theming isn't detected.
- **CSS-in-JS deep extraction** — styled-components / Emotion / MUI theme objects are detected as the framework but theme palette isn't extracted.
- **Multi-format SCSS** — Sass syntax only (`.scss` / `.sass`). Less and Stylus not supported.
- **npm install** failures due to native deps (e.g. node-sass needing python build tools) are surfaced as errors; the skill falls back to synthesis.

## Requirements

- `node` (>= 22.12)
- Optional: `npx`, `npm` (only needed for source compilation; fallback synthesis works without them)
- Optional: `ffmpeg` (only for `generate-walkthrough`, not used here)
