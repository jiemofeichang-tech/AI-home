import type { Actor } from '../src/shared/contracts';

/** Existing suites exercise published content; explicitly review their fixtures. */
export function approvedFixtures(rawExecute:any,query:any,moderationDecide:any,administrator:Actor) {
  const approvals=new Map<string,Promise<void>>();
  async function approve(result:any,targetType?:'post'|'comment') {
    const [item]=result.moderationId
      ?await query('SELECT id,status,revision FROM moderation_cases WHERE id=$1',[result.moderationId])
      :await query('SELECT id,status,revision FROM moderation_cases WHERE target_type=$1 AND target_id=$2',[targetType||'post',result.id]);
    if(!item)throw new Error(`Fixture ${result.id} has no moderation case`);
    if(item.status==='approved')return result;
    const key=`${item.id}:${item.revision}`;
    if(!approvals.has(key))approvals.set(key,moderationDecide(administrator,{id:item.id,decision:'approve',reason:'集成测试夹具人工审核通过'}));
    await approvals.get(key);return result;
  }
  async function execute(action:string,input:unknown,actor:Actor) {
    const result=await rawExecute(action,input,actor);
    if(result?.moderationStatus==='pending')await approve(result,action==='comments_create'?'comment':'post');
    return result;
  }
  return {execute,approve};
}
