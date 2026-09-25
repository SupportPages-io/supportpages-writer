---
name: generate-illustrated-article
description: Produce a COMPLETE illustrated help-centre article in one pass — draft the prose, deliberately choose which steps benefit from a screenshot, render source-grounded mockups, and optionally generate missing raster content or separately-ledgered external surfaces with OpenAI. Use when the user asks for a how-to guide, user-facing documentation, or help-centre article. Triggers on "write an article", "generate a guide", "document how to…", "write an illustrated article", "article with screenshots".
allowed-tools: Read Glob Grep Bash Write
arguments:
  - name: topic
    description: The how-to topic, e.g. "How do I invite a teammate".
  - name: max_images
    description: 'Optional. Hard limit on the number of screenshots (default: the RTFM_MAX_IMAGES environment variable, else 3). Never exceeded: group same-surface actions into one screenshot, give the main path priority, and leave the remaining actions as text.'
  - name: article_type
    description: 'Optional. how-to | troubleshooting | concept | faq. Shapes the prose structure (see "Article types"). Default: the type from the job context, else how-to.'
  - name: watermark
    description: 'Optional. on | off. Appends a slim "Screenshot created automatically by supportpages.io" strip to the bottom of every rendered PNG (default: on). Headless callers can export RTFM_WATERMARK instead; the arg takes precedence when both are given.'
  - name: polish
    description: 'Optional. on | off | only. After the post-process block, a POLISH pass (Phase 4) compares every rendered PNG against its source files and repairs omissions by adding what is missing (default: on). only skips Phases 1–3 and polishes the existing ./output/articles/<slug>/ for this topic. Headless callers can export RTFM_POLISH instead; the arg takes precedence when both are given.'
---

You are producing a **complete illustrated help-centre article** for "$topic" — prose plus rendered PNG screenshots — in **this single session**. Doing both phases in one session lets you reuse the project map, branding, and resolved view sources instead of re-loading them cold.

The crucial difference from illustrating everything: **you deliberately cover the user-performed UI actions on the main path, then choose whether any non-action steps also earn a screenshot.** `$max_images` is a **hard limit** — the `max_images` argument, else `RTFM_MAX_IMAGES` (echoed in STEP 0), else 3 — and the lint fails an article with more screenshots. Reuse one action-ready screenshot across same-surface actions; when the actions still do not fit, cover the main path first and leave conditional branches and secondary tasks as text. Rendering each mockup is the slowest part of the job, so fewer, well-chosen screenshots are the goal.

