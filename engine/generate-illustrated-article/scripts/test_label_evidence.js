const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { verifyLabelEvidence } = require('./label_evidence');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rtfm-labels-'));
const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), {recursive:true}); fs.writeFileSync(path.join(root, file), text); };
const template = '<%= form_with(model: @new_record, url: records_path) do |form| %>\n<%= form.submit class: "btn" %>\n<% end %>';
const model = 'class APIKey < ActiveRecord::Base\n  belongs_to :account\nend';
const binding = 'def index\n  @new_record = APIKey.new\nend';
const evidence = {string:'Create API key', found_in:'app/views/form.erb', generated:{kind:'rails_submit',locale:'en',action:'create',binding:'@new_record',binding_source:'app/controllers/records_controller.rb',model_source:'app/models/api_key.rb'}};
function reset() {
    fs.rmSync(root, {recursive:true,force:true}); fs.mkdirSync(root);
    write(evidence.found_in, template); write(evidence.generated.binding_source, binding); write(evidence.generated.model_source, model);
    write('config/initializers/inflections.rb', "# inflect.human /bad/, 'Wrong'\nActiveSupport::Inflector.inflections(:en) do |inflect|\n  inflect.acronym 'API'\nend");
}
const check = (entry=evidence) => verifyLabelEvidence(entry, null, root);
try {
    reset(); assert.equal(check().ok, true, JSON.stringify(check()));
    assert.match(check({...evidence,string:'Create a banana'}).error, /contradicts source/);
    assert.match(check({...evidence,generated:{...evidence.generated,action:'update'}}).error, /create\/update state/);
    write(evidence.generated.binding_source, '@new_record = APIKey.find(params[:id])');
    assert.equal(check({...evidence,string:'Update API key',generated:{...evidence.generated,action:'update'}}).ok, true);
    for (const [file, text, expected] of [
        [evidence.found_in, template.replace('form.submit class:', 'form.submit "Delete", class:'), /default submit/],
        [evidence.found_in, template.replace('@new_record','@unrelated'), /bound to this model/],
        [evidence.found_in, template + template, /single form_with/],
        [evidence.generated.model_source, model.replace('APIKey', 'DifferentModel'), /create\/update state/],
        [evidence.generated.binding_source, binding + '\n@new_record = APIKey.find(1)', /unambiguous/],
        [evidence.generated.model_source, model.replace('belongs_to :account', 'def self.model_name; other; end'), /custom model/],
        ['config/locales/en.yml', 'en:\n  helpers:\n    submit:\n      create: Add %{model}', /runtime resolver/],
        ['config/locales/en.yml', 'en:\n  activerecord:\n    models:\n      api_key: Credential', /runtime resolver/],
        ['config/application.rb', 'config.i18n.default_locale = :fr', /runtime resolver/],
        ['config/initializers/inflections.rb', "ActiveSupport::Inflector.inflections(:en) do |i|\n i.human 'api_key', 'Credential'\nend", /custom inflections/],
    ]) { reset(); write(file,text); assert.equal(check().ok,false, file); assert.match(check().error,expected); }
    reset();
    assert.equal(check({...evidence,generated:{kind:'trust_me'}}).ok,false);
    assert.equal(check({...evidence,found_in:'../outside'}).ok,false);
    assert.equal(check({...evidence,generated:undefined,derivation:'Rails does this'}).ok,false);
    write('config/locales/en.yml','en:\n  button: Create API key');
    assert.equal(check({string:'Create API key',found_in:'config/locales/en.yml'}).ok,true);
    assert.equal(check({string:'Invented',found_in:'config/locales/en.yml'}).ok,false);
    reset(); write(evidence.generated.model_source,'class InvoiceLine < ApplicationRecord\nend'); write(evidence.generated.binding_source,'@new_record = InvoiceLine.new');
    assert.equal(check({...evidence,string:'Create Invoice line'}).ok,true);
    reset(); write(evidence.generated.model_source,'class OAuthToken < ApplicationRecord\nend'); write(evidence.generated.binding_source,'@new_record = OAuthToken.new');
    write('config/initializers/inflections.rb', "ActiveSupport::Inflector.inflections(:en) do |i|\n i.acronym 'OAuth'\nend");
    assert.equal(check({...evidence,string:'Create OAuth token'}).ok,true);
    console.log('Generated and literal label evidence tests passed');
} finally {fs.rmSync(root,{recursive:true,force:true});}
