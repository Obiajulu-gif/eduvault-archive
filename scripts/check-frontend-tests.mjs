#!/usr/bin/env node
import {glob} from 'glob';

const patterns = [
  'src/**/*.test.*',
  'src/**/__tests__/**/*.*',
  'tests/frontend/**/*.test.*',
  'tests/frontend/**/__tests__/**/*.*'
];

async function main(){
  for(const p of patterns){
    const matches = await glob(p, {nocase: true});
    if(matches && matches.length > 0){
      console.log('Found frontend tests.');
      process.exit(0);
    }
  }

  console.error('\nERROR: No frontend tests detected.');
  console.error('Add frontend tests under src/ or tests/frontend/ or update CI if intentional.');
  console.error('See CONTRIBUTING.md for the canonical CI commands.\n');
  process.exit(1);
}

main().catch(err => {
  console.error('Failed to check frontend tests:', err);
  process.exit(1);
});
