// Shared source grounding for literal labels and a deliberately small Rails subset.
// No application code is executed, and free-text derivations are never evidence.
const fs = require('fs');
const path = require('path');
const { resolveSourcePath } = require('./source_paths.js');
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const uncomment = s => s.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
// Project-relative, or ../<repo>/<path> into a related repository (source_paths.js).
function source(root, file) {
    return fs.readFileSync(resolveSourcePath(root, file), 'utf8');
}
function filesBelow(root, dir) {
    const at = path.join(root, dir);
    if (!fs.existsSync(at)) return [];
    return fs.readdirSync(at, { withFileTypes: true }).flatMap(item => {
        if (item.isSymbolicLink()) throw Error('symlinked locale/config files need a runtime resolver');
        const file = path.join(dir, item.name);
        return item.isDirectory() ? filesBelow(root, file) : [file];
    });
}
function railsSubmit(root, entry) {
    const g = entry.generated;
    if (g.kind !== 'rails_submit' || g.locale !== 'en' || !['create', 'update'].includes(g.action)) throw Error('supported generated evidence is rails_submit with locale en and action create/update');
    if (!/^@[a-z][a-z0-9_]*$/.test(g.binding || '')) throw Error('cite the form model instance variable as binding');
    const template = source(root, entry.found_in).replace(/<%#[\s\S]*?%>/g, '');
    const forms = [...template.matchAll(/<%=\s*form_with\s*\(?([\s\S]*?)\s+do\s+\|(\w+)\|\s*%>/g)];
    if (forms.length !== 1 || !new RegExp(`\\bmodel:\\s*${escape(g.binding)}(?=\\s*[,)]|\\s*$)`).test(forms[0][1]) || /\b(?:builder|scope):/.test(forms[0][1])) throw Error('cite a single form_with bound to this model, without a custom builder or scope');
    const builder = escape(forms[0][2]);
    const submits = [...template.matchAll(new RegExp(`<%=\\s*${builder}\\.submit\\b([\\s\\S]*?)%>`, 'g'))];
    // Only no argument or a literal CSS class: reject explicit labels, value overrides and dynamic options.
    if (submits.length !== 1 || !/^\s*(?:class:\s*(?:"[^"\n]*"|'[^'\n]*'))?\s*$/.test(submits[0][1]) || submits[0].index < forms[0].index) throw Error('cite a default submit helper with no explicit label or dynamic options');
    const model = uncomment(source(root, g.model_source));
    const declaration = model.match(/^\s*class\s+([A-Z]\w*)\s*<\s*(?:ApplicationRecord|ActiveRecord::Base)\s*$/m);
    if (!declaration || /\b(?:def|delegate|define_method|include|extend|prepend)\b|\b(?:model_name|human_attribute_name|persisted\?|i18n_scope)\b/.test(model)) throw Error('custom model behavior needs a runtime resolver');
    const name = declaration[1];
    const bindings = uncomment(source(root, g.binding_source));
    const assignments = [...bindings.matchAll(new RegExp(`^\\s*${escape(g.binding)}\\s*=(?!=)\\s*([^\\n]+)`, 'gm'))];
    if (assignments.length !== 1) throw Error('cite an unambiguous model assignment proving create/update state');
    const assignment = assignments[0][1].trim();
    const expectedAssignment = g.action === 'create'
        ? new RegExp(`^${escape(name)}\\.new(?:\\(.*\\))?\\s*$`)
        : new RegExp(`^${escape(name)}\\.find\\([^\\n]+\\)\\s*$`);
    if (!expectedAssignment.test(assignment)) throw Error('model assignment does not prove the requested create/update state');
    // Refuse custom naming/translation paths rather than guessing Rails runtime behavior.
    const configFiles = ['config/application.rb', ...filesBelow(root, 'config/initializers'), ...filesBelow(root, 'config/environments'), ...filesBelow(root, 'config/locales'), 'app/models/application_record.rb', 'app/controllers/application_controller.rb', 'app/helpers/application_helper.rb', g.binding_source];
    let inflections = '';
    for (const file of configFiles) {
        if (!fs.existsSync(path.join(root, file))) continue;
        const text = uncomment(source(root, file));
        if (file === 'config/initializers/inflections.rb') { inflections = text; continue; }
        if (/\b(?:helpers\s*[:.]|activerecord\s*:|activemodel\s*:|model_name|i18n_scope|persisted\?|default_form_builder|field_error_proc)|I18n\.|i18n\.(?:default_locale|load_path)|Inflector\.inflections|FormBuilder|def\s+(?:submit|model_name)/.test(text)) throw Error(`custom locale, model naming or form behavior in ${file} needs a runtime resolver; cite a literal translation when available`);
    }
    // Only default inflections plus literal English acronym declarations are supported.
    const acronyms = new Map();
    const remainder = inflections.replace(/ActiveSupport::Inflector\.inflections\(:en\)\s+do\s+\|(\w+)\|([\s\S]*?)\bend\b/g, (_, receiver, body) => {
        const rest = body.replace(new RegExp(`${escape(receiver)}\\.acronym\\s+['"]([A-Za-z]+)['"]`, 'g'), (__, word) => { acronyms.set(word.toLowerCase(), word); return ''; });
        return rest;
    });
    if (remainder.trim()) throw Error('custom inflections need a runtime resolver');
    let underscored = name;
    if (acronyms.size) {
        const pattern = new RegExp(`(?:(?<=([A-Za-z\\d]))|\\b)(${[...acronyms.values()].map(escape).join('|')})(?=\\b|[^a-z])`, 'g');
        underscored = underscored.replace(pattern, (_, prefix, acronym) => `${prefix ? '_' : ''}${acronym.toLowerCase()}`);
    }
    const words = underscored.replace(/([A-Z])(?=[A-Z][a-z])|([a-z\d])(?=[A-Z])/g, (_, upper, lower) => (upper || lower) + '_').toLowerCase().replace(/_id$/, '').split('_');
    let human = words.map(word => acronyms.get(word) || word).join(' ');
    human = human[0].toUpperCase() + human.slice(1);
    const label = `${g.action === 'create' ? 'Create' : 'Update'} ${human}`;
    return label;
}
function verifyLabelEvidence(entry, primary, root) {
    const string = typeof entry === 'string' ? entry : entry && entry.string;
    const file = entry && typeof entry === 'object' && entry.found_in || primary;
    if (typeof string !== 'string' || !string.trim()) return { ok: false, error: 'missing evidence string' };
    try {
        if (entry && entry.generated) {
            const expected = railsSubmit(root, entry);
            return expected === string ? { ok: true, kind: 'generated' } : { ok: false, error: `generated label contradicts source: expected "${expected}", received "${string}"` };
        }
        if (!file) return { ok: true, kind: 'legacy' }; // preserve legacy source-less terminal evidence
        if (source(root, file).includes(string)) return { ok: true, kind: 'literal' };
        return { ok: false, error: `verbatim_evidence "${string}" claimed in ${file} but absent from that file; if generated, supply supported structured generated evidence (a derivation note alone is not verified)` };
    } catch (error) {
        return { ok: false, error: `cannot verify label "${string}": ${error.code ? 'source file unavailable' : error.message}` };
    }
}
module.exports = { verifyLabelEvidence };
