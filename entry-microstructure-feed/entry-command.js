import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {normalizeSymbol} from './config.js';
import {positiveNumber,units,decimalString} from './entry-numbers.js';

export function buildEntryPayload(decision) {
  if(decision?.stage!=='final' || !['ENTER_NOW','ENTER_REDUCED'].includes(decision.decision))throw Error('final_enter_required');
  if(normalizeSymbol(decision.symbol)!==decision.symbol || !['long','short'].includes(decision.side))throw Error('invalid_order_identity');
  if(!Number.isSafeInteger(decision.checkedAt) || typeof decision.candidateId!=='string' || !decision.candidateId)throw Error('invalid_order_timestamp');
  const entry=positiveNumber(decision.entry,'entry');
  const stop=positiveNumber(decision.invalidationPrice,'stop');
  const target=positiveNumber(decision.targets?.[0]?.price,'target');
  const qty=positiveNumber(decision.qty,'qty');
  const long=decision.side==='long';
  if(long?!(stop<entry && target>entry):!(stop>entry && target<entry))throw Error('invalid_order_geometry');
  const positionIdx=decision.positionIdx ?? 0;
  if(![0,long?1:2].includes(positionIdx))throw Error('invalid_position_idx');
  const orderLinkId='entry-'+createHash('sha256').update(decision.candidateId+':'+decision.checkedAt).digest('hex').slice(0,30);
  return {category:'linear',symbol:decision.symbol,side:long?'Buy':'Sell',orderType:'Limit',timeInForce:'IOC',
    qty:decimalString(units(decision.qty,'qty')),price:decimalString(units(entry,'entry')),stopLoss:decimalString(units(stop,'stop')),takeProfit:decimalString(units(target,'target')),
    positionIdx,reduceOnly:false,tpslMode:'Partial',tpOrderType:'Market',slOrderType:'Market',tpTriggerBy:'LastPrice',slTriggerBy:'LastPrice',orderLinkId};
}

const shellQuote=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
export function buildTerminalCommand(decision,{
  clientPath=fileURLToPath(new URL('../bybit-demo-execution-cloud/bybit-client.js',import.meta.url))
}={}) {
  const payload=buildEntryPayload(decision);
  const expiresAt=decision.expiresAt ?? decision.checkedAt+5000;
  if(!Number.isSafeInteger(expiresAt) || expiresAt<decision.checkedAt)throw Error('invalid_command_expiry');
  const source=[
    'if (Date.now() < '+decision.checkedAt+' || Date.now() > '+expiresAt+') throw new Error("command_expired_rerun_revalidation");',
    'const {createBybitClient}=await import('+JSON.stringify(pathToFileURL(clientPath).href)+');',
    'const client=createBybitClient({apiKey:process.env.BYBIT_DEMO_API_KEY,apiSecret:process.env.BYBIT_DEMO_API_SECRET});',
    'if (Date.now() < '+decision.checkedAt+' || Date.now() > '+expiresAt+') throw new Error("command_expired_rerun_revalidation");',
    'const result=await client.request("POST","/v5/order/create",'+JSON.stringify(payload)+');',
    'console.log(JSON.stringify(result));'
  ].join('\n');
  return 'node --input-type=module -e '+shellQuote(source);
}
