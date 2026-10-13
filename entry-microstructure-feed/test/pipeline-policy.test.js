import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'../..');

test('canonical pipeline prompt pre-authorizes watcher sync without order execution', async()=>{
  const text=await readFile(path.join(root,'PIPELINE_PROMPT.md'),'utf8');
  assert.match(text,/Watcher auto-sync — no confirmation required/);
  assert.match(text,/update them immediately without asking the user for a separate confirmation/);
  assert.match(text,/npm run watcher:sync/);
  assert.match(text,/NEVER automatically place, amend, cancel, replace or close/);
  assert.match(text,/explicit user instruction/);
});
