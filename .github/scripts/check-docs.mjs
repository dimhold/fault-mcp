/**
 * The README has to describe the program that exists.
 *
 *   node .github/scripts/check-docs.mjs
 *
 * Two lists live in two places each. The faults are FAULT_KINDS in
 * src/config.ts and a table in the README; the profiles are files in
 * profiles/ and a table in the README. A fault added without a row leaves the
 * README describing a program that no longer exists, and the card generator in
 * the social-media repository reads that same README table to draw a public
 * picture. So the two are compared here rather than trusted.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let failures = 0;
const fail = (message) => {
  failures += 1;
  console.log(`  FAIL  ${message}`);
};

const readme = read('README.md');

// --- faults ------------------------------------------------------------------

const config = read('src/config.ts');
const kindsMatch = config.match(/FAULT_KINDS\s*=\s*\[([^\]]+)\]/);
if (!kindsMatch) {
  fail('FAULT_KINDS not found in src/config.ts, so nothing can be compared');
} else {
  const kinds = [...kindsMatch[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]).sort();

  // Rows in the README look like: | `error` | ... | ... |
  const documented = [...readme.matchAll(/^\|\s*`([a-z-]+)`\s*\|/gm)].map((m) => m[1]);
  const missing = kinds.filter((k) => !documented.includes(k));

  if (missing.length) fail(`faults with no README row: ${missing.join(', ')}`);
  else console.log(`  ok    all ${kinds.length} faults are documented: ${kinds.join(', ')}`);
}

// --- profiles ----------------------------------------------------------------

const onDisk = readdirSync(join(ROOT, 'profiles'))
  .filter((f) => /\.(json|yaml)$/.test(f))
  .map((f) => f.replace(/\.(json|yaml)$/, ''))
  .sort();

const table = readme.split('--list-profiles')[1] ?? '';
const documentedProfiles = [...new Set(
  [...table.matchAll(/^\|\s*`([a-z-]+)`\s*\|/gm)].map((m) => m[1]),
)].sort();

const missingRows = onDisk.filter((p) => !documentedProfiles.includes(p));
const missingFiles = documentedProfiles.filter((p) => !onDisk.includes(p));

if (missingRows.length) fail(`profiles with no README row: ${missingRows.join(', ')}`);
if (missingFiles.length) fail(`README documents profiles that do not exist: ${missingFiles.join(', ')}`);
if (!missingRows.length && !missingFiles.length) {
  console.log(`  ok    all ${onDisk.length} profiles are documented`);
}

// --- the install line --------------------------------------------------------

// The README told people to run `npx faultmcp` for nine days while the package
// was not on the registry at all. Whatever it claims, it has to be installable.
if (/npx\s+faultmcp/.test(readme) || /npm\s+i(nstall)?\s+(-g\s+)?faultmcp/.test(readme)) {
  console.log('  ok    the README tells people how to install it');
} else {
  fail('the README never says how to install the package');
}

console.log(failures === 0 ? '  ok    the README matches the code' : `\n${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
