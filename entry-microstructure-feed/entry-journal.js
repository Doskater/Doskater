import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID as uuid} from 'node:crypto';

export function createCandidate(setup,snapshot,{now=Date.now,randomUUID=uuid}={}) {
  const canonical=JSON.stringify(Object.fromEntries(Object.entries(setup).sort(([a],[b])=>a.localeCompare(b))));
  return {
    schemaVersion:1,candidateId:randomUUID(),setupId:createHash('sha256').update(canonical).digest('hex'),
    symbol:setup.symbol,side:setup.side,triggerPrice:setup.triggerPrice,
    observedPrice:Number(snapshot.currentMid),detectedAt:now(),microstructure:structuredClone(snapshot),
    watcherPolicy:{minImbalance:setup.minImbalance,requireImpact:setup.requireImpact,absorptionVeto:setup.absorptionVeto}
  };
}

export async function appendEntryEvent(event,{journalFile,fsImpl=fs}={}) {
  if(!journalFile)throw Error('journal_file_required');
  if(!['ENTRY_CANDIDATE','REVALIDATION_DECISION'].includes(event?.event) ||
    typeof event.candidateId!=='string' || typeof event.setupId!=='string' ||
    !Number.isSafeInteger(event.timestamp))throw Error('invalid_journal_event');
  await fsImpl.mkdir(path.dirname(journalFile),{recursive:true,mode:0o700});
  await fsImpl.appendFile(journalFile,JSON.stringify({...event,schemaVersion:1})+'\n',{mode:0o600});
}

export async function readCandidate(candidateId,{journalFile,fsImpl=fs}={}) {
  const content=await fsImpl.readFile(journalFile,'utf8');
  let rows;
  try {
    rows=content.split('\n').filter(line=>line.trim()).map(line=>JSON.parse(line));
    if(rows.some(row=>row.schemaVersion!==1 || !['ENTRY_CANDIDATE','REVALIDATION_DECISION'].includes(row.event) ||
      typeof row.candidateId!=='string' || typeof row.setupId!=='string' ||
      !Number.isSafeInteger(row.timestamp) ||
      (row.event==='ENTRY_CANDIDATE' && (row.candidate?.candidateId!==row.candidateId || row.candidate?.setupId!==row.setupId))))throw Error('invalid');
  }catch{throw Error('journal_corrupt');}
  const row=rows.find(row=>row.event==='ENTRY_CANDIDATE' && row.candidateId===candidateId);
  if(!row)throw Error('candidate_not_found');
  return row.candidate;
}
