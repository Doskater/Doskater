import {promises as fs} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {getWatcherConfig} from '../trigger-watcher.js';
import {readCandidate,appendEntryEvent} from '../entry-journal.js';
import {runFocusedRevalidation} from '../focused-revalidation.js';

function parseArgs(args) {
  const flags={};
  for(let i=0;i<args.length;i+=2) {
    if(!['--candidate-id','--context'].includes(args[i]) || typeof args[i+1]!=='string' ||
      !args[i+1] || args[i+1].startsWith('--') || flags[args[i]])throw Error('usage: revalidate-entry.js --candidate-id ID --context FILE');
    flags[args[i]]=args[i+1];
  }
  if(!flags['--candidate-id'] || !flags['--context'])throw Error('usage: revalidate-entry.js --candidate-id ID --context FILE');
  return flags;
}

export async function runRevalidationCli(args,{
  fsImpl=fs,fetchImpl=fetch,now=Date.now,stdout=value=>process.stdout.write(value),config=getWatcherConfig(),policy={}
}={}) {
  const flags=parseArgs(args);
  const candidate=await readCandidate(flags['--candidate-id'],{journalFile:config.journalFile,fsImpl});
  const source=await fsImpl.readFile(flags['--context'],'utf8');
  let context;
  try {context=JSON.parse(source);}catch{throw Error('context_invalid_json');}
  const base=new URL(config.feedUrl);
  if(base.protocol!=='http:' || !['127.0.0.1','localhost'].includes(base.hostname) || base.username || base.password)throw Error('invalid_local_feed_url');
  const result=await runFocusedRevalidation(candidate,context,{
    initialSnapshot:candidate.microstructure,now,policy,
    getLiveSnapshot:async(symbol,{signal})=>{
      const url=new URL('/v1/microstructure/'+encodeURIComponent(symbol),base).href;
      const response=await fetchImpl(url,{method:'GET',signal,cache:'no-store'});
      if(!response.ok)throw Error('feed_snapshot_failed');
      return response.json();
    },
    appendEvent:event=>appendEntryEvent(event,{journalFile:config.journalFile,fsImpl})
  });
  stdout(JSON.stringify(result,null,2)+'\n');
}
if(process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]) {
  runRevalidationCli(process.argv.slice(2)).catch(error=>{
    process.stderr.write(JSON.stringify({error:error.message})+'\n');
    process.exitCode=1;
  });
}
