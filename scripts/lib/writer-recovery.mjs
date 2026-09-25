import { fail } from '../../dist/errors.js';
import { Cancelled } from './terminal.mjs';

const clean = value => String(value).replace(/[\p{Cc}\p{Cf}]/gu, '');

/** Host task liveness is unknown to the CLI. Clear only after the user confirms it stopped. */
export async function ensureWriterAvailable(bridge, ui) {
  for (;;) {
    const active = await bridge.lock(() => bridge.runs.blocking());
    if (!active) return;
    const { run, state_directory: stateRoot } = active;
    if (stateRoot !== bridge.stateRoot) {
      fail('generation_active', `An unfinished article run belongs to another SupportPages.io connection (${clean(run.api_origin ?? stateRoot)}). Run supportpages init for that connection${stateRoot.includes('/dev/') ? ' with --dev' : ' without --dev'} to clear it after its writer has stopped.`, { run_id: run.id, state_directory: stateRoot });
    }
    const message = [
      clean(run.title ?? 'Untitled article'),
      `Last reported: ${clean(run.phase ?? run.status)} · ${clean(run.updated_at ?? run.started_at)}`,
      `Article files: ${clean(run.artifact_dir)}`,
      'This saved record does not mean a writer is still running.',
    ].join('\n');
    if (ui.note) ui.note(message, 'Unfinished article run');
    else ui.line(message);
    const action = await ui.choose('How would you like to continue?', [
      { value: 'clear', label: 'Writer has stopped — clear run and continue', hint: 'Keeps all existing article files.' },
      { value: 'keep', label: 'Writer is running or unsure — keep run and exit' },
    ]);
    if (action !== 'clear') {
      ui.line('The article run was kept. Rerun when its writer has stopped.');
      throw new Cancelled();
    }
    await bridge.cancel(run.id, true, run);
    ui.ok('Cleared the unfinished run. Existing article files were kept.');
  }
}
