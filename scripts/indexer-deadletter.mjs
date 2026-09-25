#!/usr/bin/env node
import {
  listDeadLetterEvents,
  quarantineDeadLetter,
  retryDeadLetter,
} from '../src/lib/indexer/stellarIndexer.js';
import { getDb } from '../src/lib/mongodb.js';

const [command, ...args] = process.argv.slice(2);
const db = await getDb();
const operator = process.env.INDEXER_OPERATOR || 'cli';

if (command === 'list') {
  const status = args.find((arg) => arg.startsWith('--status='))?.split('=')[1];
  const limit = Number(args.find((arg) => arg.startsWith('--limit='))?.split('=')[1] || 50);
  const events = await listDeadLetterEvents(db, { status, limit });
  console.log(JSON.stringify(events, null, 2));
  process.exit(0);
}

if (command === 'retry') {
  const eventId = args[0];
  if (!eventId) {
    console.error('Usage: node scripts/indexer-deadletter.mjs retry <eventId>');
    process.exit(1);
  }
  const result = await retryDeadLetter(db, eventId, { operator });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

if (command === 'quarantine') {
  const eventId = args[0];
  const reasonFlag = args.find((arg) => arg.startsWith('--reason='));
  const reason = reasonFlag?.split('=').slice(1).join('=');
  if (!eventId || !reason) {
    console.error('Usage: node scripts/indexer-deadletter.mjs quarantine <eventId> --reason="..."');
    process.exit(1);
  }
  const result = await quarantineDeadLetter(db, eventId, { reason, operator });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

console.error('Usage: node scripts/indexer-deadletter.mjs <list|retry|quarantine> ...');
process.exit(1);
