#!/usr/bin/env node
'use strict';

// Deterministically enrich well-known runtime applications whose built UI is
// not present in the checkout. Profiles provide stable chrome anatomy; repo
// evidence still supplies the active/default content, labels, and assets.
//
// Usage:
//   node apply_runtime_profiles.js <project_map.json> <project_dir> [--json report.json]

const fs = require('fs');
const path = require('path');

function fail(message) {
    console.error(`ERROR: ${message}`);
    process.exit(2);
}

const [mapArg, projectArg] = process.argv.slice(2);
const jsonIndex = process.argv.indexOf('--json');
const reportArg = jsonIndex >= 0 ? process.argv[jsonIndex + 1] : null;
if (!mapArg || !projectArg) fail('usage: apply_runtime_profiles.js <project_map.json> <project_dir> [--json report.json]');

const mapPath = path.resolve(mapArg);
const projectDir = path.resolve(projectArg);
let projectMap;
try {
    projectMap = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
} catch (error) {
    fail(`cannot read project map: ${error.message}`);
}

function relFile(rel) {
    if (typeof rel !== 'string' || !rel.trim()) return null;
    const clean = rel.replace(/^\.\//, '').split(/[?#]/, 1)[0];
    const absolute = path.resolve(projectDir, clean);
    const root = `${projectDir}${path.sep}`;
    if (!absolute.startsWith(root)) return null;
    try {
        if (!fs.statSync(absolute).isFile()) return null;
    } catch (_) {
        return null;
    }
    return path.relative(projectDir, absolute).split(path.sep).join('/');
}

function read(rel) {
    const file = relFile(rel);
    if (!file) return '';
    try { return fs.readFileSync(path.join(projectDir, file), 'utf8'); } catch (_) { return ''; }
}

function existing(values) {
    return [...new Set(values.map(relFile).filter(Boolean))];
}

function titleFromSlug(slug) {
    return String(slug || '').split(/[-_]/).filter(Boolean)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function profileWordPressSiteEditor() {
    const mount = relFile('src/wp-admin/site-editor.php');
    if (!mount) return null;
    const layouts = Array.isArray(projectMap.layouts) ? projectMap.layouts : [];
    let layout = layouts.find(item => item && (
        relFile(item.path) === mount || item.name === 'site-editor'
        || /site editor/i.test(String(item.area || ''))));
    if (!layout) {
        layout = { name: 'site-editor', path: mount, area: 'WordPress Site Editor', chrome: [] };
        layouts.push(layout);
        projectMap.layouts = layouts;
    }

    const constants = read('src/wp-includes/default-constants.php');
    const themeSlug = (constants.match(/define\(\s*['"]WP_DEFAULT_THEME['"]\s*,\s*['"]([^'"]+)['"]\s*\)/) || [])[1];
    if (!themeSlug) return { id: 'wordpress-site-editor', applied: false, reason: 'WP_DEFAULT_THEME was not resolved' };
    const themeRoot = `src/wp-content/themes/${themeSlug}`;
    const home = relFile(`${themeRoot}/templates/home.html`);
    if (!home) return { id: 'wordpress-site-editor', applied: false, reason: `default theme ${themeSlug} has no templates/home.html` };

    const style = read(`${themeRoot}/style.css`);
    const themeName = ((style.match(/^\s*Theme Name:\s*(.+?)\s*$/mi) || [])[1] || titleFromSlug(themeSlug)).trim();
    const templateUtils = relFile('src/wp-includes/block-template-utils.php');
    const templateUtilsText = read('src/wp-includes/block-template-utils.php');
    const homeTemplateBlock = (templateUtilsText.match(/['"]home['"]\s*=>\s*array\s*\([\s\S]{0,1600}?\n\s*\),/) || [])[0] || '';
    const templateTitle = ((homeTemplateBlock.match(/['"]title['"]\s*=>\s*_x\(\s*['"]([^'"]+)['"]\s*,\s*['"]Template name['"]/) || [])[1] || 'Blog Home').trim();
    const templateDescription = ((homeTemplateBlock.match(/['"]description['"]\s*=>\s*__\(\s*['"]([^'"]*latest posts[^'"]*)['"]/) || [])[1]
        || 'Displays the latest posts').trim();

    const themeSources = existing([
        `${themeRoot}/templates/home.html`,
        `${themeRoot}/parts/header.html`,
        `${themeRoot}/parts/footer.html`,
        `${themeRoot}/patterns/header.php`,
        `${themeRoot}/patterns/footer.php`,
        `${themeRoot}/patterns/hidden-blog-heading.php`,
        `${themeRoot}/patterns/template-query-loop.php`,
        `${themeRoot}/theme.json`,
        'src/wp-includes/block-template-utils.php',
    ]);
    const canvasSources = existing([
        `${themeRoot}/templates/home.html`,
        `${themeRoot}/parts/header.html`,
        `${themeRoot}/parts/footer.html`,
        `${themeRoot}/patterns/header.php`,
        `${themeRoot}/patterns/footer.php`,
        `${themeRoot}/patterns/template-query-loop.php`,
    ]);
    const preferredAssets = existing([
        `${themeRoot}/assets/images/botany-flowers.webp`,
        `${themeRoot}/assets/images/category-sunflowers.webp`,
    ]);
    if (!preferredAssets.length) {
        const assetRoot = path.join(projectDir, themeRoot, 'assets/images');
        try {
            for (const name of fs.readdirSync(assetRoot).sort()) {
                const asset = relFile(`${themeRoot}/assets/images/${name}`);
                if (asset && /\.(?:avif|jpe?g|png|webp)$/i.test(asset)) preferredAssets.push(asset);
                if (preferredAssets.length === 2) break;
            }
        } catch (_) { /* an image-free theme is valid */ }
    }

    const chromeSource = [mount];
    const contentSources = existing([...canvasSources, templateUtils]);
    const stateSources = existing([...contentSources]);
    layout.name = 'site-editor';
    layout.path = mount;
    layout.area = 'site editor (Appearance > Editor) for block themes; fullscreen runtime app with no classic admin menu or toolbar';
    layout.chrome = [];
    layout.root_classes = {
        html: [],
        body: ['wp-admin', 'wp-core-ui', 'js', 'site-editor-php', 'is-fullscreen-mode', 'admin-color-modern'],
    };
    layout.runtime_chrome = {
        app: 'WordPress Site Editor (Gutenberg @wordpress/edit-site app)',
        mode_note: 'Always fullscreen: the runtime app replaces the classic admin menu and toolbar with its own editor chrome.',
        source_kind: 'knowledge',
        source: 'Stable Gutenberg Site Editor chrome profile, grounded to the repo mount, default-theme template chain, core template metadata, and bundled theme assets because the built @wordpress/edit-site package is not committed in this source checkout.',
        source_files: chromeSource,
        regions: [
            {
                id: 'navigation', region: 'design navigation sidebar', placement: 'left', required: false,
                appearance: 'dark #1e1e1e sidebar occupying about one quarter of the viewport on a matching dark workspace; compact unboxed rows with chevrons beside a floating white framed site preview',
                items: [
                    { id: 'identity', kind: 'identity', description: 'site icon, concrete site title, and back-to-dashboard affordance', required_strings: [] },
                    { id: 'destinations', kind: 'navigation-list', description: 'complete ordered design destinations with chevrons', required_strings: ['Navigation', 'Styles', 'Pages', 'Templates', 'Patterns'] },
                ],
                ui_strings: ['Design', 'Navigation', 'Styles', 'Pages', 'Templates', 'Patterns'],
                required_strings: ['Styles', 'Templates', 'Patterns'], source_files: chromeSource,
            },
            {
                id: 'toolbar', region: 'editing toolbar', placement: 'top', required: false,
                appearance: 'light compact full-width Gutenberg toolbar with the WordPress W identity at left, complete icon tool groups, centered document context, and blue Save action at right',
                items: [
                    { id: 'back-identity', kind: 'identity', description: 'WordPress W identity button returning to the Site Editor', required_strings: [] },
                    { id: 'inserter-tools', kind: 'control-group', description: 'block inserter plus editing-mode/tools controls', required_strings: [] },
                    { id: 'history-tools', kind: 'control-group', description: 'undo and redo icon controls', required_strings: [] },
                    { id: 'document-overview', kind: 'control-group', description: 'document overview and list-view icon controls', required_strings: [] },
                    { id: 'document-title', kind: 'document-context', description: `open template title (${templateTitle}), never a generic feature name`, required_strings: [templateTitle] },
                    { id: 'view-options', kind: 'control-group', description: 'preview/device, settings, styles, and more-options icon controls', required_strings: [] },
                    { id: 'primary-action', kind: 'primary-action', description: 'emphasized blue primary Save action', required_strings: ['Save'] },
                ],
                ui_strings: ['Save', templateTitle], required_strings: ['Save', templateTitle], source_files: chromeSource,
            },
            {
                id: 'canvas', region: 'site preview and editing canvas', placement: 'canvas', required: true,
                appearance: `largest white #fff region rendering the ${themeName} ${templateTitle} template with a real header, populated post query, imagery, and footer; never a blank card or skeleton`,
                content_mode: 'populated', media_expectation: preferredAssets.length ? 'required' : 'optional',
                max_selected_outlines: 1, representative_assets: preferredAssets,
                items: [
                    { id: 'header', kind: 'content-section', description: 'real site header template part with site title at left and horizontal navigation at right', required_strings: [] },
                    { id: 'main-content', kind: 'content-section', description: 'populated recent-post query loop with heading, image, title, excerpt, and date', required_strings: [] },
                    { id: 'footer', kind: 'content-section', description: 'real footer template part with the WordPress credit', required_strings: ['Designed with WordPress'] },
                ],
                ui_strings: ['Designed with WordPress'], required_strings: ['Designed with WordPress'], source_files: canvasSources,
            },
            {
                id: 'styles-inspector', region: 'styles inspector', placement: 'right', required: false,
                appearance: 'light right sidebar separated from the white canvas by a border; Styles heading, Aa and colour-dot preview tile, then flat icon rows rather than generic cards',
                items: [
                    { id: 'heading-tools', kind: 'panel-heading', description: 'Styles heading with revisions and style-book tools', required_strings: ['Styles'] },
                    { id: 'style-preview', kind: 'visual-preview', description: 'large Aa typography preview with the active palette shown as colour dots', required_strings: ['Aa'] },
                    { id: 'browse-styles', kind: 'action-card', description: 'style variation browser row', required_strings: ['Browse styles'] },
                    { id: 'typography', kind: 'panel-row', description: 'Typography settings row with its icon and chevron', required_strings: ['Typography'] },
                    { id: 'colors', kind: 'panel-row', description: 'Colors settings row with its icon and chevron', required_strings: ['Colors'] },
                    { id: 'background', kind: 'panel-row', description: 'Background settings row with its icon and chevron', required_strings: ['Background'] },
                    { id: 'shadows', kind: 'panel-row', description: 'Shadows settings row with its icon and chevron', required_strings: ['Shadows'] },
                    { id: 'layout', kind: 'panel-row', description: 'Layout settings row with its icon and chevron', required_strings: ['Layout'] },
                ],
                ui_strings: ['Styles', 'Aa', 'Browse styles', 'Typography', 'Colors', 'Background', 'Shadows', 'Layout'],
                required_strings: ['Styles', 'Aa', 'Browse styles', 'Typography', 'Colors'], source_files: chromeSource,
            },
            {
                id: 'template-inspector', region: 'template inspector', placement: 'right', required: false,
                appearance: 'light right sidebar separated from the canvas by a border; Template and Block tabs above template summary and area rows',
                items: [
                    { id: 'tabs', kind: 'tabs', description: 'Template and Block inspector tabs', required_strings: ['Template', 'Block'] },
                    { id: 'template-summary', kind: 'settings-list', description: `${templateTitle} template name and its source-backed description`, required_strings: [templateTitle, 'Displays the latest posts'] },
                    { id: 'header-area', kind: 'panel-row', description: 'Header template-part area row', required_strings: ['Header'] },
                    { id: 'footer-area', kind: 'panel-row', description: 'Footer template-part area row', required_strings: ['Footer'] },
                ],
                ui_strings: ['Template', 'Block', templateTitle, 'Header', 'Footer'], required_strings: ['Template', 'Block', templateTitle],
                source_files: existing([mount, templateUtils]),
            },
            {
                id: 'confirm', region: 'save confirmation panel', placement: 'overlay-right', required: false,
                appearance: 'light right-side panel over the still-visible undimmed editing canvas; heading, explanatory copy, grouped checked entity rows, and actions anchored at the bottom',
                items: [
                    { id: 'heading-close', kind: 'panel-heading', description: 'confirmation heading and close affordance', required_strings: ['Are you ready to save?'] },
                    { id: 'explanation', kind: 'supporting-copy', description: 'explanation of the pending changes', required_strings: ['The following changes have been made to your site, templates, and content.'] },
                    { id: 'styles-group', kind: 'group-heading', description: 'Styles entity group heading', required_strings: ['Styles'] },
                    { id: 'styles-change', kind: 'selection-row', description: 'checked row for the edited global styles and concrete theme name', required_strings: [themeName] },
                    { id: 'templates-group', kind: 'group-heading', description: 'Templates entity group heading', required_strings: ['Templates'] },
                    { id: 'template-change', kind: 'selection-row', description: `checked row for ${templateTitle} with its template description`, required_strings: [templateTitle, 'Displays the latest posts'] },
                    { id: 'footer-actions', kind: 'actions', description: 'anchored secondary Cancel and blue primary Save actions', required_strings: ['Cancel', 'Save'] },
                ],
                ui_strings: ['Are you ready to save?', 'Styles', themeName, 'Templates', templateTitle, 'Displays the latest posts', 'Cancel', 'Save'],
                required_strings: ['Are you ready to save?', themeName, templateTitle, 'Cancel', 'Save'], source_files: chromeSource,
            },
        ],
        states: [
            {
                id: 'overview', name: 'overview', kind: 'overview', topic_tags: ['open', 'navigate', 'site editor', 'design'],
                instructional_priority: 'orientation', screenshot_required: false,
                canvas_presentation: 'dark full-height workspace with the near-black Design navigation at left and a large floating white framed live site preview',
                entered_by: 'open Appearance > Editor in wp-admin',
                shows: `dark Design navigation beside a populated scaled preview of the ${templateTitle} template`,
                visible_regions: ['navigation', 'canvas'], required_regions: [],
                required_strings: ['Styles', 'Templates', 'Designed with WordPress'], source_files: stateSources,
            },
            {
                id: 'styles-editing', name: 'editing visual styles', kind: 'action', topic_tags: ['styles', 'design', 'colors', 'typography'],
                instructional_priority: 'primary-action', context_label: templateTitle, screenshot_required: false,
                canvas_presentation: `full white editing canvas showing the populated ${templateTitle} template with style changes previewed live`,
                entered_by: 'choose Styles in the Design navigation',
                shows: `the complete Gutenberg toolbar and Styles inspector, including the Aa palette preview and every settings row, beside the populated ${templateTitle} canvas`,
                visible_regions: ['toolbar', 'canvas', 'styles-inspector'], required_regions: ['toolbar', 'styles-inspector'],
                required_strings: ['Save', templateTitle, 'Aa', 'Browse styles', 'Colors'], source_files: stateSources,
            },
            {
                id: 'template-editing', name: 'editing a template', kind: 'action', topic_tags: ['template', 'layout', 'structure', 'edit'],
                instructional_priority: 'secondary-action', context_label: templateTitle, screenshot_required: false,
                canvas_presentation: `full white editing canvas with the populated ${templateTitle} template open for block-level editing`,
                entered_by: `open Templates in the navigation and choose ${templateTitle}`,
                shows: `the complete Gutenberg toolbar and Template inspector beside the populated ${templateTitle} canvas`,
                visible_regions: ['toolbar', 'canvas', 'template-inspector'], required_regions: ['toolbar', 'template-inspector'],
                required_strings: ['Save', templateTitle, 'Template', 'Block'], source_files: stateSources,
            },
            {
                id: 'confirm-save', name: 'confirm save', kind: 'confirm', topic_tags: ['save', 'confirm', 'apply changes'],
                instructional_priority: 'terminal-action', context_label: templateTitle, screenshot_required: true,
                canvas_presentation: 'the preceding populated white editing canvas and complete toolbar remain undimmed and visible beneath the right-side save panel',
                entered_by: 'press Save in the toolbar',
                shows: `the save panel with explanatory copy, checked Styles/${themeName} and Templates/${templateTitle} groups, template subtitle, Cancel, and Save`,
                visible_regions: ['toolbar', 'canvas', 'confirm'], required_regions: ['confirm'],
                required_strings: [templateTitle, 'Are you ready to save?', themeName, 'Displays the latest posts', 'Cancel', 'Save'], source_files: stateSources,
            },
        ],
    };

    const routes = projectMap.route_index && typeof projectMap.route_index === 'object' ? projectMap.route_index : {};
    let routeKey = Object.keys(routes).find(key => {
        const route = routes[key];
        return route && (route.path === '/wp-admin/site-editor.php' || relFile(route.primary_view) === mount || key === 'site-editor');
    });
    if (!routeKey) routeKey = 'site-editor';
    routes[routeKey] = {
        ...(routes[routeKey] || {}), method: 'GET', path: '/wp-admin/site-editor.php',
        controller: mount, primary_view: mount, layout: 'site-editor', controller_action: mount,
        partials_expanded: themeSources,
    };
    projectMap.route_index = routes;

    const assumptions = new Set(Array.isArray(projectMap.default_user_assumptions)
        ? projectMap.default_user_assumptions.filter(value => typeof value === 'string') : []);
    assumptions.add('JavaScript enabled: no-JS fallback notices never render');
    assumptions.add('No plugins active, so plugin-registered editor panels, notices, and patterns do not render');
    assumptions.add(`Default ${themeName} block theme active on a single-site, non-multisite install`);
    projectMap.default_user_assumptions = [...assumptions];

    return {
        id: 'wordpress-site-editor', applied: true, layout: 'site-editor', mount,
        theme_slug: themeSlug, theme_name: themeName, template_title: templateTitle,
        route_sources: themeSources.length, canvas_sources: canvasSources.length,
        representative_assets: preferredAssets,
    };
}

const profiles = [profileWordPressSiteEditor];
const results = profiles.map(profile => profile()).filter(Boolean);
if (results.some(item => item && item.id === 'wordpress-site-editor' && item.applied)) {
    for (const layout of Array.isArray(projectMap.layouts) ? projectMap.layouts : []) {
        if (!layout || !layout.runtime_chrome || !layout.root_classes) continue;
        const mode = `${layout.area || ''} ${layout.runtime_chrome.mode_note || ''}`;
        if (!/fullscreen|full-screen|(?:menu|toolbar|admin bar)[^.;]{0,30}hidden/i.test(mode)) continue;
        const html = Array.isArray(layout.root_classes.html) ? layout.root_classes.html : [];
        layout.root_classes.html = html.filter(token => !/^(?:wp-)?toolbar$|admin-?bar/i.test(token));
    }
}
fs.writeFileSync(mapPath, `${JSON.stringify(projectMap, null, 2)}\n`);
const report = { checked: true, applied: results.filter(item => item.applied), skipped: results.filter(item => !item.applied) };
if (reportArg) {
    const reportPath = path.resolve(reportArg);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}
if (report.applied.length) {
    console.log(`Runtime profiles: applied ${report.applied.map(item => item.id).join(', ')}`);
} else {
    console.log('Runtime profiles: no matching profile');
}
