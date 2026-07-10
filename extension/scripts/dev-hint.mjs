// Helper printed when running `npm run watch`.
// Chrome has no first-class extension hot-reload API for unpacked extensions
// from outside the browser. The cleanest UX is:
//   1. Run `npm run watch` — rebuilds on file change.
//   2. After a rebuild, click "Reload" on chrome://extensions for this extension.
// CRXJS would automate this but requires migrating the build to Vite.
// For now, keep it simple; this hint is printed by build.mjs on first run.
console.log(
  '\n[dev-hint] After each rebuild, click Reload on chrome://extensions for HAR Capture Suite.',
);
console.log('[dev-hint] Or install the "Extensions Reloader" extension and pin its button.\n');
