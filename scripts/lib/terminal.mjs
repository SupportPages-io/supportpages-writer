import readline from 'node:readline';
import { Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
// The standalone CLI bundles Clack. The source install.sh bootstrap can run
// before npm dependencies exist, so keep its plain prompts and --help usable.
let prompts;
try {
  prompts = await import('@clack/prompts');
}
catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes("Cannot find package '@clack/prompts'")) throw error;
}

const plain = value => stripVTControlCharacters(String(value)).replace(/[\r\n\t]/g, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '');

// Style human-facing command references at the display boundary, keeping saved
// messages, prompt values and machine-readable output free of ANSI escapes.
export function emphasizeCommands(text, output = process.stdout, env = process.env) {
  if (!output.isTTY || env.TERM === 'dumb' || env.NO_COLOR !== undefined) return String(text);
  const argument = String.raw`(?:'[^'\n]*'|"[^"\n]*"|[^\s,;!?]+)`;
  const flag = String.raw`(?:--(?:dev|refresh|yes|json|skills-only)\b|--(?:workspace|api-url|config-dir|skills-dir|project|agent|app-type)(?:[ \t]+|=)${argument})`;
  const command = new RegExp(String.raw`(?<![\w/.-])supportpages[ \t]+(?:setup|init|uninit|login|logout|status|sync|configure|doctor|analyse|sections|recommend|write|publish|update|remove|--help|--version)\b(?:[ \t]+${flag})*`, 'g');
  return String(text).replace(command, value => {
    const suffix = value.match(/[.]+$/)?.[0] ?? '';
    return `\x1b[1;36m${suffix ? value.slice(0, -suffix.length) : value}\x1b[39;22m${suffix}`;
  });
}

const wrapWords = (text, width) => {
  const lines = [];
  let current = '';
  for (const word of text.trim().split(/\s+/u)) {
    if (current && Array.from(`${current} ${word}`).length <= width) { current += ` ${word}`; continue; }
    if (current) lines.push(current);
    const chars = Array.from(word);
    while (chars.length > width) lines.push(chars.splice(0, width).join(''));
    current = chars.join('');
  }
  if (current) lines.push(current);
  return lines;
};

// The supportpages.io wordmark in figlet's "Pagga" font. Generated once with
// figlet (see dev/figlet-fonts.mjs); the CLI does not depend on it.
const logoRows = [
  '░█▀▀░█░█░█▀█░█▀█░█▀█░█▀▄░▀█▀░█▀█░█▀█░█▀▀░█▀▀░█▀▀░░░░▀█▀░█▀█',
  '░▀▀█░█░█░█▀▀░█▀▀░█░█░█▀▄░░█░░█▀▀░█▀█░█░█░█▀▀░▀▀█░░░░░█░░█░█',
  '░▀▀▀░▀▀▀░▀░░░▀░░░▀▀▀░▀░▀░░▀░░▀░░░▀░▀░▀▀▀░▀▀▀░▀▀▀░▀░░▀▀▀░▀▀▀',
];
const logoWidth = 59;
// ".io" starts here; it and the ░ texture are dimmed like the brand's grey.
const suffixColumn = 48;

