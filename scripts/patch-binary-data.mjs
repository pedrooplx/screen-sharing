// @ts-nocheck -- build-time patch, run via `node scripts/patch-binary-data.mjs`
/**
 * Patches node_modules/@shinyoshiaki/binary-data (a werift dependency) so it
 * packages correctly with electron-builder.
 *
 * The package vendors three private helper folders - lib/, types/, internal/
 * - by nesting them in `src/node_modules/`, then reaching them from `src/*.js`
 * with bare specifiers (`require('lib/foo')`) instead of relative ones. That
 * is a real, working Node trick on a normal filesystem: node_modules/lib
 * looks like a package named "lib" to the resolver. It is NOT something any
 * packager expects, though - electron-builder's production-dependency walker
 * only ever discovers node_modules entries that are declared as real
 * dependencies somewhere, so this nested node_modules (declared nowhere -
 * it's not in binary-data's own package.json) is silently dropped from the
 * packaged app no matter what `files`/`asarUnpack`/`extraResources` glob you
 * throw at it (all confirmed by hand before writing this). The result: a
 * "Cannot find module 'lib/binary-stream'" crash dialog on first launch of
 * the packaged .exe, even though the exact same build runs fine unpacked.
 *
 * Fix: rename the vendor folder off the magic name `node_modules` (so it's
 * just ordinary source electron-builder has no reason to touch) and rewrite
 * every bare `require('lib/x')`/`require('types/x')`/`require('internal/x')`
 * to the equivalent relative path. Idempotent - safe to run after every
 * `npm install` (wired into `npm run dist:win`), since a fresh install
 * restores the original, unpatched package.
 */

import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const pkgSrc = join(root, 'node_modules', '@shinyoshiaki', 'binary-data', 'src');
const oldVendorDir = join(pkgSrc, 'node_modules');
const vendorDir = join(pkgSrc, 'vendor');
const VENDOR_NAMES = ['lib', 'types', 'internal'];

function rewriteBareRequires(filePath, depth) {
  const prefix = depth === 0 ? './vendor/' : '../'.repeat(depth) + '';
  const before = readFileSync(filePath, 'utf8');
  const after = before.replace(
    /require\((['"])(lib|types|internal)\/([^'"]+)\1\)/g,
    (_m, quote, folder, rest) => `require(${quote}${prefix}${folder}/${rest}${quote})`,
  );
  if (after !== before) writeFileSync(filePath, after, 'utf8');
}

function walk(dir, fn) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, fn);
    else if (entry.endsWith('.js')) fn(full);
  }
}

function main() {
  if (!existsSync(pkgSrc)) {
    console.log('@shinyoshiaki/binary-data not installed - nothing to patch, skipping.');
    return;
  }
  if (existsSync(vendorDir)) {
    console.log('binary-data already patched (src/vendor exists) - skipping.');
    return;
  }
  if (!existsSync(oldVendorDir)) {
    console.log('binary-data src/node_modules not found - already patched or package changed shape?');
    return;
  }

  renameSync(oldVendorDir, vendorDir);

  // files that moved from src/node_modules/{lib,types,internal}/*.js to
  // src/vendor/{lib,types,internal}/*.js reference siblings one level up
  // (lib/x.js -> ../types/y): depth 1.
  for (const name of VENDOR_NAMES) {
    const dir = join(vendorDir, name);
    if (existsSync(dir)) walk(dir, (f) => rewriteBareRequires(f, 1));
  }

  // src/index.js reaches into src/vendor/{lib,types}: depth 0 (uses the
  // './vendor/' prefix directly, handled by rewriteBareRequires(_, 0)).
  const indexJs = join(pkgSrc, 'index.js');
  if (existsSync(indexJs)) rewriteBareRequires(indexJs, 0);

  console.log('patched @shinyoshiaki/binary-data: src/node_modules -> src/vendor, requires rewritten.');
}

main();
