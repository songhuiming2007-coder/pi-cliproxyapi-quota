import test from 'node:test';
import assert from 'node:assert/strict';
import extension, { providerFromModel, parseQuotaSummary, windowsForModel, collectQuota, summaryFromWins, formatReset } from './index.ts';

const now = Date.parse('2026-09-27T12:00:00Z');
const resetTime = '2026-09-27T15:00:00Z';
const model = id => ({provider:'cliproxy-antigravity',id});
const payload = {groups:[
 {displayName:'Gemini Models',buckets:[
  {bucketId:'gemini-weekly',window:'weekly',remainingFraction:.99,resetTime},
  {bucketId:'gemini-5h',window:'5h',remainingFraction:.98,resetTime}]},
 {displayName:'Claude and GPT models',buckets:[
  {bucketId:'3p-weekly',window:'weekly',remainingFraction:.81,resetTime},
  {bucketId:'3p-5h',window:'5h',remainingFraction:.63,resetTime}]}
]};
const ag = {name:'synthetic-ag.json',provider:'antigravity',auth_index:'test-ag',project_id:'synthetic-project'};
const claude = {name:'synthetic-claude.json',provider:'claude',auth_index:'test-claude'};

function installFetch(t, credentials=[ag], data=payload) {
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(url.endsWith('/auth-files'))return {ok:true,json:async()=>({files:credentials})};
  assert.ok(url.endsWith('/api-call'));
  const req=JSON.parse(options.body);
  if(req.authIndex==='test-claude')return {ok:true,json:async()=>({status_code:200,body:JSON.stringify({five_hour:{utilization:10,resets_at:resetTime},seven_day:{utilization:20,resets_at:resetTime}})})};
  assert.equal(req.header.Authorization,'Bearer $TOKEN$');
  return {ok:true,json:async()=>({status_code:200,body:JSON.stringify(data)})};
 });
}

test('explicit Antigravity provider wins over Claude and GPT model names',()=>{
 for(const id of ['claude-opus-4-6-thinking','claude-sonnet-4-6','gpt-oss-120b-medium','gemini-3-flash'])assert.equal(providerFromModel(model(id)),'antigravity');
 assert.equal(providerFromModel({provider:'anthropic',id:'claude-opus-4-6'}),'claude');
 assert.equal(providerFromModel({provider:'openai-codex',id:'gpt-6-astra'}),'codex');
});

test('selects matching pool and puts five-hour before weekly regardless of upstream order',()=>{
 const wins=parseQuotaSummary(JSON.stringify(payload));
 assert.equal(wins.length,4);
 assert.deepEqual(windowsForModel(wins,model('claude-opus-4-6-thinking')).map(w=>w.remainingPct),[63,81]);
 assert.deepEqual(windowsForModel(wins,model('gpt-oss-120b-medium')).map(w=>w.remainingPct),[63,81]);
 assert.deepEqual(windowsForModel(wins,model('gemini-3-flash')).map(w=>w.remainingPct),[98,99]);
 assert.deepEqual(windowsForModel(wins,model('unknown-alias')),[]);
});

test('bucket IDs survive group renaming, known labels support older responses',()=>{
 const renamed=structuredClone(payload);renamed.groups[1].displayName='Renamed';
 assert.equal(windowsForModel(parseQuotaSummary(JSON.stringify(renamed)),model('claude-opus')).length,2);
 const legacy=structuredClone(payload);for(const g of legacy.groups)for(const b of g.buckets)delete b.bucketId;
 assert.equal(windowsForModel(parseQuotaSummary(JSON.stringify(legacy)),model('gemini-pro')).length,2);
});

test('active Claude via Antigravity shows third-party pool; details retain both groups',async t=>{
 installFetch(t,[claude,ag]);
 const {footer,blocks}=await collectQuota('http://proxy.test','synthetic-key',now,'antigravity',model('claude-opus-4-6-thinking'));
 assert.match(footer,/5h 63%.*7d 81%/);assert.doesNotMatch(footer,/98%|99%|90%/);
 assert.match(blocks.join('\n'),/Gemini Models/);assert.match(blocks.join('\n'),/Claude and GPT models/);
});

test('missing pool, unknown alias, or multiple accounts never fall back to unrelated quota',async t=>{
 installFetch(t,[claude,ag],{groups:[payload.groups[0]]});
 assert.equal((await collectQuota('http://proxy.test','synthetic-key',now,'antigravity',model('claude-opus'))).footer,'');
 assert.equal((await collectQuota('http://proxy.test','synthetic-key',now,'antigravity',model('unknown'))).footer,'');
});

test('multiple Antigravity accounts retain details without choosing one for footer',async t=>{
 installFetch(t,[ag,{...ag,name:'other.json',auth_index:'other'}]);
 const result=await collectQuota('http://proxy.test','synthetic-key',now,'antigravity',model('gemini-pro'));
 assert.equal(result.footer,'');assert.equal(result.blocks.filter(x=>x.startsWith('●')).length,2);
});

test('existing direct-Claude and legacy collectQuota callers still work',async t=>{
 installFetch(t,[claude,ag]);
 assert.match((await collectQuota('http://proxy.test','synthetic-key',now,'claude',{provider:'anthropic',id:'claude-opus'})).footer,/5h 90%.*7d 80%/);
 assert.ok((await collectQuota('http://proxy.test','synthetic-key',now)).footer);
 assert.equal(formatReset(null,now),'—');
 assert.equal(summaryFromWins([{label:'5-hour',remainingPct:99.96,resetIso:resetTime}],now),'Quota 5h 100% left');
});

test('late request for previous model cannot overwrite new-model status',async t=>{
 const oldKey=process.env.CLIPROXYAPI_MANAGEMENT_KEY;process.env.CLIPROXYAPI_MANAGEMENT_KEY='synthetic-key';
 t.after(()=>{if(oldKey===undefined)delete process.env.CLIPROXYAPI_MANAGEMENT_KEY;else process.env.CLIPROXYAPI_MANAGEMENT_KEY=oldKey});
 let release;let count=0;const statuses=[];const hooks={};
 t.mock.method(globalThis,'fetch',async(url)=>{
  if(url.endsWith('/auth-files'))return {ok:true,json:async()=>({files:[ag]})};
  if(++count===1)await new Promise(r=>release=r);
  return {ok:true,json:async()=>({status_code:200,body:JSON.stringify(payload)})};
 });
 extension({on:(name,fn)=>hooks[name]=fn,registerCommand:()=>{},registerShortcut:()=>{}});
 const ctx={hasUI:true,mode:'tui',model:model('gemini-3-flash'),ui:{setStatus:(_,text)=>statuses.push(text),theme:{fg:(_,text)=>text},notify:()=>{}}};
 hooks.model_select({},ctx);while(!release)await new Promise(r=>setImmediate(r));
 ctx.model=model('claude-opus-4-6-thinking');hooks.model_select({},ctx);await new Promise(r=>setImmediate(r));
 assert.match(statuses.at(-1),/63%.*81%/);release();await new Promise(r=>setImmediate(r));assert.match(statuses.at(-1),/63%.*81%/);
});
