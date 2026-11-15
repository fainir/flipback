import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { decide } from '../hooks/flipback.mjs';

function stopEvent(sample) {
  return {
    transcript_path: fileURLToPath(new URL(`../test/fixtures/${sample}.jsonl`, import.meta.url)),
    stop_hook_active: false,
  };
}

const complete = await decide(stopEvent('complete'), {
  env: {},
  ask() {
    throw new Error('The finished sample reached the judge.');
  },
});
assert.equal(complete, null);
console.log('Finished sample can stop.');

const instruction = 'Write the tests for slugify(), then add the README example.';
const incomplete = await decide(stopEvent('incomplete'), {
  env: {},
  ask: () => ({ complete: false, message: instruction }),
});
assert.ok(incomplete?.startsWith(instruction), 'Expected the unfinished sample to be blocked.');
console.log('\nUnfinished sample receives this Stop hook message.\n');
process.stdout.write(incomplete);
