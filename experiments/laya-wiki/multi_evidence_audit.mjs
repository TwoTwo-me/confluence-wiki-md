import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';

const root=resolve('.'),dir=resolve(process.env.LAYA_MULTI_DIR ?? 'artifacts/laya-wiki/multi-evidence');
const load=async p=>JSON.parse(await readFile(p,'utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const graph=await load(dir+'/graph.json'),nodes=new Map(graph.nodes.map(n=>[n.id,n]));
const registration=await load(dir+'/preregistered.json');
for(const [f,h] of Object.entries(registration.hashes))assert.equal(hash(await readFile(dir+'/'+f)),h);
for(const [f,h] of Object.entries(registration.code_hashes))assert.equal(hash(await readFile(root+'/experiments/laya-wiki/'+f)),h);
assert.equal(nodes.size,27);assert(graph.nodes.every(n=>n.private===false&&n.confluence.integrity===true));
const ids=['Q1','Q2','Q3','Q4'],rows=[],audits=[],cases=[],rubrics=[];
const usageTotal=uses=>uses.reduce((a,b)=>{for(const k of Object.keys(b))a[k]=(a[k]??0)+b[k];return a;},{});
const norm=s=>s.replace(/\s+/g,' ').trim();
function auditSession(session,caseValue){
  assert.equal(session.graph_sha256,registration.hashes['graph.json']);assert.deepEqual(session.case,caseValue);
  let history=[caseValue.start_id],read=[caseValue.start_id];
  for(const step of session.trace){
    const current=history.at(-1),options=[...new Set(nodes.get(current).links.map(e=>e.target_id).filter(i=>!read.includes(i)))].slice(0,4);
    assert.equal(step.source_id,current);
    if(step.action==='BACK'){
      assert.equal(options.length,0);assert(history.length>1);assert.equal(step.choice,'BACK');
      assert.equal(step.target_id,history.at(-2));assert.deepEqual(step.offered_target_ids,[history.at(-2)]);history.pop();
    }else{
      assert.equal(step.action,'LINK');assert.deepEqual(step.offered_target_ids,options);
      assert.equal(step.target_id,options[step.choice.charCodeAt(0)-65]);assert(!read.includes(step.target_id));
      read.push(step.target_id);history.push(step.target_id);
    }
    assert.equal(step.unique_reads,read.length);
  }
  assert.deepEqual(read,session.read_ids);assert.deepEqual(history,session.history);
  assert(read.length<=12&&session.trace.length<=24);assert.deepEqual(session.limits,{reads:12,actions:24,options:4});
}
function assertFreshCodex(receipt,job,reader){
  assert.equal(receipt.exit_code,0);assert(receipt.process_exited);assert.equal(receipt.requested_model,'gpt-6-luna');
  assert.equal(receipt.reasoning_effort,'max');assert.equal(receipt.errors.length,0);assert.equal(receipt.usage.length,1);
  for(const flag of ['--ignore-user-config','--ephemeral','--skip-git-repo-check','--output-schema'])assert(receipt.args.includes(flag));
  for(const conf of ['model_reasoning_effort="max"','project_doc_max_bytes=0','web_search="disabled"','approval_policy="never"'])assert(receipt.args.includes(conf));
  assert.equal(receipt.args[receipt.args.indexOf('--cd')+1],job);
  assert.equal(receipt.args[receipt.args.indexOf('--sandbox')+1],reader?'workspace-write':'read-only');
}
for(const id of ids){
  const c=await load(dir+`/cases/${id}.json`),rubric=await load(dir+`/rubrics/${id}.json`),proof=await load(dir+`/source-proof-${id}.json`);
  assert(proof.global_minimum_cover.size>=3);cases.push(c);rubrics.push(rubric);
  for(const policy of ['laya','bm25','agent']){
    const base=dir+`/${policy}/${id}`,agent=policy==='agent',job=agent?base:base+'/writer';
    const session=await load(base+(agent?'/session.json':'/navigation.json'));
    auditSession(session,c);
    const evaluation=await load(base+'/evaluation.json'),answer=await load(job+'/answer.json'),receipt=await load(job+'/receipt.json');
    assertFreshCodex(receipt,job,agent);
    const events=(await readFile(job+'/stdout.jsonl','utf8')).trim().split('\n').map(JSON.parse);
    const completed=events.filter(e=>e.type==='item.completed').map(e=>e.item);
    assert(completed.every(item=>['agent_message','command_execution'].includes(item.type)),'Unexpected actor tool type');
    const executions=completed.filter(item=>item.type==='command_execution');
    assert.equal(receipt.tools_with_truncation.length,0);
    let exposedBodyBytes=0,toolAudit={};
    if(agent){
      const broker=(await readFile(base+'/broker.jsonl','utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(executions.length,broker.length);
      const exposures=[];
      for(let index=0;index<executions.length;index++){
        const item=executions[index],row=broker[index];assert.equal(item.exit_code,0);
        assert(/^\/bin\/zsh -lc '\.\/read (state|finish|act (A|B|C|D|BACK))'$/.test(item.command),'Disallowed agent command '+item.command);
        const raw=item.aggregated_output.trim(),view=JSON.parse(raw);
        assert.equal(hash(raw),row.response_sha256);assert.equal(view.query,c.query);assert.equal(view.current_id,row.current_id);
        assert(view.read_count<=12&&view.action_count<=24);
        if(row.full_body_first_exposure){assert.equal(view.current_body,nodes.get(view.current_id).text);exposures.push(view.current_id);}
        else assert.equal(view.current_body,'');
        exposedBodyBytes+=row.full_body_bytes;
      }
      assert.deepEqual(exposures,session.read_ids);assert.equal(new Set(exposures).size,exposures.length);
      assert.deepEqual(await load(base+'/_body_seen.json'),exposures);
      toolAudit={allowed_command_executions:executions.length,outside_file_or_web_reads:0,gold_supplied:false,first_full_body_exposures:exposures.length,body_truncation_count:0};
    }else{
      assert.equal(executions.length,0);const request=await load(job+'/request.json');assert.deepEqual(request.read_ids,session.read_ids);
      exposedBodyBytes=session.read_ids.reduce((s,i)=>s+Buffer.byteLength(nodes.get(i).text),0);
      toolAudit={command_executions:0,source_ids_match_reads:true,gold_supplied:false};
    }
    const decision=session.decisions.reduce((a,b)=>{for(const k of ['model_calls','cache_hits','input_tokens','state_tokens_dropped','packed_tokens_dropped','inference_seconds'])a[k]=(a[k]??0)+b[k];return a;},{});
    let localReceipt=null,rss=null;
    if(!agent){
      localReceipt=await load(base+'/receipt.json');
      const time=await readFile(base+'/stderr.txt','utf8');rss=Number(time.match(/(\d+)\s+maximum resident set size/)?.[1]??0);
      assert.equal(localReceipt.exit_code,0);
      if(policy==='laya'){
        assert(localReceipt.args.includes('(version 1) (allow default) (deny network*)'));
        assert.equal(decision.cache_hits,0);assert.equal(decision.state_tokens_dropped,0);
        const replay=await load(dir+`/replay/${id}/navigation.json`);
        assert.deepEqual(replay.read_ids,session.read_ids);assert.deepEqual(replay.trace,session.trace);
        assert.equal(replay.decisions.reduce((s,v)=>s+v.model_calls,0),0);
      }
    }
    const rawCitationErrors=evaluation.citation_checks.filter(cite=>!cite.valid);
    const citationMappings=[];const resolved=structuredClone(answer);
    for(const component of resolved.components){for(const citation of component.citations){
      if(session.read_ids.includes(citation.document_id))continue;
      const titleMatches=session.read_ids.filter(i=>[nodes.get(i).title,nodes.get(i).source_path].includes(citation.document_id));
      const quoteMatches=session.read_ids.filter(i=>norm(nodes.get(i).text).includes(norm(citation.quote)));
      const candidates=titleMatches.length===1?titleMatches:quoteMatches.length===1&&citation.quote.length>=80?quoteMatches:[];
      if(candidates.length===1){citationMappings.push({component:component.component,raw_document_id:citation.document_id,resolved_document_id:candidates[0],method:titleMatches.length===1?'unique title among read documents':'unique exact quotation among read documents',raw_id_valid:false});citation.document_id=candidates[0];}
    }}
    const resolvePath=base+'/citation-resolved.answer.json';await writeFile(resolvePath,JSON.stringify(resolved,null,2)+'\n');
    execFileSync(root+'/artifacts/laya-wiki/venv/bin/python',['-B',root+'/experiments/laya-wiki/multi_evidence_eval.py','--graph',dir+'/graph.json','--navigation',base+(agent?'/session.json':'/navigation.json'),'--rubric',dir+`/rubrics/${id}.json`,'--answer',resolvePath,'--output',base+'/citation-resolved.evaluation.json'],{stdio:'pipe'});
    const resolvedEvaluation=await load(base+'/citation-resolved.evaluation.json');
    rows.push({policy,case_id:id,navigation:{reason:session.reason,finished:session.finished,read_ids:session.read_ids,trace:session.trace,actions:session.trace.length,back_actions:session.trace.filter(t=>t.action==='BACK').length},source_body_bytes_exposed:exposedBodyBytes,metrics:evaluation,raw_answer:answer,citation_resolution:{posthoc:true,raw_errors:rawCitationErrors.length,mappings:citationMappings,evaluation:resolvedEvaluation},cost:{llm: {model:'gpt-6-luna',reasoning_effort:'max',wall_seconds:receipt.wall_seconds,usage:usageTotal(receipt.usage),tool_count:receipt.tool_count},local:localReceipt?{wall_seconds:localReceipt.wall_seconds,peak_rss_bytes:rss,decision}:null}});
    audits.push({policy,case_id:id,path_steps:session.trace.length,read_ids_and_source_bodies_match:true,budget_match:true,input_hashes_match:true,...toolAudit,raw_citation_errors:rawCitationErrors.length});
  }
}
const policies=Object.fromEntries(['laya','bm25','agent'].map(policy=>{
  const chosen=rows.filter(r=>r.policy===policy);
  return [policy,{cases:chosen.length,unique_read_sum:chosen.reduce((s,r)=>s+r.metrics.unique_reads,0),useful_document_sum:chosen.reduce((s,r)=>s+r.metrics.useful_document_ids.length,0),answer_contributing_document_sum:chosen.reduce((s,r)=>s+r.metrics.answer_contributing_document_ids.length,0),resolved_answer_contributing_document_sum:chosen.reduce((s,r)=>s+r.citation_resolution.evaluation.answer_contributing_document_ids.length,0),retrieved_required_facts:chosen.reduce((s,r)=>s+r.metrics.covered_fact_ids.length,0),grounded_answer_facts:chosen.reduce((s,r)=>s+r.metrics.grounded_answer_fact_ids.length,0),total_required_facts:chosen.reduce((s,r)=>s+r.metrics.required_fact_count,0),complete_retrieval_cases:chosen.filter(r=>r.metrics.retrieved_fact_coverage===1).length,complete_required_fact_coverage_cases:chosen.filter(r=>r.metrics.grounded_answer_coverage===1).length,raw_invalid_citations:chosen.reduce((s,r)=>s+r.citation_resolution.raw_errors,0),llm_usage:usageTotal(chosen.map(r=>r.cost.llm.usage)),llm_wall_seconds_sum:chosen.reduce((s,r)=>s+r.cost.llm.wall_seconds,0),source_body_bytes_sum:chosen.reduce((s,r)=>s+r.source_body_bytes_exposed,0)}];
}));
const manual=await load(dir+'/manual-review.json');
assert.equal(manual.rows.length,12);
for(const note of manual.rows){
  const row=rows.find(r=>r.policy===note.policy&&r.case_id===note.case_id);assert(row);
  for(const title of note.minimum_document_titles??[]){
    const candidates=graph.nodes.filter(n=>n.title===title&&row.navigation.read_ids.includes(n.id));assert.equal(candidates.length,1);
  }
  row.manual_review=note;
}
for(const policy of Object.keys(policies))policies[policy].manual_general_content_complete_cases=manual.rows.filter(r=>r.policy===policy&&r.general_content_complete).length;
const summary={schema:1,campaign:'multi-document-evidence',frozen_at:registration.frozen_at,source_graph_sha256:registration.hashes['graph.json'],protocol:registration.protocol,code_hashes:registration.code_hashes,source_catalog:graph.nodes.map(({id,title,source_path,source_url,sha256})=>({id,title,source_path,source_url,sha256})),cases,rubrics,registration,rows,aggregate:policies,audit:audits,manual_review:manual,account_cost:{currency_amount:null,credit_amount:null,measured_scope:'12fresh child Codex experiment runs, with model availability probe reported separately; excludes parent orchestration and implementation worker tokens',api_pricing_not_applied_to_codex_account:true},semantic_review_complete:true,private_sources_in_new_campaign:0};
await writeFile(dir+'/summary.json',JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({rows:rows.length,audited_steps:audits.reduce((s,r)=>s+r.path_steps,0),aggregate:policies}));
