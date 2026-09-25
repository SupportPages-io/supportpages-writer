import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { createTerminal, Cancelled, logo } from '../scripts/lib/terminal.mjs';
import { ensureLogin, getStartedChoices, writingLines } from '../scripts/lib/cli.mjs';

// The stream fixtures emulate an interactive terminal, even in a TERM=dumb CI shell.
process.env.TERM = 'xterm-256color';

function terminal(t, env = { NO_COLOR: '1' }) {
  const input = new PassThrough();
  input.isTTY = true; input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; };
  let text = '';
  const output = new Writable({ write(chunk, _encoding, done) { text += chunk; done(); } });
  output.isTTY = true; output.columns = 80; output.rows = 24;
  const ui = createTerminal(input, output, env);
  t.after(() => { ui.cancel(); input.destroy(); output.end(); });
  return { ui, input, output, text: () => text, press: async bytes => { input.write(bytes); await setImmediate(); } };
}
const choices = [{ value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude Code' }, { value: 'both', label: 'Both' }];

test('account setup choices work with Enter and arrow keys in wide and narrow terminals', async t => {
  for (const columns of [80, 40]) for (const mode of ['signin', 'signup', 'local']) {
    const f = terminal(t);
    f.output.columns = columns;
    const choosing = f.ui.choose('How would you like to get started?', getStartedChoices);
    await f.press({ signin: '\r', signup: '\x1b[B\r', local: '\x1b[B\x1b[B\r' }[mode]);
    assert.equal(await choosing, mode);
    const text = stripVTControlCharacters(f.text()).replace(/\n│\s*/g, ' ').replace(/\s+/g, ' ');
    assert.match(text, /Sign in to my existing SupportPages.io account/);
    assert.match(text, /Create a free SupportPages.io account and help centre/);
    assert.match(text, /Save articles in my projects without an account/);
    assert.doesNotMatch(text, /\(/);
    if (mode === 'local') continue;
    let opened;
    const session = { close() {}, login: async ({ onApproval }) => {
      await onApproval({ url: 'https://app.supportpages.io/settings/mcp/connect/' + 'a'.repeat(64), code: 'ABCD-EFGH' });
      return { account: { email: 'alice@example.com' } };
    } };
    await ensureLogin(session, { ui: f.ui, open: async url => { opened = url; return true; } }, { mode });
    assert.equal(new URL(opened).searchParams.get('signup'), mode === 'signup' ? '1' : null);
    assert.equal(f.input.isRaw, false);
  }
});

test('live progress respects plain and colour-free terminals and cleans up before the next prompt', async t => {
  for (const env of [{ NO_COLOR: '1' }, { TERM: 'dumb' }]) {
    const f = terminal(t, env);
    const signals = process.listenerCount('SIGINT');
    const p = f.ui.progress('Starting analysis');
    t.after(() => p.stop('Stopped', 'cancelled'));
    p.update('Reading project files · 0:02 elapsed');
    await new Promise(resolve => setTimeout(resolve, 150));
    p.stop('Analysis cancelled', 'cancelled');
    p.stop('Must not show success');
    assert.equal(process.listenerCount('SIGINT'), signals);
    assert.equal(f.input.isRaw, false);
    assert.match(f.text(), /Reading project files/);
    assert.match(f.text(), /Analysis cancelled/);
    assert.doesNotMatch(f.text(), /Must not show success|\x1b\[[0-9;]*m/);
    if (env.TERM === 'dumb') assert.doesNotMatch(f.text(), /\x1b/);
    const next = f.ui.confirm('Continue later?', true);
    await f.press('y\r');
    assert.equal(await next, true);
  }
});

test('arrow keys select a value, retain defaults and restore input and cursor state', async t => {
  const f = terminal(t);
  let answer = f.ui.choose('Coding client?', choices, 1);
  assert.equal(f.input.isRaw, true);
  await f.press('\r');
  assert.equal(await answer, 'claude');
  assert.equal(f.input.isRaw, false);
  assert.equal(f.input.isPaused(), true);
  assert.equal(f.input.listenerCount('keypress'), 0);
  assert.equal(f.output.listenerCount('resize'), 0);
  assert.match(f.text(), /\x1b\[\?25h/);
  assert.doesNotMatch(f.text(), /\x1b\[(?:2|32|36)m/); // NO_COLOR keeps keyboard navigation.
  answer = f.ui.choose('Coding client?', choices);
  await f.press('\x1b[B\x1b[B\r');
  assert.equal(await answer, 'both');
});

test('yes/no menus respect saved defaults and accept arrows and y/n shortcuts', async t => {
  const f = terminal(t);
  let answer = f.ui.confirm('Publish?', false);
  await f.press('\r');assert.equal(await answer, false);
  answer = f.ui.confirm('Publish?', false);
  await f.press('y\r');assert.equal(await answer, true);
  answer = f.ui.confirm('Open drafts?', true);
  await f.press('\x1b[B\r');assert.equal(await answer, false);
});

test('checkbox selections persist through filtering and can be toggled off or skipped', async t => {
  const f = terminal(t);
  let answer = f.ui.multiselect('Clients?', choices);
  await f.press('\t'); // Select Codex.
  await f.press('cla');
  await f.press('\t'); // Select Claude while filtered.
  await f.press('\x7f'.repeat(3)); // Clear the filter; Escape cancels in Clack.
  await f.press('\x1b[A \r'); // Deselect Codex and submit.
  assert.deepEqual(await answer, ['claude']);
  answer = f.ui.multiselect('Clients?', choices);
  await f.press('\r');assert.deepEqual(await answer, []);
  answer = f.ui.multiselect('Clients?', choices, ['both']);
  await f.press('\r');assert.deepEqual(await answer, ['both']);
});

test('long lists scroll, filter, recover from no matches, and survive terminal resizing', async t => {
  const f = terminal(t);
  const projects = Array.from({ length: 100 }, (_, i) => ({ value: i, label: `Help centre ${i}` }));
  const answer = f.ui.choose('Help centre?', projects);
  assert.match(f.text(), /Help centre 0/);
  await f.press('\x1b[B'.repeat(99));
  assert.match(f.text(), /Help centre 99/);
  await f.press('missing\r');
  assert.match(f.text(), /No matches/);
  assert.equal(f.input.isRaw, true); // Enter cannot select an invisible option.
  await f.press('\x7f'.repeat(7) + 'centre 42');
  f.output.columns = 35; f.output.rows = 12; f.output.emit('resize');
  await f.press('\r');
  assert.equal(await answer, 42);
});

test('keyboard and programmatic cancellation restore the terminal without selecting an option', async t => {
  for (const mode of ['ctrl-c', 'ctrl-d', 'cancel']) {
    const f = terminal(t);
    const answer = f.ui.choose('Coding client?', choices);
    const cancelled = assert.rejects(answer, Cancelled);
    if (mode === 'cancel') f.ui.cancel();
    else await f.press(mode === 'ctrl-c' ? '\x03' : '\x04');
    await cancelled;
    assert.equal(f.input.isRaw, false);
    assert.equal(f.input.isPaused(), true);
    assert.equal(f.input.listenerCount('keypress'), 0);
    assert.equal(f.output.listenerCount('resize'), 0);
    assert.match(f.text(), /\x1b\[\?25h/);
  }
});

test('labels cannot send terminal controls and noninteractive menus fail clearly', async t => {
  const f = terminal(t);
  const answer = f.ui.choose('Project?', [{ value: 'safe', label: '\x1b[2JExample\n\x1b]0;Injected title\x07' }]);
  assert.doesNotMatch(f.text(), /\x1b\[2J|\x1b\]0;/);
  await f.press('\r');assert.equal(await answer, 'safe');
  f.input.isTTY = false;
  await assert.rejects(createTerminal(f.input, f.output).choose('Project?', choices), /requires a terminal/);
});

test('text fields validate inline, preserve defaults, and leave the terminal usable', async t => {
  const f = terminal(t);
  const answer = f.ui.ask('Help centre address', '', { validate: value => /^[a-z]{3,}$/.test(value) ? undefined : 'Use at least three lowercase letters.' });
  await f.press('A!\r');
  assert.match(f.text(), /Use at least three lowercase letters/);
  assert.equal(f.input.isRaw, true);
  await f.press('\x15example\r');
  assert.equal(await answer, 'example');
  const suggested = f.ui.ask('Help centre name', 'Example');
  await f.press('\r');
  assert.equal(await suggested, 'Example');
  assert.equal(f.input.isRaw, false);
});

test('password prompts mask input and cancellation cleans up text prompts', async t => {
  const f = terminal(t, { NO_COLOR: '' });
  const secret = f.ui.secret('Token');
  await f.press('private-value\r');
  assert.equal(await secret, 'private-value');
  assert.doesNotMatch(f.text(), /private-value|\x1b\[[0-9;]*m/);
  const answer = f.ui.ask('Project name');
  const cancelled = assert.rejects(answer, Cancelled);
  await f.press('\x03');
  await cancelled;
  assert.equal(f.input.isRaw, false);
  assert.equal(f.input.listenerCount('keypress'), 0);
});

test('source installer can load the terminal before npm dependencies are installed', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'supportpages-terminal-bootstrap-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'terminal.mjs');
  await copyFile(new URL('../scripts/lib/terminal.mjs', import.meta.url), filename);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {createTerminal} from ${JSON.stringify(pathToFileURL(filename).href)}; createTerminal().line('Bootstrap ready');`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'Bootstrap ready');
});

test('real terminal supports menus, text entry, cancellation, and a plain-terminal fallback', () => {
  const python = `
import os,pty,select,subprocess,sys,time,fcntl,termios,struct
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0))
code="""
import {createTerminal} from './scripts/lib/terminal.mjs';
const ui=createTerminal();
const client=await ui.choose('Coding client?', [{value:'codex',label:'Codex'},{value:'claude',label:'Claude Code'}]);
const name=await ui.ask('Your project');
const types=await ui.multiselect('Project types?', [{value:'web',label:'Web app'},{value:'api',label:'API'}]);
const open=await ui.confirm('Open drafts?',false);
console.log('RESULT '+JSON.stringify({client,name,types,open}));
try {await ui.choose('Cancel this?', [{value:'x',label:'Example'}]);} catch {console.log('CANCELLED raw='+process.stdin.isRaw);}
"""
env={**os.environ,'TERM':sys.argv[2],'NO_COLOR':'1'}
p=subprocess.Popen([sys.argv[1],'--input-type=module','-e',code],stdin=slave,stdout=slave,stderr=slave,env=env)
os.close(slave)
plain=sys.argv[2]=='dumb'
prompts=[(b'Choose a number [1]: ' if plain else b'Coding client?',b'2\\r' if plain else b'\\x1b[B\\r'),(b'Your project:' if plain else b'Your project',b'Example\\r'),(b'Choose numbers separated by commas, or Enter to skip: ' if plain else b'Project types?',b'1,2\\r' if plain else b'\\t\\x1b[B \\r'),(b'Open drafts?',b'y\\r'),(b'Choose a number [1]: ' if plain else b'Cancel this?',b'\\x03')]
buf=b'';cursor=0;seen=0;deadline=time.time()+8
try:
    while time.time()<deadline:
        if select.select([master],[],[],0.1)[0]:
            try: buf+=os.read(master,8192)
            except OSError: break
        if cursor<len(prompts) and prompts[cursor][0] in buf[seen:]:
            os.write(master,prompts[cursor][1]);cursor+=1;seen=len(buf)
        if p.poll() is not None: break
    try: p.wait(timeout=1)
    except subprocess.TimeoutExpired: raise AssertionError(buf.decode(errors='replace'))
    assert p.returncode==0,buf.decode(errors='replace')
    assert cursor==len(prompts),buf.decode(errors='replace')
    assert b'RESULT {"client":"claude","name":"Example","types":["web","api"],"open":true}' in buf,buf.decode(errors='replace')
    assert b'CANCELLED raw=false' in buf,buf.decode(errors='replace')
finally:
    if p.poll() is None: p.kill()
    os.close(master)
`;
  for (const mode of ['xterm-256color', 'dumb']) {
    const result = spawnSync('python3', ['-c', python, process.execPath, mode], { encoding: 'utf8', timeout: 12000 });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('the setup banner fits a 60-column terminal and stays off narrow or plain screens', t => {
  const art = logo();
  assert.ok(art.split('\n').every(row => Array.from(row).length < 60));
  assert.equal(logo({ columns: 59 }), undefined);
  assert.equal(stripVTControlCharacters(logo({ color: true })), art);
  const wide = terminal(t);
  wide.ui.intro('SupportPages Writer · Set up this computer', { banner: true });
  assert.ok(wide.text().includes(art));
  const narrow = terminal(t);
  narrow.output.columns = 50;
  narrow.ui.intro('SupportPages Writer · Set up this computer', { banner: true });
  assert.ok(!narrow.text().includes('░▀▀▀░') && narrow.text().includes('Set up this computer'));
  const plain = terminal(t, { TERM: 'dumb' });
  plain.ui.intro('SupportPages Writer · Set up this computer', { banner: true });
  assert.ok(!plain.text().includes('░▀▀▀░'));
});

test('the project summary says where articles are written and what it uses', () => {
  const connect = 'https://app.supportpages.io/projects/1/repository';
  assert.deepEqual(writingLines({ status: 'local' }, ['claude']), ['Writing   On this computer, using your own Claude Code usage']);
  assert.deepEqual(writingLines({ status: 'ready', writer_action: { execution: 'local' },
    repository_connection: { state: 'not_connected', connect_url: connect } }, ['claude', 'codex']), [
    'Writing   On this computer, using your own Claude Code or Codex usage',
    '          Connect a repository to write on SupportPages.io instead,',
    `          using your article allowance: ${connect}`,
  ]);
  assert.deepEqual(writingLines({ status: 'ready', writer_action: { execution: 'hosted' },
    repository_connection: { state: 'connected', connect_url: connect } }, ['claude']), ['Writing   On SupportPages.io, using your article allowance']);
});
