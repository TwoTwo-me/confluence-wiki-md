import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { load } from 'cheerio';
import { loadProfile } from '../src/env.mjs';
import { readWikiConfig } from '../src/api.mjs';
import { loadStorageXml } from '../src/document.mjs';
import { corpus, before, after } from '../benchmarks/token-corpus.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { env: { type: 'string' }, 'mcp-env': { type: 'string' }, parent: { type: 'string' }, output: { type: 'string' }, raw: { type: 'string' }, python: { type: 'string' }, methods: { type: 'string' }, resume: { type: 'string' }, finalize: { type: 'boolean' }, corpus: { type: 'string' }, probe: { type: 'boolean' } } });
assert.ok(values.env && /^\d+$/.test(values.parent ?? ''), 'Require --env PRIVATE_PROFILE --parent CONFIRMED_TEST_PARENT_ID. Writes create new children only; never auto-retry uncertain creates.');
const envFile = path.resolve(values.env);
const config = readWikiConfig(await loadProfile(envFile));
assert.equal(config.deployment, 'cloud', 'The live comparison currently targets Confluence Cloud.');
let runId = new Date().toISOString().replaceAll(':', '-').replace(/\.\d+Z$/, '') + '-' + randomUUID().slice(0, 6);
const rawDir = path.resolve(values.resume ?? values.raw ?? path.join(root, 'artifacts/token-benchmark', runId));
await mkdir(rawDir, { recursive: true, mode: 0o700 });
const mcpConfig = values['mcp-env'] ? readWikiConfig(await loadProfile(path.resolve(values['mcp-env']))) : config;
assert.equal(mcpConfig.siteUrl, config.siteUrl, 'REST and MCP profiles must refer to the same site.');
const mcpAuthorization = process.env.ATLASSIAN_MCP_ACCESS_TOKEN ? 'Bearer ' + process.env.ATLASSIAN_MCP_ACCESS_TOKEN : mcpConfig.auth === 'bearer' ? 'Bearer ' + mcpConfig.token : 'Basic ' + Buffer.from(mcpConfig.email + ':' + mcpConfig.token).toString('base64');
const authorization = config.auth === 'bearer' ? 'Bearer ' + config.token : 'Basic ' + Buffer.from(config.email + ':' + config.token).toString('base64');
const mcpUrl = 'https://mcp.atlassian.com/v2/mcp';
const cloudId = (await loadProfile(envFile)).CONFLUENCE_CLOUD_ID ?? config.siteUrl;
let sequence = 0;
let session;
const records = [];
const errors = [];
const manifest = [];
const results = [];
function sanitizeMessage(message) {
  let text = String(message);
  for (const [source, replacement] of [[config.token, '[secret]'], [authorization, '[secret authorization]'], [authorization.replace(/^(?:Basic|Bearer) /, ''), '[secret authorization]'], [mcpAuthorization, '[secret authorization]'], [mcpAuthorization.replace(/^(?:Basic|Bearer) /, ''), '[secret authorization]'], [mcpConfig.token, '[secret]'], [process.env.ATLASSIAN_MCP_ACCESS_TOKEN, '[secret]'], [envFile, '[private REST profile]'], [values['mcp-env'] && path.resolve(values['mcp-env']), '[private MCP profile]'], [rawDir, '[private artifacts]'], [root, '[checkout]'], [config.email, '[account]']]) if (source) text = text.replaceAll(source, replacement);
  return text;
}
const emit = (value) => process.stdout.write(JSON.stringify(sanitizePublic(value)) + '\n');
function sanitizePublic(value) {
  if (typeof value === 'string') return sanitizeMessage(value);
  if (Array.isArray(value)) return value.map(sanitizePublic);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitizePublic(child)]));
  return value;
}
if (values.resume) {
  const state = JSON.parse(await readFile(path.join(rawDir, 'state.json'), 'utf8'));
  assert.equal(state.parent, values.parent);
  runId = state.runId;
  manifest.push(...state.manifest); records.push(...(values.finalize ? state.records : state.records.filter((record) => record.corpus !== 'session'))); results.push(...state.results); errors.push(...state.errors);
  sequence = state.sequence;
}
async function persist() { await save('state.json', JSON.stringify({runId, parent: values.parent, manifest, records, results, errors, sequence}, null, 2)); }

