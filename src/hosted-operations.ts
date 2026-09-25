import { z } from 'zod';
import { randomUUID, createHash } from 'node:crypto';
import type { Bridge } from './bridge.js';
import { parse } from './artifacts.js';
import { resolveAction, requireExecution, type WriterAction, type ActionDecision } from './actions.js';
import { fail } from './errors.js';
import { preferences } from './settings.js';
import { remoteId } from './schema.js';
import { secondsSince, track } from './telemetry.js';

export const operationSchema = z.object({ id: remoteId, project_id: remoteId, action: z.string(), execution: z.literal('hosted'),
  attempt: z.number().int().positive(), status: z.enum(['queued','running','succeeded','failed']), article_id: remoteId.nullable(), walkthrough_id:remoteId.nullable().optional(),
  result: z.record(z.string(),z.unknown()), error: z.object({code:z.string(),message:z.string().max(500)}).nullable(),
  review_url: z.url().nullable(), created_at:z.iso.datetime(),started_at:z.iso.datetime().nullable(),finished_at:z.iso.datetime().nullable() });
type Operation = z.infer<typeof operationSchema>;

/** Durable request identity is written before any submission. Status can recover
 * a lost response by key without creating another job, even after a restart. */
export class HostedOperations {
  constructor(private bridge: Bridge) {}
  private path(project: string) { return `${this.bridge.stateRoot}/operations/${project}`; }
  private check(raw: unknown, project: string, id?: string, action?: string): Operation {
    const operation=parse(operationSchema,raw,'invalid_response');
    if(operation.project_id!==project || id && operation.id!==id || action && operation.action!==action) fail('invalid_response','The server returned a different operation.');
    if(operation.review_url) {
      const url=new URL(operation.review_url),origin=new URL(this.bridge.api.origin);
      if(url.username || url.password || url.origin!==origin.origin && !(this.bridge.api.dev && url.hostname===origin.hostname && url.protocol==='https:')) fail('invalid_response','Invalid operation review link.');
    }
    return operation;
  }
  async submit(action: WriterAction, input: Record<string,unknown>, options: {request_id?:string;prefer_background?:boolean;open_when_ready?:boolean;decision?:ActionDecision}={}) {
    requireExecution(options.decision ?? await resolveAction(this.bridge,action,typeof input.article_id==='string'?input.article_id:undefined),'hosted');
    const settings=await preferences(this.bridge.api);
    const prefs={prefer_background:options.prefer_background ?? settings.prefer_background,open_when_ready:options.open_when_ready ?? settings.open_when_ready};
    let operation=await this.bridge.lock(async()=>{
      const binding=await this.bridge.binding();
      const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value && typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value;
      const digest=createHash('sha256').update(JSON.stringify(canonical({action,input,request_id:options.request_id}))).digest('hex');
      const filename=`${this.path(binding.project_id)}/requests/${digest}.json`;
      const previous=await this.bridge.ws.exists(filename)?await this.bridge.ws.json(filename) as {key:string}:undefined;
      const key=previous?.key ?? options.request_id ?? randomUUID();
      if(!z.uuid().safeParse(key).success)fail('invalid_request','Use a UUID request_id.');
      const journal={key,action,input,preferences:prefs};
      await this.bridge.ws.writeJson(filename,journal);
      await this.bridge.ws.writeJson(`${this.path(binding.project_id)}/latest.json`,journal);
      const value=this.check(await this.bridge.api.request('POST',`/projects/${binding.project_id}/writer_operations`,{action_name:action,input},key),binding.project_id,undefined,action);
      await this.bridge.ws.writeJson(`${this.path(binding.project_id)}/latest.json`,{...journal,operation_id:value.id});
      await this.bridge.ws.writeJson(`${this.path(binding.project_id)}/${value.id}.json`,{preferences:prefs});
      return value;
    });
    // Hosted work always runs in SupportPages, where the user can watch it.
    // Holding the call adds latency and teaches the agent to wait; the link does not.
    return this.present(operation);
  }
  async get(id?: string, waitMs=0, allowOpen=true) {
    const binding=await this.bridge.binding();
    if(id)parse(remoteId,id);
    if(!id) {
      const latest=`${this.path(binding.project_id)}/latest.json`;
      if(!await this.bridge.ws.exists(latest))return undefined;
      const journal=await this.bridge.ws.json(latest) as {operation_id?:string;key:string;action:string;preferences?:{open_when_ready:boolean}};
      if(!journal.operation_id) {
        const value=this.check(await this.bridge.api.request('GET',`/projects/${binding.project_id}/writer_operations?idempotency_key=${encodeURIComponent(journal.key)}`),binding.project_id,undefined,journal.action);
        await this.bridge.ws.writeJson(latest,{...journal,operation_id:value.id});
        await this.bridge.ws.writeJson(`${this.path(binding.project_id)}/${value.id}.json`,{preferences:journal.preferences});
        return this.present(value,allowOpen);
      }
      id=journal.operation_id;
    }
    return this.present(await this.poll(id,waitMs),allowOpen);
  }
  private async poll(id: string, waitMs:number) {
    const binding=await this.bridge.binding();
    const deadline=Date.now()+Math.max(0,Math.min(waitMs,20_000));
    while(true) {
      const result=this.check(await this.bridge.api.request('GET',`/projects/${binding.project_id}/writer_operations/${id}`),binding.project_id,id);
      if(!['queued','running'].includes(result.status)||Date.now()>=deadline)return result;
      await new Promise(resolve=>setTimeout(resolve,Math.min(3000,deadline-Date.now())));
    }
  }
  async retry(id:string,attempt:number) {
    parse(remoteId,id);
    const binding=await this.bridge.binding();
    return this.present(this.check(await this.bridge.api.request('POST',`/projects/${binding.project_id}/writer_operations/${id}/retry_operation`,{expected_attempt:attempt}),binding.project_id,id));
  }
  private async present(operation:Operation,allowOpen=true) {
    const open=await this.bridge.lock(async()=>{
      const file=`${this.path(operation.project_id)}/${operation.id}.json`;
      const saved=await this.bridge.ws.exists(file)?await this.bridge.ws.json(file) as {preferences?:{open_when_ready?:boolean};opened?:boolean;counted?:boolean}:{};
      const open=allowOpen&&operation.status==='succeeded'&&!!saved.preferences?.open_when_ready&&!saved.opened;
      // Counted once per operation, however often it is presented.
      const counted=!saved.counted&&['succeeded','failed'].includes(operation.status)&&['create_article','create_video_walkthrough'].includes(operation.action);
      if(open||counted)await this.bridge.ws.writeJson(file,{...saved,...(open?{opened:true}:{}),...(counted?{counted:true}:{})});
      if(counted)track(operation.action==='create_article'?'article_completed':'walkthrough_completed',{
        ...(operation.action==='create_article'?{location:'hosted'}:{}),outcome:operation.status,error_code:operation.error?.code,
        duration_s:operation.started_at?secondsSince(operation.started_at,operation.finished_at?Date.parse(operation.finished_at):Date.now()):undefined});
      return open;
    });
    const completed=operation.action==='create_video_walkthrough'
      ? 'The video is ready for private review and playback. Show the review link. Do not publish or share it automatically.'
      : ['suggest_sections','recommend_articles','find_article_gaps'].includes(operation.action)
      ? `Read the results with ${operation.action==='suggest_sections'?'list_sections':'list_recommendations'} and review selected IDs. Do not automatically accept suggestions, advance onboarding or generate articles. Zero new results is a successful analysis.`
      : 'Show the result and review link. Creation remains a draft unless publication was explicitly requested; edits preserve publication state. Do not publish or share automatically.';
    return {...operation,operation_id:operation.id,open_when_ready:open && operation.status==='succeeded',
      instructions:operation.status==='failed' && operation.error?.code==='revision_conflict'?'The target changed. Read it again and submit a new request with its current revision and a new request_id if the editing instructions still apply. Retrying the old operation cannot overwrite a changed article.'
      :operation.status==='failed'?'Show the safe error and review link. Read the current article before retrying a revision conflict. Explicit retries use retry_operation with the current attempt; never start a local writer.'
      :operation.status==='succeeded'?completed
      :operation.review_url?`SupportPages is writing this now, and the page fills in as it is written. Show ${operation.review_url} as the place to watch it, then finish your turn. Do not poll: call get_operation only when the user asks how it is going, or with this operation_id after a client restart — never resubmit, and never launch a local writer.`
      :'SupportPages is working on this now. Tell the user it is running and finish your turn. Do not poll: call get_operation only when the user asks for progress, or with this operation_id after a client restart — never resubmit, and never launch a local writer.'};
  }
}
