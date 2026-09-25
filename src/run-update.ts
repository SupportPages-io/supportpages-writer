import type { Bridge } from './bridge.js';
import { fail } from './errors.js';

/** Keep the MCP acknowledgement small; the complete run stays available in status. */
export function runUpdateAcknowledgement(run: Awaited<ReturnType<Bridge['updateRun']>>, event: 'started' | 'failed' | 'interrupted' | 'cancelled') {
  if (!run) fail('invalid_run', 'The updated run could not be read. Check supportpages_status.');
  return {
    run_id: run.run_id,
    phase: run.phase,
    execution_mode: run.execution_mode,
    editor_url: run.editor_url,
    message: event === 'started' ? `Writer started in ${run.execution_mode}.` : `Writer marked as ${event}.`,
    ...(run.error ? { error: run.error } : {}),
    ...(run.synchronization_error ? { synchronization_error: run.synchronization_error } : {}),
    ...(run.recovery ? { recovery: run.recovery } : {}),
    ...(run.instructions ? { instructions: run.instructions } : {}),
  };
}

export function runUpdateText(value: unknown) {
  const result = value as ReturnType<typeof runUpdateAcknowledgement>;
  return [result.message,
    ...(!result.editor_url ? ['No confirmed article link is available yet.'] : []),
    ...(result.error ? [`${result.error.code}: ${result.error.message}`] : []),
    ...(result.synchronization_error ? [`Preview synchronization problem: ${result.synchronization_error}`] : []),
    result.recovery, result.instructions,
  ].filter(Boolean).join('\n');
}
