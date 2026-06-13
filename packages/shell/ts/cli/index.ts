if (process.argv.includes('--async')) {
  process.argv.splice(process.argv.indexOf('--async'), 1);
  await import('./async.ts');
} else {
  await import('./worker.ts');
}
