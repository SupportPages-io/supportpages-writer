#!/usr/bin/env node
/**
 * include_census.js — classification of includes by render condition on synthetic views
 * (Rails ERB, JSX, Blade, Django), plus marker extraction. No app-specific fixtures.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { census, includeRefs, extractMarkers } = require('./include_census.js');

function project(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rtfm-census-'));
    for (const [rel, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), text);
    }
    return root;
}
const byName = c => Object.fromEntries(c.includes.map(i => [i.name, i]));

// ── Rails ERB: unconditional partial, guarded partial, overlay partials, inline sections ──
{
    const root = project({
        'app/views/things/new.html.erb': [
            '<%= render partial: "layouts/header" %>',
            '<main>',
            '  <% if @account.premium? %>',
            '    <%= render partial: "partials/upsell", locals: { feature: "x" } %>',
            '  <% end %>',
            '  <h3>Item details</h3>',
            '  <%= f.label :title, "Title (Required)" %>',
            '  <%= f.text_field :title %>',
            '  <h3>Item options</h3>',
            '  <label>Enable alerts</label>',
            '  <% if current_user.admin? %>',
            '  <h3>Admin controls</h3>',
            '  <button>Purge</button>',
            '  <% end %>',
            '  <%= f.submit "Create item" %>',
            '  <%= render partial: "modals/pick_owner_modal", locals: { title: "Pick" } %>',
            '  <%= render partial: "shared/footer_actions" %>',
            '</main>',
        ].join('\n'),
        'app/views/layouts/_header.html.erb': '<nav><a href="/">Home</a><a href="/things">Things</a></nav>',
        'app/views/partials/_upsell.html.erb': '<div><h4>Upgrade to unlock</h4></div>',
        'app/views/modals/_pick_owner_modal.html.erb': '<div class="modal"><h5>Pick an owner</h5><button>Close</button></div>',
        'app/views/shared/_footer_actions.html.erb': '<div><button>Close</button><button>Save and continue</button></div>',
    });
    const c = census(root, 'app/views/things/new.html.erb');
    const inc = byName(c);
    assert.strictEqual(inc['layouts/header'].kind, 'unconditional');
    assert.deepStrictEqual(inc['layouts/header'].markers, ['Home', 'Things']);
    assert.strictEqual(inc['partials/upsell'].kind, 'conditional', 'guarded by the surrounding if');
    assert.strictEqual(inc['modals/pick_owner_modal'].kind, 'overlay', 'modal by name');
    assert.strictEqual(inc['shared/footer_actions'].kind, 'unconditional');
    assert(inc['shared/footer_actions'].markers.includes('Save and continue'));
    const secs = Object.fromEntries(c.inline_sections.map(s => [s.heading, s]));
    assert.strictEqual(secs['Item details'].guarded, false);
    assert(secs['Item details'].markers.includes('Title (Required)'), secs['Item details'].markers);
    assert.strictEqual(secs['Item options'].guarded, false);
    assert.strictEqual(secs['Admin controls'].guarded, true, 'heading directly under an if is guarded');
    fs.rmSync(root, { recursive: true, force: true });
}

// ── JSX: resolved component with markers, ternary-guarded component, Dialog primitive skipped ──
{
    const root = project({
        'src/pages/List.tsx': [
            'import Toolbar from "./Toolbar";',
            'import EmptyState from "./EmptyState";',
            'import { Dialog } from "@ui/dialog";',
            'export default function List({ items }) {',
            '  return (<div>',
            '    <Toolbar />',
            '    {items.length === 0 ? <EmptyState /> : null}',
            '    <Dialog open={false}><p>hidden</p></Dialog>',
            '  </div>);',
            '}',
        ].join('\n'),
        'src/pages/Toolbar.tsx': 'export default () => <div><button>New item</button><input placeholder="Search items" /></div>;',
        'src/pages/EmptyState.tsx': 'export default () => <h2>Nothing here yet</h2>;',
    });
    const c = census(root, 'src/pages/List.tsx');
    const inc = byName(c);
    assert.strictEqual(inc.Toolbar.kind, 'unconditional');
    assert.deepStrictEqual(inc.Toolbar.markers.sort(), ['New item', 'Search items']);
    assert.strictEqual(inc.EmptyState.kind, 'conditional', 'ternary on the same line is a guard');
    assert(!('Dialog' in inc), 'UI primitives are not includes');
    fs.rmSync(root, { recursive: true, force: true });
}

// ── Blade + Django: include syntaxes resolve and classify ──
{
    const root = project({
        'resources/views/orders/show.blade.php': [
            '@include("partials.summary")',
            '@if($order->refundable)',
            '  @include("partials.refund")',
            '@endif',
            '<x-drawer name="notes">…</x-drawer>',
        ].join('\n'),
        'resources/views/partials/summary.blade.php': '<h3>Order summary</h3><th>Total</th>',
        'resources/views/partials/refund.blade.php': '<button>Refund order</button>',
        'templates/reports/index.html': '{% include "reports/_filters.html" %}\n{% if perms.export %}{% include "reports/_export.html" %}{% endif %}',
        'templates/reports/_filters.html': '<label>Date range</label>',
        'templates/reports/_export.html': '<button>Export CSV</button>',
    });
    const b = byName(census(root, 'resources/views/orders/show.blade.php'));
    assert.strictEqual(b['partials.summary'].kind, 'unconditional');
    assert.deepStrictEqual(b['partials.summary'].markers, ['Order summary', 'Total']);
    assert.strictEqual(b['partials.refund'].kind, 'conditional');
    assert.strictEqual(b['x-drawer'].kind, 'overlay');
    const d = byName(census(root, 'templates/reports/index.html'));
    assert.strictEqual(d['reports/_filters.html'].kind, 'unconditional');
    assert.deepStrictEqual(d['reports/_filters.html'].markers, ['Date range']);
    assert.strictEqual(d['reports/_export.html'].kind, 'conditional');
    fs.rmSync(root, { recursive: true, force: true });
}

// ── markers: sentences, templating and identifiers are not markers ──
assert.deepStrictEqual(extractMarkers('<h2>Settings</h2><p>You are not allowed to do this.</p><button>{{ t("x") }}</button><th>createdAt</th><label>Display name</label>'),
    ['Settings', 'Display name']);
assert.deepStrictEqual(includeRefs('/nonexistent-root', 'nope.erb'), []);

console.log('include_census tests passed');
