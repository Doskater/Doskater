import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {appendEntryEvent} from '../entry-journal.js';
import {candidate,context,snapshot,NOW} from './helpers/entry-fixtures.js';
let cli;try{cli=await import('../scripts/revalidate-entry.js');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'entry-cli-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const journalFile=path.join(dir,'entry-journal.jsonl'),contextFile=path.join(dir,'context.json');
  const c=candidate();
  await appendEntryEvent({event:'ENTRY_CANDIDATE',timestamp:c.detectedAt,candidateId:c.candidateId,setupId:c.setupId,candidate:c},{journalFile});
  await fs.writeFile(contextFile,JSON.stringify(context({apiKey:'SHOULD_NOT_LEAK'})));
  return {dir,journalFile,contextFile,c,config:{journalFile,feedUrl:'http://127.0.0.1:8791'}};
}
test('CLI prints final ENTER and journals RR using only read-only feed GET',async t=>{
  assert.equal(typeof cli?.runRevalidationCli,'function');
  const f=await fixture(t);const output=[];const requests=[];
  await cli.runRevalidationCli(['--candidate-id','candidate-1','--context',f.contextFile],{config:f.config,now:()=>NOW,stdout:s=>output.push(s),
    fetchImpl:async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>snapshot(4.91)};}});
  const r=JSON.parse(output.join(''));
  assert.equal(r.decision,'ENTER_REDUCED');assert.equal(r.entry,4.91);assert.ok(r.terminalCommand);
  assert.ok(Math.abs(r.currentRR-13/7)<1e-10);assert.equal(requests.length,1);
  assert.equal(requests[0].url,'http://127.0.0.1:8791/v1/microstructure/NEARUSDT');
  assert.equal(requests[0].options.method,'GET');assert.equal(requests[0].options.cache,'no-store');
  const journal=await fs.readFile(f.journalFile,'utf8');assert.equal(journal.includes('SHOULD_NOT_LEAK'),false);assert.equal(output.join('').includes('SHOULD_NOT_LEAK'),false);
  assert.equal(JSON.parse(journal.trim().split('\n').at(-1)).decision,'ENTER_REDUCED');
});
test('CLI WAIT has no command and missing candidate/context identity or malformed inputs cannot ENTER',async t=>{
  assert.equal(typeof cli?.runRevalidationCli,'function');
  const f=await fixture(t);let output='';
  const opts={config:f.config,now:()=>NOW,stdout:s=>output+=s,fetchImpl:async()=>({ok:true,json:async()=>snapshot(4.88)})};
  await cli.runRevalidationCli(['--candidate-id','candidate-1','--context',f.contextFile],opts);
  assert.equal(JSON.parse(output).decision,'WAIT_RETEST');assert.equal(JSON.parse(output).terminalCommand,undefined);
  await assert.rejects(cli.runRevalidationCli(['--candidate-id','unknown','--context',f.contextFile],opts),/candidate_not_found/);
  await fs.writeFile(f.contextFile,JSON.stringify(context({setupId:'other'})));
  await assert.rejects(cli.runRevalidationCli(['--candidate-id','candidate-1','--context',f.contextFile],opts),/identity_mismatch/);
  await fs.writeFile(f.contextFile,'SHOULD_NOT_LEAK');
  await assert.rejects(cli.runRevalidationCli(['--candidate-id','candidate-1','--context',f.contextFile],opts),/^Error: context_invalid_json$/);
  await assert.rejects(cli.runRevalidationCli([],opts),/usage/);
});
test('CLI HTTP failure is journaled WAIT without response secrets',async t=>{
  assert.equal(typeof cli?.runRevalidationCli,'function');
  const f=await fixture(t);let output='';
  await cli.runRevalidationCli(['--candidate-id','candidate-1','--context',f.contextFile],{config:f.config,now:()=>NOW,stdout:s=>output+=s,
    fetchImpl:async()=>({ok:false,status:503,json:async()=>({secret:'SHOULD_NOT_LEAK'})})});
  const r=JSON.parse(output);assert.equal(r.decision,'WAIT_RETEST');assert.equal(r.reason,'live_fetch_failed');assert.equal(output.includes('SHOULD_NOT_LEAK'),false);
});
test('real child CLI keeps generated command as text; guard detects execution or non-local requests',async t=>{
  assert.equal(typeof cli?.runRevalidationCli,'function');
  const f=await fixture(t);
  let requests=0;
  const server=http.createServer((req,res)=>{
    requests++;assert.equal(req.method,'GET');assert.equal(req.url,'/v1/microstructure/NEARUSDT');
    res.setHeader('Content-Type','application/json');
    const now=Date.now();const s=snapshot(4.91,{asOf:now});s.freshness.eventsByFamily['binance:spot']={lastTradeAt:now,lastBookAt:now};
    res.end(JSON.stringify(s));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const guard=path.join(f.dir,'guard.cjs');
  await fs.writeFile(guard,`const cp=require('node:child_process');for(const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[key]=()=>{throw Error('EXECUTION_FORBIDDEN');};require('node:module').syncBuiltinESMExports();const original=global.fetch;global.fetch=(url,opts)=>{if(new URL(url).hostname!=='127.0.0.1')throw Error('EXTERNAL_REQUEST_FORBIDDEN');return original(url,opts);};`);
  await fs.writeFile(f.contextFile,JSON.stringify(context({asOf:Date.now()})));
  const script=fileURLToPath(new URL('../scripts/revalidate-entry.js',import.meta.url));
  const result=await promisify(execFile)(process.execPath,['--require',guard,script,'--candidate-id','candidate-1','--context',f.contextFile],{
    env:{PATH:process.env.PATH,ENTRY_MICROSTRUCTURE_STATE_DIR:f.dir,ENTRY_MICROSTRUCTURE_PORT:String(server.address().port),BYBIT_DEMO_API_KEY:'FAKE_KEY',BYBIT_DEMO_API_SECRET:'FAKE_SECRET'},timeout:5000});
  const r=JSON.parse(result.stdout);assert.equal(r.decision,'ENTER_REDUCED');assert.ok(r.terminalCommand);
  assert.equal(requests,1);assert.equal(result.stderr,'');assert.equal(result.stdout.includes('FAKE_SECRET'),false);
});