/** The logo when it fits unwrapped, otherwise undefined. */
export function logo({ columns = 80, color = false } = {}) {
  if (columns <= logoWidth) return undefined;
  if (!color) return logoRows.join('\n');
  return logoRows.map(row => Array.from(row, (char, column) =>
    char === '░' || column >= suffixColumn ? `\x1b[90m${char}\x1b[39m` : char).join('').replace(/\x1b\[39m\x1b\[90m/g, '')).join('\n');
}

export class Cancelled extends Error {
  constructor(message = 'Setup cancelled. Completed installation steps are kept; rerun to continue.') { super(message); }
}

export function createTerminal(input = process.stdin, output = process.stdout, env = process.env) {
  let active;
  const color = output.isTTY && env.TERM !== 'dumb' && env.NO_COLOR === undefined;
  const menus = prompts && input.isTTY && output.isTTY && typeof input.setRawMode === 'function' && env.TERM !== 'dumb';
  const accent = text => color ? `\x1b[36m${text}\x1b[0m` : text;
  const format = text => emphasizeCommands(text, output, env);
  const raw = text => output.write(text + '\n');
  // Clack does not wrap log lines; wrap paragraphs to the frame width ourselves.
  const wrap = text => String(text).split('\n').flatMap(paragraph => paragraph.trim() ? wrapWords(paragraph, Math.max(20, (output.columns || 80) - 5)) : ['']).join('\n');
  // Interactive sessions keep every message inside Clack's guide line; literal
  // output (JSON, commands to copy) is never reflowed or prefixed.
  const line = (text, { literal = false } = {}) => literal || !menus ? raw(literal ? text : format(text)) : prompts.log.message(format(wrap(text)), display);
  // Clack uses process-wide colour detection. Respect this terminal's NO_COLOR
  // setting too, while retaining cursor movement for keyboard navigation.
  const styledOutput = new Proxy(output, {
    get(target, key) {
      if (key === 'columns') return target.columns > 0 ? target.columns : 80;
      if (key === 'rows') return target.rows > 0 ? target.rows : 24;
      if (key === 'write' && !color) return (chunk, ...args) => target.write(String(chunk).replace(/\x1b\[[0-9;]*m/g, ''), ...args);
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const display = { output: styledOutput };
  const prompt = async (render, options) => {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const onKey = (_text, key) => { if (key?.ctrl && key.name === 'd') cancel(); };
    const wasRaw = Boolean(input.isRaw), wasFlowing = input.readableFlowing === true;
    active = cancel;
    input.once('end', cancel);
    input.once('close', cancel);
    input.on('keypress', onKey);
    try {
      const value = await render({ ...options, input, ...display, signal: controller.signal });
      if (prompts.isCancel(value)) throw new Cancelled();
      return value;
    } finally {
      input.off('end', cancel);
      input.off('close', cancel);
      input.off('keypress', onKey);
      input.setRawMode(wasRaw);
      if (!wasFlowing) input.pause();
      if (active === cancel) active = undefined;
    }
  };
  const ask = (label, fallback = '', hidden = false) => new Promise((resolve, reject) => {
    if (!input.isTTY || !output.isTTY) return reject(new Error('Interactive setup requires a terminal. Use --yes with explicit options for unattended setup.'));
    // A muted output stream keeps readline editing/history off screen for secrets.
    // There is no fallback to echoed input on terminals that cannot hide it.
    const sink = hidden ? new Writable({ write(_chunk, _encoding, done) { done(); } }) : output;
    const rl = readline.createInterface({ input, output: sink, terminal: true, historySize: 0 });
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      active = undefined;
      rl.close();
      if (hidden) output.write('\n');
      err ? reject(err) : resolve(value?.trim() || fallback);
    };
    active = () => finish(new Cancelled());
    rl.once('SIGINT', () => finish(new Cancelled()));
    rl.once('close', () => { if (!settled) finish(new Cancelled()); });
    output.write(`${label}${fallback ? ` [${fallback}]` : ''}: `);
    rl.question('', value => finish(null, value));
  });
  const choices = options => {
    if (!options.length) throw new Error('This question has no options to select.');
    return options.map(option => ({ ...option, label: plain(option.label), ...(option.hint ? { hint: plain(option.hint) } : {}) }));
  };
  return {
    cancel: () => active?.(),
    line,
    // A fresh screen keeps the wizard's frame and choices in view; scrollback is kept.
    // The wordmark is decoration: only on the wizard screen, and only when it fits unwrapped.
    intro: (title, { banner = false } = {}) => {
      if (!menus) return line(`\n${title}`);
      output.write('\x1b[H\x1b[2J');
      const art = banner && logo({ columns: output.columns || 80, color });
      if (art) output.write(`\n${art}\n\n`);
      prompts.intro(title, display);
    },
    // Clack starts the outro after its └ corner; align continuation lines with the first.
    outro: text => menus ? prompts.outro(format(wrap(text)).replace(/\n/g, '\n   '), display) : line(`\n${text}`),
    note: (text, title) => menus ? prompts.note(format(text), title, display) : line(`\n${title}\n${text}`),
    info: text => menus ? prompts.log.info(format(wrap(text)), display) : line(text),
    progress: initial => {
      // Clack's spinner captures stdin and exits on Ctrl+C. Keep this display
      // render-only so the runner can stop the child and restore the terminal.
      let stopped = false, lastLine = Date.now(), lastMessage = plain(initial);
      let frame = 0, animation;
      const render = () => {
        const width = Math.max(8, (output.columns || 80) - 6);
        const chars = Array.from(lastMessage);
        const text = chars.length > width ? chars.slice(0, width - 1).join('') + '…' : lastMessage;
        output.write(`\r\x1b[2K│  ${accent(['|', '/', '-', '\\'][frame++ % 4])} ${format(text)}`);
      };
      if (menus) {
        output.write('\x1b[?25l'); render();
        animation = setInterval(render, 100);
      } else line(lastMessage);
      return {
        update(message, { heartbeat = false } = {}) {
          if (stopped) return;
          const text = plain(message);
          if (menus) { lastMessage = text; render(); return; }
          if (text === lastMessage || (heartbeat && Date.now() - lastLine < 15000)) return;
          line(text); lastMessage = text; lastLine = Date.now();
        },
        stop(message, status = 'success') {
          if (stopped) return;
          stopped = true;
          clearInterval(animation);
          if (!menus) return line(plain(message));
          output.write('\r\x1b[2K\x1b[?25h');
          (status === 'success' ? prompts.log.success : status === 'cancelled' ? prompts.log.warn : prompts.log.error)(format(wrap(plain(message))), display);
        },
      };
    },
    step: (number, title, total) => {
      const text = `${number}${total ? ` of ${total}` : ''}. ${title}`;
      menus ? prompts.log.step(text, display) : line(`\n${accent(text)}`);
    },
    ok: text => menus ? prompts.log.success(format(wrap(text)), display) : line(`  OK ${text}`),
    async ask(label, fallback = '', { validate } = {}) {
      if (menus) return (await prompt(prompts.text, { message: plain(label), placeholder: plain(fallback), defaultValue: fallback,
        validate: value => validate?.(value?.trim() || fallback) })).trim() || fallback;
      while (true) {
        const value = await ask(label, fallback);
        const error = validate?.(value);
        if (!error) return value;
        line(error);
      }
    },
    secret: label => menus ? prompt(prompts.password, { message: plain(label), mask: '*' }) : ask(label, '', true),
    async confirm(label, fallback = true) {
      if (menus) return prompt(prompts.confirm, { message: plain(label), initialValue: fallback });
      while (true) {
        const answer = (await ask(`${label} (${fallback ? 'Y/n' : 'y/N'})`, fallback ? 'y' : 'n')).toLowerCase();
        if (['y', 'yes'].includes(answer)) return true;
        if (['n', 'no'].includes(answer)) return false;
        line('Please enter y or n.');
      }
    },
    async choose(label, options, defaultIndex = 0) {
      options = choices(options);
      // Short menus are plain lists; searching only helps once a list would scroll.
      if (menus && options.length <= 8) return prompt(prompts.select, { message: plain(label), options, initialValue: options[defaultIndex]?.value });
      if (menus) return prompt(prompts.autocomplete, { message: plain(label), options, initialValue: options[defaultIndex]?.value,
        placeholder: 'Type to filter', maxItems: 8,
        validate: value => options.some(option => option.value === value) ? undefined : 'Choose a matching option, or clear your search.' });
      line(label);
      options.forEach((option, i) => line(`  ${i + 1}) ${option.label}`));
      while (true) {
        const value = await ask('Choose a number', String(defaultIndex + 1));
        const index = Number(value) - 1;
        if (Number.isInteger(index) && index >= 0 && index < options.length) return options[index].value;
        line(`Please enter a number from 1 to ${options.length}.`);
      }
    },
    async multiselect(label, options, defaults = []) {
      options = choices(options);
      if (menus) return prompt(prompts.autocompleteMultiselect, { message: plain(label), options, initialValues: defaults,
        required: false, placeholder: 'Type to filter', maxItems: 8 });
      line(label);
      options.forEach((option, i) => line(`  ${i + 1}) ${option.label}`));
      const fallback = options.flatMap((option, index) => defaults.includes(option.value) ? [index + 1] : []).join(',');
      while (true) {
        const raw = await ask(defaults.length ? 'Choose numbers separated by commas, none to clear, or Enter to keep selection' : 'Choose numbers separated by commas, or Enter to skip', fallback);
        if (!raw || raw.toLowerCase() === 'none') return [];
        const indices = raw.split(',').map(value => Number(value.trim()) - 1);
        if (indices.every(index => Number.isInteger(index) && index >= 0 && index < options.length)) return [...new Set(indices)].map(index => options[index].value);
        line(`Please enter numbers from 1 to ${options.length}.`);
      }
    },
  };
}
