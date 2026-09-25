# UI label evidence

Keep the exact UI label in `verbatim_evidence` and `action_coverage.target`. Do not remove a target, change the real label, edit application source, or add hidden text to a mockup to satisfy validation.

## Literal labels and translations

Use `{ "string": "Save changes", "found_in": "config/locales/en.yml" }` when the complete label exists in a source or translation file. Paths are relative to the application root. The shared validator checks the cited file and the mockup HTML. A locale key or a writer's explanation is not proof of an interpolated value.

## Default Rails submit labels

For an ERB `form_with(model: @record)` with an unlabeled `form.submit`, use structured evidence:

```json
{
  "string": "Create Invoice",
  "found_in": "app/views/invoices/_form.html.erb",
  "generated": {
    "kind": "rails_submit",
    "locale": "en",
    "action": "create",
    "binding": "@record",
    "binding_source": "app/controllers/invoices_controller.rb",
    "model_source": "app/models/invoice.rb"
  }
}
```

The validator reads the files itself. `binding_source` must contain one unambiguous assignment of the bound variable to `Invoice.new` for `create`, or `Invoice.find(...)` for `update`. The template must contain one `form_with` bound to that variable and one default submit helper (no arguments, or a literal `class:` option). The model must directly inherit from `ApplicationRecord` or `ActiveRecord::Base` without custom behavior. Default English model humanization and literal English acronym declarations in `config/initializers/inflections.rb` are supported.

This is a conservative static resolver, not a Ruby interpreter. Custom builders, dynamic options, ambiguous bindings, custom model naming/inflections and translation overrides are unresolved rather than guessed. An explicit label that disagrees with the verified default is reported as a contradiction. A free-text `derivation` field does not bypass either check.

For unsupported cases, first look for a complete literal label in the application's actual translation/helper sources. If none exists, report the unresolved helper/locale/state and request resolver support or a verified runtime-capture path. Arbitrary screenshots, writer-authored capture JSON, and explanations are not currently accepted as runtime evidence. Do not claim the app's label is wrong merely because the static resolver cannot resolve it.

## Visible controls and accessible names

Render submit/button/reset inputs with their real `value`; the renderer checks that value and the control's bounds. For icon controls, preserve the source-backed `aria-label` or `aria-labelledby`. The renderer resolves the accessible name and separately checks the control's visibility inside the cropped frame; the name itself need not be painted text. Plain containers with `aria-label`, hidden inputs, password values, hidden/transparent ancestors, clipped controls and off-frame controls do not satisfy this check.

After changing evidence, rerun copy lint, fidelity lint and the required rendering/polish pipeline. Existing reports describe the prior inputs and are not proof that a revised article passes. Report completion only after the caller's finish/delivery command succeeds.
