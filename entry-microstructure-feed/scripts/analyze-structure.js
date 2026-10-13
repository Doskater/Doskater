import {promises as fs} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {CORE_SYMBOLS} from '../config.js';
import {getWatcherConfig,readSetups} from '../trigger-watcher.js';
import {readCandidate} from '../entry-journal.js';
import {runStructurePipeline,syncStructureWatchers,buildStructuralContext,readPublicCandles} from '../mtf-pipeline.js';

function parseArgs(args) {
  const flags={};
  const valued=['--symbols','--source','--roles','--input','--candidate-id','--execution'];
  for(let i=0;i<args.length;i++) {
    const flag=args[i];
    if(flag in flags || ![...valued,'--sync-watchers'].includes(flag))throw Error('usage: analyze-structure.js [--symbols CSV] [--source FAMILY] [--roles JSON] [--input FILE] [--sync-watchers] [--candidate-id ID --execution FILE]');
    if(flag==='--sync-watchers'){flags[flag]=true;continue;}
    const value=args[++i];
    if(typeof value!=='string'||!value||value.startsWith('--'))throw Error('usage: flag_value_required');
    flags[flag]=value;
  }
  if(Boolean(flags['--candidate-id'])!==Boolean(flags['--execution']))throw Error('usage: candidate_and_execution_required');
  return flags;
}
export async function runStructureCli(args,{fsImpl=fs,reader=readPublicCandles,now=Date.now,
  stdout=value=>process.stdout.write(value),config=getWatcherConfig()}={}) {
  const flags=parseArgs(args);
  const doc=flags['--input']?JSON.parse(await fsImpl.readFile(flags['--input'],'utf8')):{};
  const watched=flags['--symbols']||doc.symbols?[]:await readSetups({config,fsImpl});
  const symbols=flags['--symbols']?.split(',') ?? doc.symbols ?? [...new Set([...CORE_SYMBOLS,...watched.map(s=>s.symbol)])];
  const source=flags['--source'] ?? doc.source ?? 'binance:perp';
  const roles=flags['--roles']?JSON.parse(flags['--roles']):doc.roles;
  const results=await runStructurePipeline({symbols,source,roles,asOf:doc.asOf ?? now(),
    framesBySymbol:flags['--input']?(doc.framesBySymbol ?? {}):undefined,options:doc.options,reader});
  const output={results};
  if(flags['--candidate-id']) {
    const candidate=await readCandidate(flags['--candidate-id'],{journalFile:config.journalFile,fsImpl});
    const result=results.find(r=>r.symbol===candidate.symbol);
    if(!result)throw Error('candidate_symbol_not_analyzed');
    const execution=JSON.parse(await fsImpl.readFile(flags['--execution'],'utf8'));
    output.context=buildStructuralContext(result,candidate,execution);
  }
  if(flags['--sync-watchers'])output.watcher=await syncStructureWatchers(results,{config,fsImpl});
  stdout(JSON.stringify(output,null,2)+'\n');
  return output;
}
if(process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]) {
  runStructureCli(process.argv.slice(2)).catch(error=>{
    process.stderr.write(JSON.stringify({error:error.message})+'\n');process.exitCode=1;
  });
}