function execute(command, args, { input, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { cwd: rawDir, timeout: 90000, maxBuffer: 20 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error(`${command}: ${error.code ?? 'failed'}; ${(stderr || '').slice(0, 1000)}`), { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}
async function save(name, text) { await writeFile(path.join(rawDir, name), text, { mode: 0o600 }); }
async function curl(url, { method = 'GET', body, mcp = false, label = 'request' } = {}) {
  const name = String(++sequence).padStart(4, '0') + '-' + label;
  const responseFile = path.join(rawDir, name + '.response');
  const headerFile = path.join(rawDir, name + '.headers');
  const headers = ['Authorization: ' + (mcp && mcpAuthorization ? mcpAuthorization : authorization), 'Accept: ' + (mcp ? 'application/json, text/event-stream' : 'application/json')];
  if (body !== undefined) headers.push('Content-Type: application/json');
  if (mcp) headers.push('MCP-Protocol-Version: 2025-03-26', ...(session ? ['Mcp-Session-Id: ' + session] : []));
  const command = ['url = ' + JSON.stringify(url), 'request = ' + JSON.stringify(method), ...headers.map((header) => 'header = ' + JSON.stringify(header)), ...(body !== undefined ? ['data = ' + JSON.stringify(JSON.stringify(body))] : [])].join('\n');
  const started = Date.now();
  const result = await execute('curl', ['--silent', '--show-error', '--max-time', '60', '--config', '-', '--output', responseFile, '--dump-header', headerFile, '--write-out', '%{http_code}'], { input: command + '\n' });
  const text = await readFile(responseFile, 'utf8');
  const headersText = await readFile(headerFile, 'utf8');
  session ??= headersText.match(/^mcp-session-id:\s*(.+)$/im)?.[1].trim();
  const status = Number(result.stdout);
  if (status < 200 || status >= 300) throw new Error(`${label}: HTTP ${status}; ${text.slice(0, 450).replaceAll(config.token, '[REDACTED]')}`);
  return { text, elapsedMs: Date.now() - started, status };
}
function parseRpc(text) {
  try { return JSON.parse(text); } catch {}
  const messages = text.split(/\r?\n/).filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
  const result = messages.findLast((message) => message.result !== undefined || message.error !== undefined);
  if (!result) throw new Error('MCP response contains no JSON-RPC result.');
  return result;
}
async function mcp(method, params, label) {
  const response = await curl(mcpUrl, { method: 'POST', body: { jsonrpc: '2.0', id: sequence + 1, method, ...(params ? { params } : {}) }, mcp: true, label });
  const rpc = parseRpc(response.text);
  if (rpc.error) throw new Error('MCP JSON-RPC error: ' + JSON.stringify(rpc.error));
  return { ...response, rpc, result: rpc.result };
}
function textContent(result) { return (result.content ?? []).filter((item) => item.type === 'text').map((item) => item.text).join('\n'); }
function payload(result) {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = textContent(result);
  try { return JSON.parse(text); } catch { return { text }; }
}
async function tool(name, args, label = name) {
  const result = await mcp('tools/call', { name, arguments: args }, label);
  if (result.result.isError) throw Object.assign(new Error('MCP tool error: ' + textContent(result.result).slice(0, 1200)), { toolResult: result.result });
  return { ...result, payload: payload(result.result), visible: textContent(result.result), input: JSON.stringify({ name, arguments: args }) };
}
function record(corpusId, method, phase, text, extra = {}) {
  const artifact = `${String(records.length + 1).padStart(4, '0')}-${corpusId}-${method}-${phase}.txt`;
  records.push({ corpus: corpusId, method, phase, artifact, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'), text, ...extra });
}
async function restGet(id, label) { const response = await curl(config.apiUrl + '/pages/' + id + '?body-format=storage', { label }); return { ...response, page: JSON.parse(response.text) }; }
function normalizedText(text) { return text.replace(/\s+/gu, ' ').trim(); }
function fingerprint(storage) {
  const $ = loadStorageXml(storage);
  const text = [];
  const visit = (node) => {
    // Confluence generates task identities and may reorder native macro
    // parameters. Compare their semantics separately from visible text.
    if (['ac:task-id', 'ac:task-uuid', 'ac:parameter'].includes(node.name)) return;
    if (node.type === 'text' && normalizedText(node.data)) text.push(normalizedText(node.data));
    for (const child of node.children ?? []) visit(child);
  };
  visit($.root()[0]);
  const macros = $('ac\\:structured-macro').toArray().map((node) => ({ name: $(node).attr('ac:name'), text: normalizedText($(node).text()), parameters: $(node).children('ac\\:parameter').toArray().map((parameter) => [$(parameter).attr('ac:name'), $(parameter).text()]).sort() })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { text, macros, links: $('a').toArray().map((node) => $(node).attr('href')).sort(), taskStatuses: $('ac\\:task-status').toArray().map((node) => $(node).text()), tableCells: $('th,td').length, code: $('ac\\:plain-text-body').toArray().map((node) => $(node).text().replace(/\r\n/g, '\n').replace(/\n$/, '')) };
}
function verify(baseline, storage) {
  const expected = fingerprint(baseline);
  expected.text = expected.text.map((text) => text.replace(before, after));
  const actual = fingerprint(storage);
  const failures = [];
  const normalizations = [];
  // Keep visible text in order, allowing a macro title to become a visible
  // paragraph. Task IDs and macro configuration are verified separately.
  let position = 0;
  const visibleText = normalizedText(actual.text.join(' '));
  for (const text of expected.text) {
    const found = visibleText.indexOf(text, position);
    if (found < 0) { failures.push('visible-text'); break; }
    position = found + text.length;
  }
  const remaining = [...actual.macros];
  for (const macro of expected.macros) {
    const index = remaining.findIndex((candidate) => candidate.name === macro.name);
    if (index < 0) { failures.push('macro-missing:' + macro.name); continue; }
    const candidate = remaining.splice(index, 1)[0];
    for (const [name, value] of macro.parameters) {
      const other = candidate.parameters.find(([key]) => key === name)?.[1];
      if (other === value) continue;
      if (macro.name === 'code' && name === 'language' && [value, other].every((language) => ['javascript', 'js'].includes(language))) { normalizations.push('code language javascript/js'); continue; }
      if (macro.name === 'panel' && name === 'title' && candidate.text.includes(value)) { normalizations.push('panel title moved into visible body'); continue; }
      failures.push('macro-parameter:' + macro.name + '.' + name);
    }
  }
  for (const key of ['links', 'taskStatuses', 'tableCells', 'code']) if (JSON.stringify(expected[key]) !== JSON.stringify(actual[key])) failures.push(key);
  if (!storage.includes(after) || storage.includes(before)) failures.push('edit-not-applied');
  return { passed: failures.length === 0, failures, normalizations, expected, actual };
}
async function cli(args) { return execute(process.execPath, [path.join(root, 'scripts/confluence.mjs'), ...args, '--env', envFile], { cwd: rawDir }); }

async function createPage(item, method, spaceId) {
  const key = item.id + ':' + method;
  let saved = manifest.find((entry) => entry.key === key);
  if (saved?.pending && !saved.id) throw new Error('Previous create outcome is unresolved; inspect the test parent. No POST retry attempted.');
  if (saved?.id) {
    const page = (await restGet(saved.id, key + '-resume')).page;
    if (page.version.number !== 1) throw new Error('Existing benchmark page changed; refusing to repeat its write.');
    return { page, baseline: saved.baseline };
  }
  const title = `cfwiki benchmark ${runId} ${item.id} ${method}`;
  saved = { key, corpus: item.id, method, title, pending: true };
  manifest.push(saved); await persist();
  const body = { title, spaceId: String(spaceId), parentId: values.parent, status: 'current', body: {representation:'storage', value:item.storage} };
  const created = JSON.parse((await curl(config.apiUrl + '/pages', { method:'POST', body, label:item.id+'-'+method+'-create' })).text);
  assert.ok(/^\d+$/.test(String(created.id)), 'Create did not return a confirmed ID.');
  saved.id = String(created.id); saved.pending = false; await persist();
  const page = (await restGet(saved.id, item.id+'-'+method+'-baseline')).page;
  saved.baseline = page.body.storage.value;
  saved.setupVerification = verify(item.storage, saved.baseline.replace(before, after));
  assert.ok(saved.setupVerification.passed, 'Initial REST fixture creation did not retain the synthetic content.');
  await persist();
  return { page, baseline:saved.baseline };
}
async function runCurl(item, spaceId) {
  const method = 'curl';
  const {page,baseline} = await createPage(item, method, spaceId);
  const read = await restGet(page.id, item.id+'-curl-read');
  record(item.id,method,'read-input',JSON.stringify({method:'GET',url:config.apiUrl+'/pages/'+page.id+'?body-format=storage'}));
  record(item.id,method,'read-output-raw',read.text);
  record(item.id,method,'read-output-filtered',JSON.stringify({id:read.page.id,title:read.page.title,version:read.page.version.number,storage:read.page.body.storage.value}));
  const body = {id:page.id,status:'current',title:page.title,spaceId:String(spaceId),version:{number:read.page.version.number+1},body:{representation:'storage',value:read.page.body.storage.value.replace(before,after)}};
  record(item.id,method,'write-input-full',JSON.stringify(body));
  record(item.id,method,'local-edit',JSON.stringify({oldText:before,newText:after}));
  const write=await curl(config.apiUrl+'/pages/'+page.id,{method:'PUT',body,label:item.id+'-curl-update'});
  record(item.id,method,'write-output-raw',write.text);
  const written=JSON.parse(write.text);
  record(item.id,method,'write-output-filtered',JSON.stringify({id:written.id,version:written.version.number,status:written.status}));
  const final=(await restGet(page.id,item.id+'-curl-verification')).page;
  return {corpus:item.id,method,id:String(page.id),status:'saved',verification:verify(baseline,final.body.storage.value)};
}
async function runCfwiki(item, method, spaceId) {
  const {page,baseline} = await createPage(item,method,spaceId);
  const read=await cli(['read',String(page.id)]);
  record(item.id,method,'read-input',JSON.stringify({command:'cfwiki',args:['read',String(page.id),'--env',envFile]}));
  record(item.id,method,'read-output',read.stdout);
  const source=read.stdout;
  assert.equal(source.split(before).length,2,'Read output must contain the edit marker exactly once.');
  const baseFile=path.join(rawDir,item.id+'-'+method+'-base.md');
  const draftFile=path.join(rawDir,item.id+'-'+method+'-draft.md');
  await writeFile(baseFile,source,{mode:0o600});
  await writeFile(draftFile,source.replace(before,after),{mode:0o600});
  record(item.id,method,'local-edit',JSON.stringify({oldText:before,newText:after}));
  let write;
  if(method==='cfwiki-upload') {
    record(item.id,method,'write-input-full',source.replace(before,after));
    write=await cli(['upload',draftFile]);
  } else {
    record(item.id,method,'write-input',JSON.stringify({command:'cfwiki',args:['apply',draftFile,'--base',baseFile,'--space',config.spaceKey,'--json','--env',envFile]}));
    try { write=await cli(['apply',draftFile,'--base',baseFile,'--space',config.spaceKey,'--json']); }
    catch (error) {
      if (error.stdout) { record(item.id,method,'write-output',error.stdout); await save(item.id+'-'+method+'-refusal.json',error.stdout); }
      throw new Error(error.stdout ? 'cfwiki apply returned a refusal: ' + error.stdout.trim() : error.message);
    }
  }
  record(item.id,method,'write-output',write.stdout);
  if(write.stderr) record(item.id,method,'write-warnings',write.stderr);
  const final=(await restGet(page.id,item.id+'-'+method+'-verification')).page;
  return {corpus:item.id,method,id:String(page.id),status:'saved',verification:verify(baseline,final.body.storage.value)};
}
function deepFind(value, predicate) {
  if(!value || typeof value!=='object')return null;
  if(predicate(value))return value;
  for(const child of Object.values(value)){const found=deepFind(child,predicate);if(found)return found;}
  return null;
}
async function runMcp(item,method,spaceId) {
  const {page,baseline}=await createPage(item,method,spaceId);
  const format=method==='mcp-markdown'?'markdown':'html';
  const read=await tool('getConfluenceContent',{cloudId,content_id:String(page.id),detail:'full',content_format:format},item.id+'-'+method+'-read');
  record(item.id,method,'read-input',read.input);
  record(item.id,method,'read-output',read.visible);
  record(item.id,method,'read-result-envelope',JSON.stringify(read.result),{wireOnly:true});
  const document=deepFind(read.payload,(value)=>value.body&&typeof value.body.value==='string');
  const snapshot=deepFind(read.payload,(value)=>typeof value.snapshotToken==='string')?.snapshotToken;
  assert.ok(document && snapshot,'MCP document read is missing body.value or snapshotToken.');
  assert.equal(document.body.value.split(before).length,2,'MCP content has no unique edit marker.');
  let args={cloudId,contentId:String(page.id),snapshotToken:snapshot};
  if(method==='mcp-edits') {
    const $=load(document.body.value);
    const node=$('[local-id], [data-local-id]').toArray().find((node)=>$(node).text()===before);
    const localId=node&&($(node).attr('local-id')??$(node).attr('data-local-id'));
    assert.ok(localId,'HTML response has no uniquely addressable local ID for the edit target.');
    args.edits=[{name:'replaceNode',localId,value:'<p>'+after+'</p>'}];
  } else args.body={format,value:document.body.value.replace(before,after)};
  const write=await tool('updateConfluenceContent',args,item.id+'-'+method+'-write');
  record(item.id,method,'write-input',write.input);
  record(item.id,method,'write-output',write.visible);
  record(item.id,method,'write-result-envelope',JSON.stringify(write.result),{wireOnly:true});
  const final=(await restGet(page.id,item.id+'-'+method+'-verification')).page;
  const failure = deepFind(write.payload, (value) => value.ok === false);
  if (failure) return {corpus:item.id,method,id:String(page.id),status:'refused',reason:failure.reason??'validation_failed',message:failure.guidance??failure.message,originalContentRetained:final.body.storage.value===baseline,verification:{passed:false,failures:['write-refused'],normalizations:[]}};
  return {corpus:item.id,method,id:String(page.id),status:'saved',verification:verify(baseline,final.body.storage.value)};
}
async function countTokens() {
  const python=values.python??'python3';
  const program='import json,sys,tiktoken\nvalues=json.load(sys.stdin)\nencodings={name:tiktoken.get_encoding(name) for name in ["o200k_base","cl100k_base"]}\nprint(json.dumps([{name:len(enc.encode(value,disallowed_special=())) for name,enc in encodings.items()} for value in values]))';
  return JSON.parse((await execute(python,['-c',program],{input:JSON.stringify(records.map((record)=>record.text)),timeout:120000})).stdout);
}
async function publishReport(mcpReady) {
  const tokens=await countTokens();
  for(let index=0;index<records.length;index++) { records[index].tokens=tokens[index]; await save(records[index].artifact,records[index].text); }
  const costs=(corpusId,method,phases)=>Object.fromEntries(['o200k_base','cl100k_base'].map((encoding)=>[encoding,records.filter((record)=>record.corpus===corpusId&&record.method===method&&phases.includes(record.phase)).reduce((sum,record)=>sum+record.tokens[encoding],0)]));
  const scenarios=[];
  for(const result of results) {
    if(result.status!=='saved')continue;
    const base={corpus:result.corpus,method:result.method,preservationPassed:result.verification.passed};
    if(result.method==='curl') {
      scenarios.push({...base,variant:'raw-full-body',tokens:costs(result.corpus,'curl',['read-input','read-output-raw','write-input-full','write-output-raw'])});
      scenarios.push({...base,variant:'filtered-full-body',tokens:costs(result.corpus,'curl',['read-input','read-output-filtered','write-input-full','write-output-filtered'])});
      scenarios.push({...base,variant:'filtered-local-patch',tokens:costs(result.corpus,'curl',['read-input','read-output-filtered','local-edit','write-output-filtered'])});
    } else scenarios.push({...base,variant:result.method==='cfwiki-apply'||result.method==='mcp-edits'?'local-or-granular-patch':'full-body',tokens:costs(result.corpus,result.method,['read-input','read-output','write-input','write-input-full','write-output',...(result.method==='cfwiki-apply'?['local-edit']:[])])});
  }
  const report={schema:1,measuredAt:new Date().toISOString(),runId,environment:{node:process.version,packageVersion:JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version,tokenizer:'tiktoken 0.12.0',encodings:['o200k_base','cl100k_base'],mcpEndpoint:mcpUrl,mcpReady},methodology:{scope:'Exact tokenizer counts of captured synthetic document reads, serialized update inputs, and command outputs; not provider-billed session usage.',auth:'Authorization headers/config and API tokens excluded. No model API calls were made.',creation:'Each method creates a fresh child under the explicit confirmed test parent; setup creation excluded from read/edit workflow totals.',filtering:'curl filtered variants use actual read/update responses projected to required fields. Local-patch variants count a small literal replacement instead of returning full local file content to the model.',safety:'Content verification compares visible text in order, macro names/parameters, links, task states, table-cell counts, and code text after an independent REST re-read. Generated task IDs, inter-block layout whitespace, one final code newline, javascript/js language aliases, and a panel title moved into visible body are accepted normalizations and are not byte equality. It is not complete visual fidelity verification.',overhead:'Session tool schemas and authoring prerequisites are recorded separately; wire/result envelopes are marked wireOnly and excluded from scenario totals.',limitations:['CLI local-patch and filtered curl local-patch use local file manipulation; any coding agent can implement equivalent local preprocessing.','Tool call scaffolding, hidden reasoning, cache hits, history replay, client context injection and billing are not measured.','Failed or lossy methods must not be compared as successful token savings.','MCP Markdown replacement on rich native content is an explicit stress case; the official format guide recommends HTML for such edits.']},corpus:corpus.filter((item)=>!values.corpus||values.corpus.split(',').includes(item.id)).map((item)=>({id:item.id,title:item.title,storageBytes:Buffer.byteLength(item.storage),sha256:createHash('sha256').update(item.storage).digest('hex')})),results:results.map((result)=>({...result,verification:result.verification?{passed:result.verification.passed,failures:result.verification.failures,normalizations:result.verification.normalizations}:undefined})),scenarios,artifacts:records.map(({text,...record})=>record),errors,createdPages:manifest.map(({baseline,setupVerification,...entry})=>({...entry,setupVerification:setupVerification?{passed:setupVerification.passed,failures:setupVerification.failures}:undefined}))};
  const output=path.resolve(values.output??path.join(root,'docs/benchmarks/2026-10-15.json'));
  await mkdir(path.dirname(output),{recursive:true});
  await writeFile(output,JSON.stringify(sanitizePublic(report),null,2)+'\n');
  await persist();
  emit({output,rawDir,results:report.results,mcpReady,scenarios:scenarios.length});
}
try {
  if (values.finalize) {
    assert.ok(values.resume, '--finalize requires --resume RAW_DIRECTORY and performs reads only.');
    for (const result of results) {
      const entry = manifest.find((entry) => entry.key === result.corpus + ':' + result.method);
      if (!entry?.id) continue;
      const current = (await restGet(entry.id, result.corpus + '-' + result.method + '-final-audit')).page;
      result.id = entry.id;
      if (result.method.startsWith('mcp-')) {
        const output = records.findLast((record) => record.corpus === result.corpus && record.method === result.method && record.phase === 'write-output');
        let failure;
        if (output) { try { failure = deepFind(JSON.parse(output.text), (value) => value.ok === false); } catch {} }
        if (failure) {
          result.status = 'refused'; result.reason = failure.reason ?? 'validation_failed'; result.message = failure.guidance ?? failure.message;
          result.originalContentRetained = current.body.storage.value === entry.baseline;
          result.verification = { passed: false, failures: ['write-refused'], normalizations: [] };
          continue;
        }
      }
      if (result.method === 'cfwiki-apply' && result.status === 'failed') {
        const output = records.findLast((record) => record.corpus === result.corpus && record.method === result.method && record.phase === 'write-output');
        if (output) { try { const refusal = JSON.parse(output.text); result.status = refusal.status === 'partial' ? 'partial' : 'refused'; result.reason = refusal.status; result.message = refusal.message ?? 'cfwiki apply returned a safe conflict'; } catch {} }
      }
      result.verification = verify(entry.baseline, current.body.storage.value);
      if (!entry.setupVerification) entry.setupVerification = verify(corpus.find((item) => item.id === entry.corpus).storage, entry.baseline.replace(before, after));
    }
    await publishReport(true);
    process.exit(0);
  }
  const parent=(await restGet(values.parent,'verify-parent')).page;
  assert.equal(parent.status,'current');
  const spaceId=parent.spaceId;
  let mcpReady=false;
  try {
    const initialized=await mcp('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'cfwiki-token-benchmark',version:'1'}},'initialize');
    record('session','official-mcp','initialize-result',JSON.stringify(initialized.result),{wireOnly:true});
    const listed=await mcp('tools/list',{},'tools-list');
    record('session','official-mcp','tool-schemas',JSON.stringify(listed.result));
    try {
      const accessible=await tool('getAccessibleAtlassianResources',{},'accessible-resources');
      record('session','official-mcp','accessible-input',accessible.input);
      record('session','official-mcp','accessible-output',accessible.visible);
    } catch(error) {errors.push({phase:'getAccessibleAtlassianResources',message:error.message});}
    const parentContent=await tool('getConfluenceContent',{cloudId,content_id:values.parent,detail:'full',content_format:'html'},'parent-content');
    await save('probe-root-content.json',JSON.stringify(parentContent.payload,null,2));
    const spaceDiscovery=await tool('discover',{query:'get confluence space instructions getConfluenceSpace'},'discover-space');
    const guideDiscovery=await tool('discover',{query:'getContentFormatGuide updateConfluencePage'},'discover-guide');
    for(const [name,operation]of [['space',spaceDiscovery],['guide',guideDiscovery]]){
      record('session','official-mcp','discover-'+name+'-input',operation.input);record('session','official-mcp','discover-'+name+'-output',operation.visible);await save('probe-'+name+'-discovery.json',JSON.stringify(operation.payload,null,2));
    }
    const spaceGuide=await tool('executeRead',{cloudId,name:'getConfluenceSpace',inputs:{spaceIdOrKey:String(spaceId)}},'space-instructions');
    const formatGuide=await tool('executeRead',{cloudId,name:'getContentFormatGuide',inputs:{toolName:'updateConfluencePage'}},'format-guide');
    for(const [name,operation]of [['space-instructions',spaceGuide],['format-guide',formatGuide]]){record('session','official-mcp',name+'-input',operation.input);record('session','official-mcp',name+'-output',operation.visible);await save(name+'.json',JSON.stringify(operation.payload,null,2));}
    mcpReady=true;
  } catch(error) {errors.push({phase:'official-mcp-setup',message:error.message});await save('mcp-setup-failure.json',JSON.stringify({message:error.message},null,2));}
  if(values.probe){await persist();emit({probe:mcpReady?'passed':'blocked',rawDir,errors});process.exit(mcpReady?0:1);}
  const selected=corpus.filter((item)=>!values.corpus||values.corpus.split(',').includes(item.id));
  const methods=(values.methods??'curl,cfwiki-upload,cfwiki-apply,mcp-markdown,mcp-html,mcp-edits').split(',');
  assert.ok(selected.length,'No corpus matches --corpus.');
  assert.ok(methods.every((method)=>['curl','cfwiki-upload','cfwiki-apply','mcp-markdown','mcp-html','mcp-edits'].includes(method)),'Unknown --methods value.');
  for(const item of selected)for(const method of methods){
    const completed=results.find((result)=>result.corpus===item.id&&result.method===method&&result.status==='saved');
    if(completed)continue;
    for(let index=results.length-1;index>=0;index--)if(results[index].corpus===item.id&&results[index].method===method)results.splice(index,1);
    for(let index=records.length-1;index>=0;index--)if(records[index].corpus===item.id&&records[index].method===method)records.splice(index,1);
    if(method.startsWith('mcp-')&&!mcpReady){results.push({corpus:item.id,method,status:'blocked',reason:errors.findLast((error)=>error.phase==='official-mcp-setup')?.message??'Official MCP setup failed.'});await persist();continue;}
    try{const result=method==='curl'?await runCurl(item,spaceId):method.startsWith('cfwiki-')?await runCfwiki(item,method,spaceId):await runMcp(item,method,spaceId);results.push(result);emit({corpus:item.id,method,status:result.status,preservationPassed:result.verification.passed});}
    catch(error){results.push({corpus:item.id,method,status:'failed',message:error.message});errors.push({corpus:item.id,method,message:error.message});emit({corpus:item.id,method,status:'failed',message:error.message});}
    await persist();
  }
  await publishReport(mcpReady);
} catch(error) {
  await persist();await save('failure.json',JSON.stringify({message:error.message,errors,manifest},null,2));
  process.stderr.write(sanitizeMessage(error.message)+'\n');process.exitCode=1;
}
