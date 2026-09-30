import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const dir=resolve(process.env.LAYA_MULTI_DIR ?? 'artifacts/laya-wiki/multi-evidence');await mkdir(dir,{recursive:true,mode:0o700});
try{await access(dir+'/preregistered.json');throw new Error('Already frozen; refuse overwrite');}catch(e){if(e.code!=='ENOENT')throw e;}
const graphFile=dir+'/graph.json',graph=JSON.parse(await readFile(graphFile,'utf8'));
assert.equal(graph.nodes.length,27);assert(graph.nodes.every(n=>!n.private&&n.confluence?.integrity));
const find=(title,repo='')=>{const a=graph.nodes.filter(n=>n.title===title&&n.source_url.includes(repo));assert.equal(a.length,1);return a[0];};
const editor=find('README.md','/md-web-editor/'),cfwiki=find('README.md','/confluence-wiki-md/');
const fact=(id,component,anchors,quotes)=>({id,component,expected_answer_any:anchors,source_quotes:quotes});
const cases=[
{id:'Q1',start_id:editor.id,query:'A reviewer claims that IME-safe commands, split editor panels, and local storage together isolate private notes from a compromised sibling app on the same browser origin. Combine the documents to assess this claim: (1) Which composition flag and legacy key code must prevent command interception? (2) What owns the per-note save/revision/recovery state, what state remains per view, and what must happen when the final view closes? (3) What actually scopes IndexedDB and directory permissions, and what optional hostname boundary mitigates the sibling-app risk? End with a conclusion connecting the editing controls to the privacy boundary.'},
{id:'Q2',start_id:editor.id,query:'Explain how to recover and identify a build after browser app data is cleared: (1) Describe the autosave delay, checked write sequence, and failure/recovery behavior. (2) Distinguish cached app assets from selected-folder files: are folder files HTTP/cache entries, and which originals remain independent of browser storage? (3) How many build-commit characters does the UI show and what commit identity must the release record retain? Combine these into a safe recovery-and-verification procedure without assuming cached drafts or permissions survive.'},
{id:'Q3',start_id:editor.id,query:'Prepare an interaction-and-installation release checklist from multiple documents: (1) What is the prefix-command timeout and how is an unrelated character handled? (2) How is a theme bundled, which names are reserved, and is a runtime theme request needed? (3) How are the two PNG application icons included in the manifest, what img-src policy permits them, and must same-origin image permissions be widened? Explain how build-time theme/icon changes and command behavior fit the privacy and installation checks.'},
{id:'Q4',start_id:cfwiki.id,query:'Create a release-recovery and protected-wiki QA checklist from the package docs and syntax-preservation comparison fixture: (1) If publication succeeded but registry installation verification failed, how should the existing release be retried and what successful operation must not repeat? (2) If protected page creation fails or its response is lost, what identifiers/pending state must be retained, what fallback is forbidden, and what must be inspected before retry? (3) What literal does the nested JavaScript fence log in the preservation-comparison fixture, and what does its Mermaid CLI ask the Wiki to check before saving? Connect the recovery, privacy, and source-preservation checks.'}
];
const rubrics=[
{case_id:'Q1',facts:[
fact('F1',1,['isComposing'],['never intercept `isComposing`']),fact('F2',1,['229'],['keyCode 229']),
fact('F3',2,['canonical','document session'],['One canonical document session owns the autosave queue']),
fact('F4',2,['selection'],['each view retains mode and selection']),
fact('F5',2,['final','last'],['Closing the final view must drain saving successfully before removing it']),
fact('F6',3,['origin'],['IndexedDB and directory permissions are scoped to that origin']),
fact('F7',3,['dedicated hostname','hostname'],['A dedicated hostname used only for this editor is the preferred boundary']),
fact('F8',3,['optional','additional protection'],['A dedicated hostname is optional additional protection'])]},
{case_id:'Q2',facts:[
fact('F1',1,['500','500ms','500 ms'],['debounce 500ms']),
fact('F2',1,['unsaved','retry','export'],['Failure remains unsaved with retry/export']),
fact('F3',2,['allowlisted','allowlist'],['It serves only allowlisted application assets from cache']),
fact('F4',2,['HTTP','cache'],['they are never HTTP requests or application-cache entries']),
fact('F5',2,['original','independent'],['original selected-folder files are independent of that storage','original files in your folder remain']),
fact('F6',3,['12'],['first 12 characters of the build commit']),
fact('F7',3,['full SHA','full commit','full hash'],['release records retain the full SHA'])]},
{case_id:'Q3',facts:[
fact('F1',1,['2 second','2 seconds','two second','two seconds','two-second','2-second','2s'],['2 second timeout']),
fact('F2',1,['propagates','propagate','passes through','pass through','cancels'],['unrelated character cancels and propagates']),
fact('F3',2,['public/themes/'],['schema-compatible JSON file to `public/themes/` and rebuild']),
fact('F4',2,['builtin'],['`builtin` and `custom` are reserved names']),
fact('F5',2,['runtime','request'],['Each file appears in Settings without a runtime request']),
fact('F6',3,['PNG data','data URL','data-url'],['The build embeds their bytes as PNG data URLs in the manifest']),
fact('F7',3,['blob:','data:','img-src'],['the existing `img-src blob: data:` policy']),
fact('F8',3,['no need','not need','does not require','no widening','not required'],['there is no need to widen image permissions to every same-origin path'])]},
{case_id:'Q4',facts:[
fact('F1',1,['registry-install'],['retry a failed `registry-install` job without repeating an already successful publication']),
fact('F2',2,['public'],['Never fall back to public creation after protection fails']),
fact('F3',2,['pending','ID','version'],['Preserve returned ID/version and pending-create state on partial failure']),
fact('F4',2,['inspect','remote state','check'],['If no create response arrived, inspect remote state before any retry']),
fact('F5',3,['nested fence text'],['nested fence text']),
fact('F6',3,['version','버전'],['CLI->>Wiki: 버전 확인'])]}
];
await mkdir(dir+'/cases',{recursive:true});await mkdir(dir+'/rubrics',{recursive:true});
for(const c of cases)await writeFile(`${dir}/cases/${c.id}.json`,JSON.stringify(c,null,2)+'\n');
for(const r of rubrics)await writeFile(`${dir}/rubrics/${r.case_id}.json`,JSON.stringify(r,null,2)+'\n');
// The evaluator runs before any inference; only root sees these labels.
const verification=[];
for(const c of cases){
  const nav=dir+`/empty-${c.id}.json`;await writeFile(nav,JSON.stringify({read_ids:[]}));
  const evalFile=dir+`/source-proof-${c.id}.json`;
  execFileSync('artifacts/laya-wiki/venv/bin/python',['experiments/laya-wiki/multi_evidence_eval.py','--graph',graphFile,'--navigation',nav,'--rubric',dir+`/rubrics/${c.id}.json`,'--output',evalFile],{stdio:'pipe'});
  const e=JSON.parse(await readFile(evalFile,'utf8'));assert(e.global_minimum_cover?.size>=3,`${c.id} has a single/two-document complete answer`);
  assert(Object.values(e.supporting_documents).every(ids=>ids.length>0));
  verification.push({case_id:c.id,required_facts:e.required_fact_count,global_minimum_documents:e.global_minimum_cover.size,supporting_documents:e.supporting_documents});
}
const files=['graph.json',...cases.map(c=>`cases/${c.id}.json`),...cases.map(c=>`rubrics/${c.id}.json`)];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const hashes=Object.fromEntries(await Promise.all(files.map(async f=>[f,sha(await readFile(dir+'/'+f))])));
const code=['multi_evidence_walk.py','multi_evidence_eval.py','multi_evidence_model.py'];
const codeHashes=Object.fromEntries(await Promise.all(code.map(async f=>[f,sha(await readFile('experiments/laya-wiki/'+f))])));
const schema={type:'object',additionalProperties:false,required:['components','synthesis','complete'],properties:{components:{type:'array',items:{type:'object',additionalProperties:false,required:['component','answer','citations'],properties:{component:{type:'integer'},answer:{type:'string'},citations:{type:'array',items:{type:'object',additionalProperties:false,required:['document_id','quote'],properties:{document_id:{type:'string'},quote:{type:'string'}}}}}}},synthesis:{type:'string'},complete:{type:'boolean'}}};
await writeFile(dir+'/answer.schema.json',JSON.stringify(schema,null,2)+'\n');
const registration={schema:1,frozen_at:new Date().toISOString(),hashes,code_hashes:codeHashes,verification,
protocol:{cases:4,max_unique_reads:12,max_actions:24,max_current_outgoing_options:4,source:'Fresh verified public Confluence snapshots; source aliases and actual body links',
navigation:'Only currently offered distinct outgoing targets or explicit history BACK when exhausted; unchosen local links retained.',
laya_bm25_stop:'Gather to fixed cap or component exhaustion; no single-document arrival or oracle stop.',agent_stop:'Fresh isolated direct-reading agent may declare sufficient evidence early; evaluate actual correctness and prefix curves separately.',
answer_model:'gpt-6-luna',reasoning_effort:'max',account:'Existing Codex account; real usage measured. No new API key or paid judge.',
answer_sources:'Full actually read body documents. Same fresh model/schema for BM25/Laya synthesis; direct agent writes the same structured answer schema.',
root_judgment:'Deterministic quote/value checks plus manual semantic review of all12answers; no paid judging model.',labels:'Only evaluator/root sees rubric; actors have question/start/source broker only.',
scope:'Four handpicked, dependent public questions; not a generalized success-rate or native/private-data trial.',new_private_publications:0,media_reads:0}};
await writeFile(dir+'/preregistered.json',JSON.stringify(registration,null,2)+'\n');
console.log(JSON.stringify({frozen_at:registration.frozen_at,cases:verification.map(v=>({id:v.case_id,facts:v.required_facts,global_min_docs:v.global_minimum_documents})),hashes:registration.hashes}));
