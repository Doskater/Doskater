import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ANALYST_PROTOCOL } from '../analyst-protocol.js';
import { assertNeutralPayload } from '../schema-guard.js';

const fixtures=['directional-momentum','crowded-funding','liquidation-continuation','liquidation-exhaustion','cointegrated-pair-divergence','negative-net-carry','no-valid-edge'];

test('analyst protocol contains every mandatory analysis stage', () => {
  for (const label of ['VALIDATE','UNIVERSE','MOMENTUM','DIRECTIONAL','STAT ARB','CARRY','MICROSTRUCTURE','CHALLENGE','COST','RISK','DECIDE']) {
    assert.match(ANALYST_PROTOCOL,new RegExp(label,'i'),label);
  }
});

test('fixture datasets cover every protocol branch using neutral market facts only', async () => {
  const seen=new Set();
  for(const name of fixtures){
    const raw=await readFile(new URL(`./fixtures/${name}.json`,import.meta.url),'utf8');
    const fixture=JSON.parse(raw);
    assert.equal(fixture.name,name);
    assert.ok(Array.isArray(fixture.enables) && fixture.enables.length>0);
    fixture.enables.forEach(x=>seen.add(x));
    assert.doesNotThrow(()=>assertNeutralPayload(fixture.marketFacts));
    assert.equal('expectedDecision' in fixture,false);
  }
  for(const branch of ['directional','momentum','derivatives','liquidations','stat_arb','carry','microstructure','no_edge']) assert.ok(seen.has(branch),branch);
});
