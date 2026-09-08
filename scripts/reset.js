import fs from 'node:fs';
import config from '../src/config.js';

/**
 * Deletes the database. Development only, and it asks for --yes because the
 * corpus behind an entity costs real money to rebuild.
 */
if (!process.argv.includes('--yes')) {
  console.error(`This deletes ${config.dbPath} and every entity, document and score in it.`);
  console.error('Re-run with --yes if that is what you want:  npm run reset -- --yes');
  process.exit(1);
}

let removed = 0;
for (const suffix of ['', '-wal', '-shm']) {
  const file = config.dbPath + suffix;
  if (!fs.existsSync(file)) continue;
  try {
    fs.unlinkSync(file);
    removed += 1;
  } catch (err) {
    // Windows holds an open SQLite file exclusively, so a running server is
    // the usual cause here. Say that rather than printing a stack trace.
    if (err.code === 'EBUSY' || err.code === 'EPERM') {
      console.error(`Cannot delete ${file}: it is open in another process.`);
      console.error('Stop the server (Ctrl+C in the window running `npm start`) and run this again.');
      process.exit(1);
    }
    throw err;
  }
}
console.log(removed ? `Removed ${removed} database file(s).` : 'Nothing to remove.');