Publish the article progressively: write `article.json` as soon as the prose is complete, then publish each `block_<id>.png` immediately after that section mockup is ready. Do not hold completed screenshots until every mockup has been authored. **The reader is waiting from the first second and sees nothing until `article.json` exists, so the prose is written from a minimal grounding (Phase 1's reading budget) and the deep source resolution the mockups need happens in Phase 3, after the article is on disk — the same reading, later.** Final output remains `./output/articles/<slug>/` with `article.json`, `view_sources.json`, `block_<id>.html`, `block_<id>.png`, `lint_report.json`, and `branding.css`, plus generated-asset files only when needed.

## Phase 1 — Draft the article prose

Resolve the topic's source files and author the prose:

- STEP 0 bootstrap. Derive the slug and **write the run-trace marker** (so the trace hook logs this run for later analysis), then build the image manifest:

  ```bash
  echo "rtfm-skills v$(cat ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/VERSION 2>/dev/null || echo '?') — generate-illustrated-article"
  RTFM_WORKSPACE="${RTFM_WORKSPACE:-$(${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/generate-illustrated-article/scripts/resolve_workspace.sh)}"
  cd "$RTFM_WORKSPACE" || exit 1
  echo "workspace=$RTFM_WORKSPACE"
  echo "related_repos:"; bash ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/generate-illustrated-article/scripts/related_repos.sh
  SLUG=$(echo "$topic" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
  OUT="./output/articles/$SLUG"; mkdir -p "$OUT"
  rm -f "$OUT/generated_image_requests.json" "$OUT/generated_images.json"; rm -rf "$OUT/generated-assets"
  mkdir -p ./.rtfm-trace && printf '%s\n' "$SLUG" > ./.rtfm-trace/CURRENT   # trace marker — DO NOT skip
  mkdir -p ./.rtfm && node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/generate-illustrated-article/scripts/extract_images.js . ./.rtfm/images_base64.json --cache
  echo "RTFM_CONTEXT_FILE=${RTFM_CONTEXT_FILE:-}"
  echo "RTFM_POLISH=${RTFM_POLISH:-on}"
  echo "RTFM_MAX_IMAGES=${RTFM_MAX_IMAGES:-3}   # screenshot limit unless the max_images argument sets one"
  ```
  **`polish=only`** (re-polish an existing article): run STEP 0 WITHOUT its `rm -f … generated_image_requests.json …` line (the existing `$OUT` is the input, keep every file), skip STEP 0.5 through Phase 3 entirely, and go straight to **Phase 4 — POLISH**. Everything else about the run (workspace, trace marker, `$OUT`) is unchanged.
- **Run contract — workspace and no lint archaeology.** If the prompt or `$RTFM_WORKSPACE` names a directory, that is the target repo — use it as Cwd for every later shell command. STEP 0 also prints `workspace=`. Do not search `$HOME`, Desktop, or shell history for the project, and do not use `~/.gemini/antigravity-cli/scratch`. `$OUT` is the only artifact set for this run. Do not read prior `./output/articles/` directories (other slugs, legacy `step_N.html` naming) as templates. Do not open `scripts/lint_*.js`, `scripts/render_*.js`, or `scripts/article_blocks.js` — run the post-process linters below and fix their reports.
- **Related repositories.** If STEP 0 listed anything under `related_repos:`, this product spans several repositories checked out side by side. The working directory is the one whose screens you depict: its `.rtfm/` cache, `project_map.json`, `primary_view`s, mockups and outputs all stay there. Each listed `../<dir>` is another repository of the same product (typically its API or a shared library, with its role alongside). Read a sibling wherever the behaviour you describe is decided there — validations, limits, permissions, what a server call returns, server-sent messages — and cite such files as `../<dir>/<path>` (label evidence `found_in` accepts that form). A sibling listed with a surface other than `none` (third column) is another interface of the product with its own articles — never depict its screens here. Never `cd` into a sibling or write to it. If nothing was listed, ignore this.
- STEP 0.5 — read the job context. If `RTFM_CONTEXT_FILE` is set (echoed above), Read that JSON file **before drafting anything** — it carries the product-side job context that shapes the copy:
  - `article_description` — the one-sentence scope the user accepted for this article. Treat it as the **scope contract**: the finished article must cover exactly what it names — a mode, qualifier, or sub-feature it mentions is load-bearing (and feeds Phase 2's screen choice). It is context, not topic text: never append it to the title, the slug, or the route matching below.
  - `article_justification` — why this guide was accepted; use it to angle the introduction at the reader's real goal.
  - `writing_style` — composed voice guidance. Apply it to EVERY prose field you write (title, introduction, prerequisites, step titles and content, tips, summary). It overrides the default tone in the prose rules below; the grounding rules (verbatim UI names, no filler) always still hold.
  - `regeneration_guidance` — present only when a human reviewed a previous version of this article and asked for changes. Follow it precisely — it outranks every stylistic default, though never factual grounding (don't invent UI to satisfy it) — and re-check that the rest of the article still complies with it before you finish.
  - `article_type` — the article's type (see "Article types" below). The `$article_type` argument wins over this when both are set.

  If `RTFM_CONTEXT_FILE` is unset (interactive use), skip this step — the arguments and the defaults below are the whole contract.
- STEP 1.0 — load `./.rtfm/project_map.json`; match the topic to a `route_index` entry **by meaning, not literal string**, and on a hit reuse its resolved `primary_view` / `partials_expanded` / `controller_action` and skip rediscovery. A route (or layout) that carries `render_chain` — the detect-resolved include tree, `[{file, via, depth, kind}]` — is fully grounded: those files are Phase 3's reading list, so never grep for the components behind a matched view. Only when no route covers the topic, discover: detect the framework from `Gemfile` / `package.json` / `mix.exs` / `manage.py` / `composer.json`, locate routes → controllers/handlers → views/templates the framework's usual way, and grep the topic keywords across templates. **Budget: commit after ~10 searches** to your best grounding; if the topic names a feature with no dedicated page, infer the closest real flow from what you've found rather than re-grepping synonyms.

  **Phase 1 reading budget — write the prose from the primary views, then stop reading.** The prose needs the flow's screens, the order the user moves through them, and the exact labels of the controls each step names. That comes from the matched route's `primary_view` (open it once per screen in the flow) and, when a label is not literal in that file, the one locale/i18n file that defines it. It does NOT need the layout, the shell, the partials, the components the view composes, the CSS bundle, or the modal templates — those ground the mockups and are resolved in Phase 3, after `article.json` is on disk. Aim for `article.json` within a handful of file reads of finding the route; a Phase 1 that has opened more than ~10 source files is doing Phase 3's work early. Do not write `view_sources.json` in Phase 1.

  **Terminal projects:** if the project map has `app_type: "terminal"`, match the topic against `command_index` instead of `route_index` (same by-meaning rule) — on a hit reuse its `definition_file`, `flags`, and `help_evidence` and skip rediscovery. Fallback discovery: identify the CLI framework from the manifest (`cli_metadata` names it) and grep for the command/flag definitions — same ~10-search budget. Everything else in Phases 1 and 2 applies unchanged, except how a step is illustrated: the steps describe commands the user types, and a step whose action is "run this command" carries the runnable command as a fenced `bash` block in its `content` (flags and paths as inline code) and takes **no screenshot slot** — a screenshot is not copyable. Terminal mockups are for full-screen TUI states (`cli_metadata.has_tui`) and for steps where the command's *output* is what the reader must read or act on.

  **Mobile projects:** if the project map has `app_type: "mobile"`, match the topic against `screen_index` instead of `route_index` (same by-meaning rule) — on a hit reuse its `definition_file`, `title`, `tab`, and `ui_evidence` and skip rediscovery. Fallback discovery: `mobile_metadata` names the framework and navigation library — find the screen through its route table / screen registrations (Expo Router file routes, `<X.Screen name=>` registrations, `GoRoute(path:` tables), then open the screen component/widget file — same ~10-search budget. Everything else in Phases 1 and 2 applies unchanged; the steps describe screens the user taps through.

  **Desktop projects:** if the project map has `app_type: "desktop"`, match against `route_index` exactly as for web — desktop renderers are SPAs and the index is the same shape (router-less apps have one entry per window instead, keyed by window name). Fallback discovery: `desktop_metadata` names the renderer framework, `renderer_root`, and the `windows` list — search the renderer's router table / window entry components, same ~10-search budget. Everything else applies unchanged; the steps describe screens the user clicks through in the app window.

  **Win32 projects:** if the project map has `app_type: "win32"`, match the topic against `dialog_index` instead of `route_index` (same by-meaning rule; the main window lives under `""`) — on a hit reuse its `definition_file`, `title`, `controls`, `invoked_from`, and `ui_evidence` and skip rediscovery. Fallback discovery: grep the `.rc` files (`win32_metadata.rc_files`) for `CAPTION`/control labels and the menu tree — same ~10-search budget. Everything else applies unchanged; the steps describe menus the user opens and dialogs they fill in, with `invoked_from` giving each dialog's real menu path.

  **macOS projects:** if the project map has `app_type: "macos"`, match the topic against `view_index` instead of `route_index` (same by-meaning rule; the main window lives under `""`, hosted panes under `"<host>/<pane>"`) — on a hit reuse its `definition_file`, `title`, `kind`, `invoked_from`, `controls`, and `ui_evidence` and skip rediscovery. Fallback discovery: grep the `.xib`/`.storyboard` files (`macos_metadata.xib_dir`) for `title="…"` attributes — same ~10-search budget. Everything else applies unchanged; the steps describe menus the user opens (menu paths from `app_shell.menus`) and windows/sheets/panes they act in.

  **Game projects:** if the project map has `app_type: "game"`, match against `route_index` exactly as for web — the entries are the game's screens/states, each tagged `method: "UI"` (a DOM overlay screen) or `method: "CANVAS"` (a canvas-drawn state carrying a `scene_anatomy` reproduction recipe); on a hit reuse its `primary_view`, `partials_expanded`, and `scene_anatomy` and skip rediscovery. Fallback discovery: `game_metadata` names the engine, the draw-code file, and the state variable — find the state's draw functions there, same ~10-search budget. Everything else applies unchanged; the steps describe screens and in-game states the player moves through.
  - Write `$OUT/article.json` with this shape:

  ```json
  {
    "schema_version": 2,
    "title": "Article title",
    "article_type": "how-to",
    "blocks": [
      {"id": "introduction", "type": "prose", "presentation": "lead", "content": "1-2 sentence introduction"},
      {"id": "prerequisites", "type": "list", "presentation": "checklist", "title": "Prerequisites", "items": ["What users need"]},
      {"id": "open-settings", "type": "section", "presentation": "numbered", "title": "Open settings", "content": "Detailed instructions", "has_image": false},
      {"id": "tips", "type": "list", "presentation": "tips", "title": "Tips", "items": ["Helpful tip"]},
      {"id": "summary", "type": "prose", "presentation": "summary", "title": "Summary", "content": "1-2 sentence wrap-up"}
    ]
  }
  ```

  **This schema-v2 shape is a fixed contract and blocks are the sole prose representation.** Do not emit the legacy `introduction`, `prerequisites`, `steps`, `tips`, or `summary` keys. Block IDs are unique, stable, URL-safe kebab-case identifiers. Preserve array order. Allowed blocks are: `prose` with `lead|body|summary`; `section` with `numbered|plain`, title/content/has_image; and `list` with `bullets|checklist|tips`, title/items. Set `has_image: false` on every section initially. `content` may carry Markdown inline code anywhere; fenced code blocks only in `section` content and `prose` body/summary — never in the lead prose or in `list` items (the app renders those inline-only, and the copy lint fails them as schema errors).

  Prose rules: write for **end users**, not developers; each step `content` is 1-3 short sentences; direct imperatives ("Enter your email", not "The Email field is where…"); **bold** UI element names — bold is reserved for real on-screen labels copied verbatim from the source files (the copy lint checks them against the sources); commands, flags, and paths are inline code, never bold; happy path only — no edge cases, no behind-the-scenes explanation, no filler. Default tone (when the context supplies no `writing_style`): Stripe-docs — clean, direct, minimal. These rules describe the `how-to` shape; the other article types adjust them as follows.

  **Code formatting** (linted): terminal commands, flags, file paths, and keys/values the user types are inline code (`--env`, `~/.config/app.toml`, `port = 8080`), never bold — bold stays for on-screen UI labels. A command the user runs on its own line, or any multi-line snippet, is a fenced block — three backticks plus a language tag (`bash`, `json`, `toml`, `text` for command output) — placed in the section `content` below the instruction sentence, in the positions the contract above allows. Inline code and flags are checked against the sources like bold terms.

  **Numbered sections walk runtime states.** For actionable flows, use at least one numbered section per applicable recorded state. Concept and FAQ articles normally use plain sections instead.

  ### Article types

  `article_type` resolves in this order: the `$article_type` argument → job context → `how-to`. Every type uses the same ordered-block schema:

  - **how-to**: lead prose, optional checklist, numbered task sections, optional tips, summary. Title starts with "How to".
  - **troubleshooting**: symptom-focused lead, numbered checks/fixes ordered by likelihood, optional prevention tips, summary.
  - **concept**: lead definition followed by plain sections for the concept's facets; no artificial steps or click path.
  - **faq**: direct-answer lead followed by only the plain supporting sections/lists the answer needs.

  Then validate the file (shape only — Phase 2 flips `has_image` later):

  ```bash
  node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/generate-illustrated-article/scripts/check_article_json.js "$OUT/article.json"
  ```

  Fix the file and re-validate if the check fails. (The copy lint in the post-process block re-checks the final file, including the prose rules.)

Keep the project map, layout, chrome, branding, and the article in working memory — Phases 2 and 3 reuse them.

## Phase 2 — Cover user actions, then choose supplementary illustrations (at most `$max_images`)

Now go step by step and judge, for each: **would a screenshot make this instruction materially clearer than the text alone?**

- **An image helps** when the step points the user at a specific place or state in the UI — a particular form, a button's location, a filled-in field, an opened modal, a list/table the user must recognise. Seeing it removes ambiguity.
- **An image does NOT help** when the step is purely textual or off-screen — "wait for approval", "you're done", a conceptual note, or a step whose UI is identical to one you're already illustrating. Merely saying "you'll receive an email" does not earn a slot; a step that requires the reader to **recognise or act in** that email (find its confirmation CTA, distinguish it from a notification, copy a code) may earn one as an external surface under Phase 2.5.

**Every user-performed UI action requires screenshot coverage, within the `$max_images` limit.** Inventory every imperative that tells the reader to click, select, choose, press, tap, open, enter, type, fill, check, enable, toggle, drag, upload, paste, save, submit, send, delete, add, remove, edit, change, set, configure, pause, resume, stop, or start something in the interface. Each action's target must appear in at least one selected screenshot in its **action-ready state**: immediately BEFORE a click/select/toggle changes or removes the target; focused or populated WHILE text entry is happening, but before a later submit/navigation changes the surface. A post-action result, success state, toast, or replacement control never substitutes for the control the reader must use. An icon-only target must show its real icon and accessible label/tooltip from source. (Terminal projects: a typed command is covered by its fenced block, not a screenshot — see the terminal allocation rule below.)

**Group same-surface actions instead of duplicating screenshots.** One screenshot may cover actions from several section blocks when every target is simultaneously visible. Attach it to the earliest useful section and record stable `article_block_id` and `screenshot_block_id` values in `action_coverage`. Set `has_image: true` only on sections that own a screenshot; never add `has_image` to prose or list blocks.

**The limit is hard; when actions outnumber it, the main path wins.** Number the action-ready states in flow order and mark each one **main path** (every reader does it) or **conditional** (only some readers: steps written "If you…", "When…", optional settings, error recovery, alternative providers, second accounts). Group simultaneously visible targets first. If the main-path states still exceed `$max_images`, keep the earliest ones in flow order and leave the rest as text; conditional states get screenshots only from slots the main path leaves free. A step left as text keeps its precise prose — name the control in **bold** and say where it is — and gets no `action_coverage` entry. The lint reports these as text-only warnings once the limit is reached, and still fails uncovered actions while slots remain.

**Keep the article to one task.** A second task a reader might do afterwards ("switch accounts", "sign out") is not a section of this article: mention it in the summary or tips instead of spending a screenshot on it.

**Supplementary image budgets differ by article type; mandatory action coverage does not.** `how-to`: as described here. `troubleshooting`: after covering every check/fix control the reader uses, spend optional slots on states they must recognise. `concept`: at most ONE orienting screenshot when it contains no UI actions. `faq`: usually zero, but any answer that directs the reader to a specific control must cover that control in its action-ready state.

**One screenshot per distinct action-ready state — a bounded set, not a maximum.** A screenshot earns its place only when it shows an action target no other screenshot shows; two screenshots whose targets are all visible in one faithful state are ONE screenshot. A navigation step and the entry step it leads to share one screenshot when that state contains both the navigation target and the inputs; record both actions in its coverage ledger. A new UI state the user must act on (a further form, a confirmation or selection dialog, a follow-on screen) earns a slot; a terminal success or landing screen almost never does. **A terminal *action* panel is not a terminal landing screen:** a pre-save/pre-publish/confirm panel the user acts *in* ("Are you ready to publish?", a send-confirm sheet) is an act-on state and requires coverage — the exclusion is about *passive feedback* (a toast, a success pill), not the confirmation surface itself. Deduplication never removes action-target coverage; adding a screenshot never adds coverage that an existing one already shows.

**Depict the action-ready state, not its aftermath.** A screen usually exists in several states. For a click/select/toggle action, render the state immediately BEFORE activation with the named target visible; if activation removes **Start Recording** and reveals **Pause**, the action screenshot shows **Start Recording**, not **Pause**. For text entry, render the input focused or populated mid-entry so its location and expected value are clear, before submission changes the surface. An item being edited appears OPEN in its editor with real values mid-change; a panel being configured appears expanded to the control the step names. Browse/list states earn a slot only when the action target lives there or the topic itself is about finding/browsing. Outcome/confirmation states are separate, optional coverage unless the reader must act in them.

**Show the control change without inventing a new product theme.** Opening a color, typography, density, or appearance control does not authorize an invented surrounding-canvas redesign. Unless the selected runtime state or opened source records the exact changed value, keep the document/canvas on its source-backed default colors, typography, spacing, and content; depict the action through the open control, focus/selection indicator, or checked option. A plausible-looking new palette is still invented and harms brand fidelity. A subsequent confirm/save screenshot clones that same canvas byte-for-byte and adds only the recorded confirmation surface (plus an explicitly recorded backdrop); it never recolors or restyles the underlying document to imply the pending change.

**Allocate the budget: cover the action targets first, main path before conditional, then stop at `$max_images`.** Before marking any `has_image`, list each action-ready state the topic's verbs require. Cover every target that fits, grouping simultaneously visible targets into one screenshot. Spend a remaining slot on the entry or outcome state only when it adds recognition the action screens lack; a passive outcome/confirmation never displaces an uncovered action, and a second screenshot of an unchanged state is redundant. **When a schema-v4 runtime layout records states, allocation is topic-aware and mechanical:** (1) select every action state needed to expose the article's targets, starting with the state whose `topic_tags` best match the title and step verbs; (2) select applicable `screenshot_required`/`terminal-action` states; (3) include the `orientation` state when its visible skeleton differs and a slot remains; (4) only then include additional variants or passive outcomes. Drop an unrelated or `secondary-action` branch before orientation. Write selected/dropped IDs and topic-tag matches in `runtime_state_selection`; a generic “outside budget” reason is insufficient. For legacy schema-v2/v3 recipes without topic tags, use recorded flow order while preserving every action-ready state. A save/confirm screenshot renders the actionable panel BEFORE its confirming control is activated.

**Terminal projects (`app_type: "terminal"`) allocate by output, not by typing.** A "run this command" step is `has_image: false`: its fenced block is the copyable artefact. Spend slots only on (1) each full-screen TUI state the topic passes through (`cli_metadata.has_tui`), (2) command output the reader must read or act on — a listing they pick from, a prompt they answer, a table or error they interpret — and (3) at most one orienting `--help` state when the topic is discovery itself. A step that shows both keeps both: the fence in `content`, the output in the mockup.

**Stay inside the topic's surface once entered.** When the topic's flow lives inside one surface (an editor, builder, designer, wizard), every illustrated step from the entry point onward stays inside that surface and its own panels/states — do not spend a slot returning to the surrounding admin/dashboard chrome unless the flow genuinely ends there. A screenshot of the familiar outer shell is cheap to author and reads as coverage, but it is off-flow.

**Stay within the topic's stated actions.** A topic that names a mode or qualifier (**automatically**, scheduled, private, shared…) must spend one slot on the screen where that mode is configured — the qualifier is the topic's most load-bearing word, and an article that never shows where it's turned on has missed its own subject. **A dedicated mode beats a generic affordance:** when the sources reveal a purpose-built mode/screen for the topic's action (a tag mode for assigning tags, a bulk-select mode, a dedicated wizard), illustrate that surface rather than a generic right-click/context-menu path — the dedicated surface is what the feature's designers built for exactly this task, and it's what the reader will be told to use. **The illustrated set is the minimum that covers the topic's actions:** an interstitial type-chooser, a confirmation pill/toast, or a second variant of a menu you already show never earns a slot — two well-chosen screens beat three. **When the topic's action exists at both the app level and a per-item level** (global speed limits vs one torrent's limits, workspace notifications vs one channel's), the topic names the **app-level** surface unless it names a specific item — a per-item screen for an app-level topic is the wrong feature, not extra coverage. Illustrate the screens the topic's own verbs name — nothing adjacent. For a "**view and manage** a collection" article, that's the collection screen itself plus its *in-place management affordances* (a per-row/item action menu, an inline toggle, an inline confirmation dialog) — those **are** "managing" and they keep you on one recognisable screen. Do NOT spend a slot on a tangential flow the topic doesn't name — creating a brand-new item, or a deep multi-tab editor sub-page — those are separate tasks (and often a different layout) that pull coverage off the article's actual subject. **For game projects,** a topic naming playing, starting, or gameplay must spend one slot on the canvas gameplay state itself (a `method: "CANVAS"` route) — menu screens alone miss the article's subject.

## Phase 2.5 — Generate missing content images or external surfaces only when required

Before writing mockups, inspect the selected states for **intrinsically raster content** that the real UI requires but the repository image manifest cannot supply. Examples: a fictional participant's live camera image, an uploaded photo preview, product photography, or artwork shown inside a real media region. Prefer a suitable `{{img:…}}` repository asset whenever one exists.

**Never use image generation for the mockup itself.** Build all application chrome, screens, controls, dialogs, charts, diagrams, document shells, file-type icons, logos, avatars that can be initials, and layout structure in source-grounded HTML/CSS/inline SVG. For a file upload, generation may supply the uploaded photo/video preview; it must not draw the dropzone, file icon, filename row, or surrounding interface. For a video call, generated pixels may fill camera tiles; tile layout, names, mute controls, and call chrome remain HTML/CSS.

There is one separately-authorised exception: an **external surface** the user encounters outside the product application and must recognise or act in. Allowed surfaces are `confirmation-email`, `invitation-email`, `os-permission-dialog`, `browser-permission-dialog`, `push-notification`, `document`, `receipt`, and `third-party-consent`. Prefer, in order: a real repository asset; a directly renderable repository template; then an external-surface generation request. Do not generate an external surface merely for decoration or passive "you will receive…" prose. It must be the instructional state for that step, and it must never depict or extend the product application's own UI.

If no content images or external surfaces qualify, do not write a request file and skip this phase. Otherwise write `$OUT/generated_image_requests.json` with at most **5 unique assets**:

```json
{
  "version": 1,
  "assets": [
    {
      "id": "participant-alex",
      "kind": "video-frame",
      "purpose": "Fictional participant visible inside the source-backed call tile",
      "reason": "The depicted state requires a live camera feed and the repo has no suitable image",
      "prompt": "Natural webcam view of a fictional adult in a bright home office",
      "aspect_ratio": "landscape",
      "alt": "Fictional participant on camera",
      "used_in_blocks": ["join-call", "review-notes"]
    }
  ]
}
```

`kind` is `photo`, `portrait`, `video-frame`, `artwork`, `media-preview`, or `external-surface`; `aspect_ratio` is `landscape`, `portrait`, or `square`. `used_in_blocks` contains stable article block IDs. Reuse an asset when the same content persists. Keep prompts anonymous and free of secrets/customer data. For ordinary content kinds, do not ask the model to render UI, text, logos, controls, frames, icons, charts, or watermarks.

An `external-surface` request additionally requires `surface`, `source_basis` (`repository|user-description|platform-convention`), `source_files` (safe project-relative paths; non-empty for `repository`), and `required_text` (1–20 exact visible strings). Put **every** name, heading, body sentence, button label, link label, code, date, and legal phrase that must be legible into `required_text`; do not leave copy for the model to invent. The helper places the exact-text ledger and external-only UI authorization into the prompt and records it in `generated_images.json`:

```json
{
  "id": "confirmation-email",
  "kind": "external-surface",
  "surface": "confirmation-email",
  "source_basis": "user-description",
  "source_files": [],
  "required_text": ["Confirm your email address", "Confirm email"],
  "purpose": "The email in which the reader must confirm their address",
  "reason": "The action occurs outside the product and no renderable email template exists",
  "prompt": "Straight-on transactional email on a neutral mail canvas; one primary CTA",
  "aspect_ratio": "portrait",
  "alt": "Confirmation email with a Confirm email button",
  "used_in_steps": [2]
}
```

```bash
if [ -f "$OUT/generated_image_requests.json" ]; then
  node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/generate-illustrated-article/scripts/generate_content_images.js \
    --requests "$OUT/generated_image_requests.json" \
    --out "$OUT" \
    --cache ./.rtfm/generated-content
fi
```

The helper uses `gpt-image-2` (`OPENAI_IMAGE_MODEL` overrides), caches by prompt/model/size, and writes `$OUT/generated_images.json` plus successful files in `$OUT/generated-assets/`. Missing credentials or an API error records a failure and produces no fallback. If a failed asset was a standalone external surface, set its owning section's `has_image` false, remove its block HTML/source/coverage entry, and record the failed block ID in `generation_omissions`.

Embed each ordinary content result only as an image inside the real UI:

```html
<img src="{{generated:participant-alex}}"
     data-rtfm-generated-asset="participant-alex"
     alt="Fictional participant on camera">
```

The marker is mandatory. Never place `{{generated:…}}` in CSS, a background, `<html>`, `<body>`, or a mockup-wide container. Generated content never satisfies a repo-backed `representative_assets` obligation.

For `external-surface`, make the image the standalone instructional surface instead. Add the matching body/image markers and record the same ledger in that step's `view_sources.json`; do not render any `data-rtfm-region` product regions in the step:

```html
<body data-rtfm-surface="external">
  <img src="{{generated:confirmation-email}}"
       data-rtfm-generated-asset="confirmation-email"
       data-rtfm-external-surface="confirmation-email"
       style="display:block;width:100%;height:100vh;object-fit:contain"
       alt="Confirmation email with a Confirm email button">
</body>
```

```json
{
  "index": 2,
  "url_or_route": "external:confirmation-email",
  "external_surface": {
    "asset_id": "confirmation-email",
    "surface": "confirmation-email",
    "source_basis": "user-description",
    "source_files": [],
    "required_text": ["Confirm your email address", "Confirm email"]
  },
  "default_user_assumptions": [],
  "verbatim_evidence": []
}
```

An external step omits `primary_view`, `layout`, `partials_expanded`, and runtime-state fields. Lint permits its generated `<img>` to fill the step only when the request manifest, generated manifest, HTML markers, and `view_sources.json` ledger match exactly. Ordinary generated content remains leaf-only inside source-grounded product UI.

## Phase 3 — Progressively render the selected mockups, CHROME AUTHORED ONCE

**Terminal projects** (`project_map.app_type == "terminal"`): author `view_sources.json` and the mockups per the **Terminal mockup contract** at the end of this section instead of the web chrome-once rules that follow, then rejoin at the post-process bash block — it is identical for all modes. **Mobile projects** (`project_map.app_type == "mobile"`): same routing, but per the **Mobile mockup contract** (after the terminal one). **Desktop projects** (`project_map.app_type == "desktop"`): follow the web rules below — the CSS is the app's own — but wrap every mockup per the **Desktop mockup contract** (after the mobile one). **Win32 projects** (`project_map.app_type == "win32"`): like terminal/mobile, replace the web rules with the **Win32 mockup contract** (after the desktop one). **macOS projects** (`project_map.app_type == "macos"`): same routing, per the **Macos mockup contract** (after the win32 one). **Game projects** (`project_map.app_type == "game"`): DOM overlay screens follow the web rules below — the CSS is the app's own — and canvas-drawn states follow the scene rules in the **Game mockup contract** (after the macos one); every mockup of either kind wraps in the playfield frame per that contract.

**Resolve the mockup sources now, not earlier.** For each illustrated block: open its `primary_view` in full, walk the layout and its chrome files (`project_map.layouts[].chrome`), and expand every include the view renders (the classification rule below) — this is where the deep reading belongs, after the article has been published. Then write `$OUT/view_sources.json` before the first mockup, with top-level `action_coverage` and `blocks` arrays. Include one entry per illustrated section using `block_id` equal to the section's stable ID, plus the existing source/runtime evidence fields. Each action-coverage entry uses singular `article_block_id` and `screenshot_block_id` fields, and the pictured control is marked `data-rtfm-action-target="<article-block-id>"`; never use positional indexes. Files are `block_<id>.html/.png`. The external-surface exception and all source-grounding requirements remain unchanged.

Record one `action_coverage` entry per distinct user-performed UI action. Several entries may point to the same screenshot when it faithfully shows all targets at once:

```json
{
  "framework": "...",
  "action_coverage": [
    {
      "article_block_id": "open-settings",
      "screenshot_block_id": "open-settings",
      "kind": "click",
      "target": "Home",
      "state": "action-ready"
    },
    {
      "article_block_id": "start-recording",
      "screenshot_block_id": "open-settings",
      "kind": "click",
      "target": "Start Recording",
      "state": "action-ready"
    }
  ],
  "runtime_state_selection": {
    "layout": "<layout name/path>",
    "selected": ["<state id>"],
    "dropped": [{"id": "<state id>", "reason": "<why it is outside the screenshot target/topic>"}]
  },
  "blocks": [{"block_id": "open-settings", "...": "source/runtime evidence fields"}]
}
```

`kind` is `click`, `type`, `select`, `toggle`, `drag`, `upload`, or `keyboard`; `target` is the exact visible label or source-backed accessible name of the control; `state` is always `action-ready`. `article_block_id` is the id of the article section block whose prose performs the action; `screenshot_block_id` is the id of the illustrated block whose mockup shows the target — every `screenshot_block_id` must be a `block_id` present in `blocks` with a `block_<id>.html` mockup and `has_image: true` on its section. Put `data-rtfm-action-target="<article_block_id>"` on the real target element in the named screenshot (`<button>`, `<input>`, menu item, toggle, etc.). If one prose block has multiple distinct targets, write multiple ledger entries with that block id and mark each target. **One shape only:** block ids everywhere, in the ledger and on the markers. The lint maps them to positions itself; the legacy `article_step_index`/`screenshot_step_index`/`steps[]` shape still lints, but mixing the two (ids in the ledger, numbers on the markers, or a `screenshot_block_id` that names no illustrated block) is what the lint's "positional"/"outside the zero-based range" errors mean. Add every target string to that screenshot step's `verbatim_evidence` (use `{ "string": "…", "found_in": "…" }` when it lives in a partial/locale). Standalone generated external surfaces cannot carry an HTML marker inside their pixels; for those only, `target` must instead appear in the external surface's exact `required_text` ledger.

The fidelity lint hard-fails when an imperative UI-action step lacks coverage; a coverage index is one-based/out of range; its screenshot is not owned by a `has_image: true` article step; the target marker/string/evidence is absent; or `state` is anything other than `action-ready`. Therefore:

- **`primary_view` is mandatory for product-app steps** and must be a real file path relative to the project root that you have opened with `Read` — if you can't open it, you don't know what to mock. A standalone Phase 2.5 external surface omits it and uses its exact external ledger instead.
- **`partials_expanded` lists every included file in the rendered chain** (`render partial:` / `<Component />` / `@include` / `{% include %}` / `<.component />`), recursively. **Classify each include by its render condition at the call site, because that decides what it contributes to the screen:** an *unconditional* include (rendered on every load) is part of the screen and appears on every screenshot of that view; an *overlay* include (a modal, drawer, sheet, menu, popover — in the DOM but hidden until an action) is never a screen or `primary_view` on its own — a step that opens it shows the host view with the overlay over it, `primary_view` unchanged; a *conditional* include (behind a guard) resolves per `default_user_assumptions`. The same holds for the view's own inline sections: every heading-led section the primary view paints unconditionally is on every screenshot of that view — a screenshot of a form shows the whole form, not only the card the step acts on. The lint checks for a trace of each unconditional piece (`screen_closure`). **When the matched route carries `render_chain`, that list IS the recursive chain, already classified:** copy its `unconditional` entries into `partials_expanded` (the matched layout's own `render_chain` supplies the shell files), add an `overlay` entry only on the step that opens it, and open the files shallow-first (`depth` ascending) — a file at `depth` ≥ 3 is opened only when a shallower file renders it in a region you must depict. Never rediscover chain files by grep; `render_chain_stats.unresolved` counts library imports, not gaps for you to fill.
- **`verbatim_evidence` is at least 3 distinctive strings per step** (page titles, button labels, section headings) that appear in the named source file (or resolve through verified structured generated-label evidence) AND will appear verbatim in the mockup — the lint asserts both. For framework-generated labels, translations, or icon-only controls, read [UI label evidence](contracts/label-evidence.md). Keep action targets intact; a free-text derivation is not evidence.
- **`default_user_assumptions` documents every conditional that resolves to "don't render" for a default user** — a non-admin, non-impersonating user on an active (non-trialing) account with default settings. Assume the branch a fresh, ordinary user sees: no admin tools, debug helpers, dev-only widgets, or warning banners unless the article is about them. Each assumption may carry a `markup_absence_check` array of substrings the lint asserts are absent from the mockup.
- **`depicted_state` names the exact action-ready UI state in one line, including each covered target and that it remains available BEFORE activation** — written before authoring the mockup ("Home ready to record; Home and Start Recording controls visible before selection", "Email input focused mid-entry; Continue still available"). Outcome-only wording such as "recording active" cannot describe a screenshot covering **Start Recording**.
- **`runtime_state_id` is the exact schema-v2-or-newer `runtime_chrome.states[].id`**, never a paraphrase. For schema v3+, `runtime_source_files` is exactly the de-duplicated union of the runtime recipe, the selected state's `visible_regions`, and the selected state's own source files; do not add a nearby implementation or visual variant that the recipe did not select. (`required_regions` remains the legacy schema-v2 rule.) Schema-v4 selection reasons cite the matched `topic_tags` and `instructional_priority`.

Persist what you resolved back to `./.rtfm/project_map.json` (append each step's route → `{primary_view, controller_action, partials_expanded}` to `route_index`; fill an empty `default_user_assumptions` with the project-wide suppressions you found) so the next run skips this discovery — `node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/merge_json.js ./.rtfm/project_map.json <patch.json>` merges a patch in place; don't clobber the deterministic fields.

Then author and render the mockups using the chrome-once / clone-and-edit approach. After writing each selected `block_<id>.html`, run:

```bash
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/generate-illustrated-article/scripts/render_ready.js "$OUT" <block-id> "."
```

Replace `<block-id>` with the illustrated section's stable ID. The helper validates and atomically publishes `block_<id>.png`, restoring authored HTML afterward. Do not batch these calls.

Use this sequence:

1. **Author the first selected step in full — shell FIRST, then page content.** Compose `$OUT/step_<first>.html` as a complete document, laying the `<body>` down in this exact order:
   1. **The app shell.** For an authenticated in-app page (dashboard / list / settings / detail), the FIRST thing inside `<body>` is the persistent shell you already resolved into `partials_expanded` and `project_map.app_shell` (the matched layout's `render_chain` names its files) — the sidebar (or top nav): the `account_area`, every `nav_item` rendered as an icon + label row with the **current page's item marked active**, and the `footer_items`; plus the top bar with **every item the map records on it** (`top_bar.items_left`/`items_right` — badges, counters, menus included). This is load-bearing chrome, not optional context — emit it before you write a single line of page content.
   2. **The page content.** Inside the shell's `<main>` region, the leaf view for this step.

   Concrete skeleton (adapt the tags/classes to the project's real markup):
   ```
   <html class="…app_shell.root_classes.html…">
   <body class="…app_shell.root_classes.body + the layout's literal body classes…" data-viewport="web">
     <aside>…sidebar: account_area · nav_items (active one highlighted) · footer_items…</aside>
     <main>…this step's page content (list / form / detail)…</main>
   </body>
   </html>
   ```
   **The containing chain starts at `<html>`, not `<body>`.** Copy the root element's classes from `project_map.app_shell.root_classes` when present; otherwise resolve them from the layout yourself — root classes are often *computed* server-side (a layout may emit `<html class="<?php echo $x; ?>">` via a helper in another file), so resolve the default-user value the same way `default_user_assumptions` resolves conditionals. They are load-bearing: fixed-chrome offset rules (`html.<class> { padding-top: … }` keeping a fixed top toolbar off the content) and theme scoping hang on them — a mockup that drops the root class renders the fixed bar overlapping the page, and the lint enforces the `html` tokens on shell-rendering mockups. **When the step's matched `project_map.layouts[]` entry records its own `root_classes`, those REPLACE the app-shell defaults for that step** (the lint enforces the layout's tokens on steps claiming it) — a layout that diverges from the app default (a fullscreen editor, a focused/zen mode) diverges in its root state classes too, and carrying the default offset class onto a layout whose top bar is hidden paints a phantom gap.
   Also: `<!-- INJECT_CSS -->` in `<head>`, `{{img:filename}}` for project images, light mode, one viewport/layout/theme, verbatim UI copy from the source files, no invented colours, no annotations. `data-viewport="web"` on every step (it is also the renderer's default when the attribute is absent; never the content-cropped `wide` or the legacy `desktop`/`mobile` presets). (A **standalone** page — login, signup, public booking page — has no shell: render it centered, no sidebar, and without the shell's root state classes.)
2. **Progress-publish the first selected step.** Complete its applicable pre-render self-check, then run `render_ready.js` for its index. Do not begin the next mockup until this command has either published the PNG or reported the issue to fix.
3. **Clone, edit, and progress-publish every subsequent step.** For each remaining selected step: `Read` the first mockup, write it out as `$OUT/step_<n>.html`, and `Edit` ONLY the leaf content region this step shows (open a different modal, change the active row/field, swap the panel). **Keep the entire shared chrome — layout, nav, sidebar, header — byte-identical; do not re-type or re-derive it.** Preserve the `<!-- INJECT_CSS -->` marker and `{{img:…}}` placeholders. If a step genuinely renders a *different page* (different layout), author that one in full instead of cloning — clone only when the chrome is the same. **Schema-v3 runtime states are an explicit exception to byte-identical chrome:** after cloning, replace the runtime-app children so they are exactly that state's ordered `visible_regions`; remove regions the new state hides and add regions it reveals. The state skeleton outranks clone preservation. Complete that step's applicable pre-render self-check and run `render_ready.js` for its index immediately, before authoring another step.
4. Post-process with the bash block at the end of this section. This whole-article gate injects the final HTML, runs the complete fidelity/copy lints and validation, and rerenders every PNG so any final correction replaces its progressive version.

**The app shell is mandatory, not optional context — and `project_map.app_shell` is the completeness checklist.** You resolved the shell components (a Shell / SideBar / Navigation / layout) into `partials_expanded` — listing them there and then NOT rendering them is the single most common and most heavily penalised mockup failure. A dashboard/list/settings page drawn without its sidebar + header is a detached fragment that looks nothing like the real product, no matter how good the inner content is. So: **every in-app page renders the shell, and every region and item the map records appears with the content the map describes** — each `nav_item` (current page's marked active), the `account_area`, each `footer_item`, and the top bar with each recorded item (a badge, a counter, a bubble the map lists is rendered, not summarised away). Author them as real widgets — the map data is what to check against, never text to transcribe onto the page. If `app_shell` is absent, expand the shell components in `partials_expanded` yourself. The only pages with no shell are genuinely standalone ones (login, signup, public pages) — **plus layouts the map records as shell-hiding**: when the step's matched `layouts[]` entry records a mode that hides the persistent shell (its `area`/`mode_note` says so, or its `root_classes` carry the app's fullscreen/zen-mode token), render WITHOUT the sidebar/top bar — in that mode the runtime app's own chrome (see `runtime_chrome` below) IS the screen's chrome, and wrapping it in the admin shell is the wrong-mode failure. This exception is strictly map-gated: never drop a shell the map doesn't say is hidden.

**Chrome completeness is closure over the layout, not a named-region list.** The unit you reproduce is *everything the matched layout renders around the page content* for the default user — not just the sidebar and header you already know to include. Walk the layout's render output: every include/partial/component it emits unconditionally (top toolbar, screen-level utility affordances like per-screen option/help tabs, breadcrumbs, notification areas, footers) is part of the screen. Concretely: the matched `project_map.layouts[]` entry's **`chrome` list is a per-layout checklist — open every file it names, render the region it emits, and list it in `partials_expanded`** (the lint enforces this). The step's action target determines what you *emphasise*, never what you *include* — rendering the branch that contains the action and pruning the layout's other children is the thin-chrome failure, and it reads as a mockup of a different, poorer product.

**Self-check before rendering (mandatory).** For each `has_image` step of an authenticated in-app page: (1) does the mockup's `<body>` begin with the visible sidebar/nav shell, with page content inside `<main>`? (2) Does `<html>` carry `app_shell.root_classes.html`? (3) Is every recorded shell item present? (4) Is every matched-layout chrome file opened, rendered, and listed? (5) For every `action_coverage` entry pointing here, is the exact target visible, marked `data-rtfm-action-target`, present in `verbatim_evidence`, and still actionable BEFORE activation (or focused/populated mid-entry before submission)? (6) Does `depicted_state` name that same state? (7) Does the subject — the action target and its evidence strings — sit inside the 1480×900 viewport, with the scrolled state depicted if a faithful top-of-page copy would push it below the fold? If a post-action replacement is visible but the covered target is gone, the screenshot is wrong. If a mockup has no visible sidebar, it is a detached fragment — fix it before rendering. Phase 4 re-checks the same items on the rendered PNG; a self-check you skip here comes back as a polish ticket.

**Populate data regions — never leave a container empty or skeletal.** A mockup must look like a real, in-use screen, not a wireframe. Fill every data-bearing region with realistic example content modelled on the source view's structure: a list or table shows 3–5 example rows of plausible data — **each row reproducing the source row's full set of columns and controls** (secondary text like a URL/slug or description, status toggles, badges, per-row action buttons/icons), not a title-only row; a picker/selection modal shows its selectable items **and** its action buttons. Match the view *type* and *structure* the source renders — never substitute a simpler view type for the one the source shows. Include the page's own **header region** — the page title, subtitle/description, and primary action button that sit above the main content — not just the content beneath it. Building the outer card/chrome but leaving the inner grid/list/modal blank — or rendering thin, control-less rows, or dropping the page header — is a top fidelity failure. **Reproduce every section/sub-widget the source view renders, not just the region the step's action touches** — a form with several field groups plus an options panel plus a members/participants sub-widget must show all of them; silently dropping a whole section (a form's guest-list picker, a detail page's secondary card) is the same failure sideways.

**Primary action buttons render filled, never as plain text.** A page's primary/confirming button (create, save, or the destructive confirm) is a solid filled button with light text. **When the button's real component class is styled by `branding.css`, use that class as-is and let the app's own CSS paint it — never re-tint it in the brand colour** (a real stylesheet's neutral button repainted brand-yellow reads as off-brand, not on-brand). Only when the class isn't backed by `branding.css` do you **inline-style the fill** (`background` in the brand primary, `color`, padding, rounded) — never let a primary button render as bare text or an empty outline. Secondary buttons stay outlined/ghost as in the source.

**Icons are inline SVG, never emoji.** Render every icon (nav items, per-row/action icons like copy-link, external-link, settings, the ⋯ more-menu) as an inline `<svg>` copied from the source's real icon markup, or the project's icon system (heroicons / `fa-*` / `bi-*`). **NEVER substitute an emoji or Unicode symbol character or HTML entity** (`🔗 ⚙ 📋 ↗ ⋯ ●`, `&#128279;`, `&#x1F517;`) for an icon — they render as emoji and look unprofessional and off-brand. This shortcut is tempting on icon-dense screens (many repeated action icons); author the SVG anyway. The fidelity lint hard-fails on emoji glyphs in a mockup.

**Render data regions self-contained — reproduce the widget's visual structure in your own markup, never its runtime DOM.** A region produced by a client-side JS library at runtime carries library-specific classes whose styling lives in *that library's own stylesheet*, which the mockup does **not** load — only `branding.css` is injected, so copying the generated markup renders unstyled and collapsed. Author the region yourself from the project's own framework classes (ones that appear in `branding.css`) plus inline styles, **reproducing what the real widget shows at the same structure and density** — the same layout type, the same axes/columns/cells, populated as the widget populates them. Changing the widget's structure is a fidelity failure, not a simplification. The tell: if you're about to emit classes that exist in neither `branding.css` nor the source template, you're copying a widget's runtime DOM — stop and author the region yourself. **The region reproduces the widget's full chrome inventory, not a simplified sketch of it.** When the primary view mounts a full JS-runtime app (a block/rich-text editor, a builder, a large embedded widget), the stand-in carries that app's real chrome — its top toolbar with its real controls, its side panels with their real tab labels and sections. **When the step's matched `layouts[]` entry records `runtime_chrome`, its `regions` are the completeness checklist**: render every region in its recorded visual order with the controls its `items` name, using the `ui_strings` verbatim as the visible labels (they are the widget's real strings, resolved at detect time — the lint checks a sample of them appear). Lay the mockup out as the recipe, mechanically — the regions in recorded order ARE the `<body>` skeleton:
   ```
   <body class="…the claimed layout's root_classes.body…">
     <div data-rtfm-region="toolbar" data-rtfm-placement="top" ...region 1: e.g. the header toolbar — every item, ui_strings verbatim...>
     <div style="display:flex">
       <div data-rtfm-region="sidebar" data-rtfm-placement="left" ...side region(s) in recorded order: sidebar/panel with its items...>
       <div data-rtfm-region="canvas" data-rtfm-placement="canvas" ...content canvas region: filled per the step's depicted_state, real values mid-change...>
     </div>
   </body>
   ```
   Put `data-rtfm-state="<runtime_state_id>"` on `<body>`. **For schema v3+, `states[].visible_regions` is the exact ordered screen skeleton:** render each named recipe region exactly once with its matching `data-rtfm-region` and `data-rtfm-placement`, and render no other recipe region. For schema v2, render globally required regions plus the state's `required_regions`. In schema v4+, render every ordered structured item as a visible descendant marked exactly once with `data-rtfm-item="<region-id>:<item-id>"`; the marker is an assertion on the real widget/group, never an empty bookkeeping tag. In schema v5, the item's `kind` defines its widget role and every item-level `required_strings` value appears in that widget: do not collapse individually recorded panel rows, group headings, or selection rows into one card. The selected action/confirm state's `context_label` is the toolbar's concrete document/template title, never the generic feature name, and its `canvas_presentation` controls preview size/docking and whether an overlay dims the canvas. State-specific panels have distinct region IDs—do not substitute a document inspector for a styles inspector merely because both occupy the right side. Confirmation panels list only actual changed entities; never invent an unchanged or “no changes” row to fill a recorded group. The step's `depicted_state` and matching `states[].shows` decide which panel is open and what fills the canvas. Treat every region's `appearance` as load-bearing visual evidence (surface tone, density, proportions, borders, and distinctive controls), not optional prose. **The `shows` line is load-bearing evidence, not flavour**: render exactly what it names, WHERE it names it — a "right-side panel listing the changed items" is a populated right-anchored panel over the editing surface, not a centered empty modal; a "framed live preview" is a visibly framed miniature of the real site's content, not a blank canvas. A `content_mode: "populated"` canvas contains the real source-backed anatomy and realistic data, never gray skeleton/placeholder rectangles. Render every path recorded in `representative_assets` as an actual `<img src="{{img:basename}}" data-rtfm-asset="<repo-relative path>">`; `media_expectation` explains whether media is intrinsic to the real view, but a detector-listed representative asset is an exact rendering obligation in either case. Never replace it with a gradient or blank block. Never draw more selection outlines than `max_selected_outlines`, and do not invent selection/debug outlines when the recipe does not name one. **Text in quotes inside a `shows`/item description is verbatim on-screen copy** — render it word-for-word as visible text. Side regions keep their recorded side and a realistic proportional width; the canvas is always the largest region. Author real widgets styled by classes in `branding.css` plus inline styles — the recipe is what to check against, never text to transcribe onto the page. Without a recipe, mine the same inventory yourself from what IS in the repo. Substituting plain native chrome for the runtime app's distinctive chrome fails structure fidelity the same way a dropped sidebar does.

**For a step that opens a modal/dialog, copy the modal's OWN defining source** — its component, template, or partial (whatever file actually contains the modal's markup, per `partials_expanded`) — shown over a dimmed backdrop of the underlying page. Don't author the modal from the parent form/list page alone. The host page stays complete underneath: the screenshot is the host view (its `primary_view`, with every unconditional piece) plus the overlay — an overlay is never a `primary_view` or a screen by itself.

**The screenshot IS the 1480×900 viewport — a browser screenshot on a typical laptop, not a full-page capture.** The renderer captures exactly the viewport; anything below its bottom edge does not exist in the PNG, and a fixed-position modal/backdrop/sticky header covers the frame exactly as it covers a real browser window. A page realistically taller than 900px shows the fold — let it; never condense the whole page to fit. **But the step's SUBJECT must be inside the viewport:** every control/section the step names — its `data-rtfm-action-target` and the evidence strings that anchor it — sits above the fold. When a faithful top-of-page copy would put the target below the fold (a settings section far down a long form, the last rows of a long table), depict the **scrolled state** the real user would see: trim/condense the content ABOVE the target (it scrolled out of view; that is the faithful state) so the target sits fully inside the frame, keeping the fixed chrome where it is. The renderer verifies evidence visibility after capture, and a step whose own subject is clipped out of frame fails regardless of how faithful the markup is.

**Position open overlays explicitly — they don't self-position in a static screenshot.** When a step shows an OPEN overlay (a dropdown/actions menu, popover, tooltip, or modal/dialog), render it in its final on-screen position with your own layout — real apps place these at runtime with JS (Popper/Floating-UI), which does nothing in a static mockup, so an un-positioned overlay collapses, clips, or floats to a corner. Concretely: a **dropdown/menu** appears fully visible directly below/beside its trigger with a high `z-index`, and must NOT sit inside an `overflow-hidden`/clipped ancestor (lift it out or drop the clip so it isn't sliced); a **modal/dialog** is centered in a full-viewport `position:fixed; inset:0; display:flex; align-items:center; justify-content:center` container over a dimmed backdrop (`background: rgba(0,0,0,.4)`), with its confirm button filled. If an open overlay renders clipped, off-center, or backdrop-less, it fails realism.

**Keep decorative backgrounds subtle — never let a backdrop read as content or broken UI.** If the source page has a decorative layer behind the focal content, reproduce it *very* low-contrast — low opacity (~5–10%), no solid fills or visible borders on the individual elements — so it recedes. Reproducing it subtly matches the real page; the failure to avoid is rendering it *prominently* (visibly bordered/filled gray boxes that read as broken empty placeholders), not reproducing it at all. The focal UI (the form/card/content the step is about) must clearly dominate. Omit the backdrop only if you genuinely cannot make it recede.

**Handling a lint rejection.** The fidelity lint fails when a mockup contains a colour, CSS class, or text string that doesn't appear in `branding.css` or the step's source files. **The fix is always in the mockup, never in the tool** — do not read, grep, or reverse-engineer the lint script's source; just comply with the error. For each flagged item, edit the named `step_N.html` to replace it with the nearest value that *does* appear in `branding.css` or the source files (an existing brand token or a plain neutral grey for a colour; the real class from the template for a class), or remove it if it isn't load-bearing. Fix, re-run once, move on — don't iterate more than twice.

### Terminal mockup contract (terminal projects ONLY — replaces the web rules above)

`app_type: "terminal"` projects author every mockup under the Terminal mockup contract, which lives in **`${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/generate-illustrated-article/contracts/terminal.md`** — `Read` that file in full before authoring the first mockup and follow it as if it were printed here (it replaces the web rules above; its pre-render self-check is mandatory per step, and Phase 4 re-checks the same items on the rendered PNG). Every other project type skips this file.

### Mobile mockup contract (mobile projects ONLY — replaces the web rules above)

`app_type: "mobile"` projects author every mockup under the Mobile mockup contract, which lives in **`${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/generate-illustrated-article/contracts/mobile.md`** — `Read` that file in full before authoring the first mockup and follow it as if it were printed here (it replaces the web rules above; its pre-render self-check is mandatory per step, and Phase 4 re-checks the same items on the rendered PNG). Every other project type skips this file.

### Desktop mockup contract (desktop projects ONLY — supplements the web rules above)

`app_type: "desktop"` projects author every mockup under the Desktop mockup contract, which lives in **`${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/generate-illustrated-article/contracts/desktop.md`** — `Read` that file in full before authoring the first mockup and follow it as if it were printed here (it supplements the web rules above; its pre-render self-check is mandatory per step, and Phase 4 re-checks the same items on the rendered PNG). Every other project type skips this file.

### Win32 mockup contract (win32 projects ONLY — replaces the web rules above)

`app_type: "win32"` projects author every mockup under the Win32 mockup contract, which lives in **`${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/generate-illustrated-article/contracts/win32.md`** — `Read` that file in full before authoring the first mockup and follow it as if it were printed here (it replaces the web rules above; its pre-render self-check is mandatory per step, and Phase 4 re-checks the same items on the rendered PNG). Every other project type skips this file.

### Macos mockup contract (macos projects ONLY — replaces the web rules above)

`app_type: "macos"` projects author every mockup under the Macos mockup contract, which lives in **`${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/generate-illustrated-article/contracts/macos.md`** — `Read` that file in full before authoring the first mockup and follow it as if it were printed here (it replaces the web rules above; its pre-render self-check is mandatory per step, and Phase 4 re-checks the same items on the rendered PNG). Every other project type skips this file.

### Game mockup contract (game projects ONLY — wraps the web rules above)

`app_type: "game"` projects author every mockup under the Game mockup contract, which lives in **`${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/generate-illustrated-article/contracts/game.md`** — `Read` that file in full before authoring the first mockup and follow it as if it were printed here (it wraps the web rules above; its pre-render self-check is mandatory per step, and Phase 4 re-checks the same items on the rendered PNG). Every other project type skips this file.

```bash
# (run from the target repo root, with $OUT = ./output/articles/<slug>)
BRAND_DIR="./.rtfm"; [ -f "$BRAND_DIR/branding.json" ] || BRAND_DIR="./.rtfm-branding"
[ -f "$BRAND_DIR/branding.css" ] && cp "$BRAND_DIR/branding.css" "$OUT/branding.css" 2>/dev/null || true
# inject_assets also runs the render-time JIT (jit_mockup_css.js) itself when the
# project has a cached css_build recipe — locally compiling the mockups' own classes
# into $OUT/mockup.css and dropping the flaky Tailwind Play CDN. Nothing extra to do.
GENERATED_ARGS=(); [ -f "$OUT/generated_images.json" ] && GENERATED_ARGS=(--generated-images "$OUT/generated_images.json")
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/generate-illustrated-article/scripts/inject_assets.js "$OUT" "" ./.rtfm/images_base64.json --branding "$BRAND_DIR/branding.json" "${GENERATED_ARGS[@]}"
# SCREENSHOT LIMIT: if the `max_images` argument was provided, prefix this lint call with
# RTFM_MAX_IMAGES=<max_images> (as for RTFM_POLISH below); otherwise run it unchanged.
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/generate-illustrated-article/scripts/lint_mockup_fidelity.js "$OUT" "." || { echo "lint failed — fix the offending block_<id>.html ONCE and re-run this block"; }
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/generate-illustrated-article/scripts/lint_article_copy.js "$OUT" "." || { echo "copy lint failed — fix article.json ONCE and re-run this block"; }
for html in "$OUT"/block_*.html "$OUT"/step_*.html; do [ -f "$html" ] || continue; n=$(basename "$html" .html); node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/generate-illustrated-article/scripts/validate_html.js "$html" > "$OUT/${n}_validation.json" 2>&1 || true; done
# WATERMARK: if the `watermark` argument was provided, add its literal value as an
# RTFM_WATERMARK prefix on the render call, i.e.
#   RTFM_WATERMARK=<watermark> node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/generate-illustrated-article/scripts/render_all.js "$OUT"
# If no watermark arg was given, run the call UNCHANGED — a headless caller's exported
# RTFM_WATERMARK, or the default (on), then applies.
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/generate-illustrated-article/scripts/render_all.js "$OUT" || echo "(render_all failed)"
```

Then continue with **Phase 4 — POLISH** below. Do not stop here: the article is not finished until the Phase 4 closing block has run (it also emits the walkthrough-signals sidecar).

## Phase 4 — POLISH: look at every screenshot, compare it with its sources, add what is missing

Phase 3 authored the mockups from source and every gate so far read text; nobody has looked at the PNGs. This phase does. `polish_tickets.js` turns the signals no text check can act on — the lint's per-block metrics, each block's render diagnostics (render score, evidence visibility, and the render-time **visibility probe** of the shell's labels: a sidebar copied faithfully from source can pass every lint and still paint 0 px at the capture width), the project map's `app_shell` / `layouts[].chrome`, and the block's own source files — into per-block **questions**. A ticket is where to look, never text to transcribe: you answer each question by reading the PNG and the named files, then repair by ADDING what the real screen shows and the screenshot lacks.

```bash
# (run from the target repo root, with $OUT = ./output/articles/<slug>)
# POLISH GATE: if the `polish` argument was provided, add its literal value as an
# RTFM_POLISH prefix on THIS call only, i.e.
#   RTFM_POLISH=<polish> node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/generate-illustrated-article/scripts/polish_tickets.js "$OUT" "." --restore
# If no polish arg was given, run the call UNCHANGED — a headless caller's exported
# RTFM_POLISH, or the default (on), then applies. `polish=only` counts as on.
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/generate-illustrated-article/scripts/polish_tickets.js "$OUT" "." --restore
```

It writes `$OUT/polish_tickets.json` and prints one line per ticketed block (`Read <png>, then <sources>`), then either `POLISH: nothing to do` (disabled, or no block earned a question — go straight to the closing block) or `POLISH: N block(s) need a second look`. `--restore` puts each ticketed block's RAW authored HTML back (`<!-- INJECT_CSS -->` marker and `{{img:…}}` placeholders intact, from its `.html.pre`) so you edit what you authored and `render_ready.js` re-injects it; a block without a `.pre` is edited as it is.

For each entry in `polish_tickets.json` → `blocks` (already ordered worst-first), in order:

1. **Look first.** `Read` the block's `png` — you are checking the screenshot, not the HTML. Then `Read` every file in `sources.read_order` (the primary view, the matched layout, its chrome files, then the partials). Do not skip the PNG: the point of this phase is what the render shows.
2. **Answer every question, `blocking` first.** Each question names what a deterministic check could not see and where to look; it is not a list of strings to paste in. For each one ask: does the PNG show it? If the real screen shows it in this block's `depicted_state`, it is missing — note what to add. If the surface genuinely lacks it in this state (a fullscreen editor has no admin sidebar; a modal step shows the modal, not the list's toolbar; a source label belongs to another branch), say so and move on. Finish with the `compare` question: list what the real screen shows that the PNG does not — regions, rows and their columns, controls, labels, badges, footers.
3. **Repair by ADDING, never by rewriting.** Edit the block's `html` and add the missing regions, rows, columns, controls, and labels as real widgets copied from the source markup (verbatim copy, classes that exist in `branding.css`/`mockup.css`, inline `style=` for layout only, inline-SVG icons). Keep everything else byte-identical: every `data-rtfm-*` marker, the `<html>`/`<body>` classes, the action-ready state, the `depicted_state`, the chrome that is already there. Never restyle, reorder, delete, or re-author a region that already exists. A region that IS in the HTML but paints 0 px (`shell_not_painting`, `evidence_invisible`, `action_target_invisible`) is made **visible**, not re-created: drop the responsive `hidden` class, give a fixed/absolute sidebar an in-flow width the content respects, move the clipped control into frame. At most `budget.max_edits` edits per block; if a full repair needs more, add the largest regions first and say what you left.
4. **Self-check** the repaired block against the same pre-render self-check as Phase 3 (shell first, root classes, every recorded shell item, every action target visible and marked, `depicted_state` still true). Where you opened a file that was not in `partials_expanded`, add it; where you added a real string worth citing, add it to that block's `verbatim_evidence` in `view_sources.json`.
5. **Re-publish immediately**: `node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/generate-illustrated-article/scripts/render_ready.js "$OUT" <id> "."` (the block id, or the step index in legacy `step_N` runs), then `Read` the new PNG once and confirm the additions paint. A POOR render or an invisible-evidence STOP is fixed ONCE on that block and re-run — never move on with a broken render, and never revert the polish to make a gate pass.
6. **Record the outcome** for the summary: per block, either "nothing missing" or the list of what you added.

Blocks listed under `skipped` (external surface, no PNG, over the block cap) are not polished. Do not polish a block twice and do not re-run `polish_tickets.js` after editing — the closing block's `--report` is the second look.

```bash
# (run from the target repo root, with $OUT = ./output/articles/<slug>)
# Closing block — always run, polished or not. When blocks were polished, re-run the
# whole-article gate ONCE over the repaired set (identical to the Phase 3 post-process
# block: inject → lints → validation → render_all); a lint failure is fixed the Phase 3
# way (edit the offending block ONCE, re-run this block), never by reverting the polish.
POLISHED=$(node -e 'try{const t=JSON.parse(require("fs").readFileSync(process.argv[1]+"/polish_tickets.json","utf8"));console.log(t.enabled&&t.blocks.length?"yes":"no")}catch{console.log("no")}' "$OUT")
if [ "$POLISHED" = "yes" ]; then
  BRAND_DIR="./.rtfm"; [ -f "$BRAND_DIR/branding.json" ] || BRAND_DIR="./.rtfm-branding"
  GENERATED_ARGS=(); [ -f "$OUT/generated_images.json" ] && GENERATED_ARGS=(--generated-images "$OUT/generated_images.json")
  node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/generate-illustrated-article/scripts/inject_assets.js "$OUT" "" ./.rtfm/images_base64.json --branding "$BRAND_DIR/branding.json" "${GENERATED_ARGS[@]}"
  # Same RTFM_MAX_IMAGES=<max_images> prefix as the first lint call when the argument was provided.
  node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/generate-illustrated-article/scripts/lint_mockup_fidelity.js "$OUT" "." || { echo "lint failed — fix the offending block_<id>.html ONCE and re-run this block"; }
  node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/generate-illustrated-article/scripts/lint_article_copy.js "$OUT" "." || { echo "copy lint failed — fix article.json ONCE and re-run this block"; }
  for html in "$OUT"/block_*.html "$OUT"/step_*.html; do [ -f "$html" ] || continue; n=$(basename "$html" .html); node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/generate-illustrated-article/scripts/validate_html.js "$html" > "$OUT/${n}_validation.json" 2>&1 || true; done
  # Same WATERMARK prefix rule as the Phase 3 render call.
  node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/generate-illustrated-article/scripts/render_all.js "$OUT" || echo "(render_all failed)"
fi
# Second look: which questions the re-lint / fresh diagnostics now answer, and which PNGs changed.
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/generate-illustrated-article/scripts/polish_tickets.js "$OUT" "." --report
# Walkthrough-worthiness signals sidecar (informational — never fails the pipeline).
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/generate-illustrated-article/scripts/emit_walkthrough_signals.js "$OUT" || true
```

## When done

Remove the run-trace marker: `rm -f ./.rtfm-trace/CURRENT`.

Print a one-paragraph summary: the output directory, how many section blocks you illustrated and why, the number of PNGs rendered, any render-quality warnings, and the polish outcome — per polished block either "nothing missing" or what you added, plus the `polish:` totals line from the report (questions resolved, PNGs changed), or "polish disabled". The ordered prose and screenshots were produced together in one session.
