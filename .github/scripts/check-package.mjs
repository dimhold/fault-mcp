/**
 * Assert what npm would actually publish.
 *
 *   node .github/scripts/check-package.mjs
 *
 * The package is meant to be dist, profiles, README, LICENSE and
 * package.json. The first pack of this repository was 72 files containing 30
 * source maps, every one naming a src directory the tarball does not ship.
 * Nobody looks inside a tarball unless something makes them, so this looks,
 * on every push.
 */
import { spawnSync } from 'node:child_process';

const ALLOWED = [
  /^package\.json$/,
  /^README\.md$/,
  /^LICENSE$/,
  /^dist\/.+\.js$/,
  /^dist\/.+\.d\.ts$/,
  // The profiles are the product, not documentation: --profile reads them
  // out of the installed package.
  /^profiles\/.+\.(json|yaml)$/,
];

/** Things that have shipped by accident before, or would be a mistake to ship. */
const FORBIDDEN = [
  { pattern: /\.map$/, why: 'source maps point at a src directory the package does not contain' },
  { pattern: /^src\//, why: 'the sources are in the repository, not the package' },
  { pattern: /^test\//, why: 'tests and fixtures are not for consumers' },
  { pattern: /^\.github\//, why: 'repository plumbing is not part of the package' },
  { pattern: /^assets\//, why: 'the README on npm links the picture, it does not ship it' },
  { pattern: /\.tsbuildinfo$/, why: 'a build cache is not an artefact' },
  { pattern: /^REPO-NOTES\.md$/, why: 'working notes are for the repository' },
  { pattern: /^(CONTRIBUTING|CHANGELOG|SECURITY|CODE_OF_CONDUCT)\.md$/, why: 'these belong to the repository' },
];

const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
});
if (result.status !== 0) {
  console.error(result.stderr);
  process.exit(1);
}

// Windows reports the paths with backslashes; the allow list is written the
// one way, so they are converted rather than matched twice.
const toPosix = (path) => path.split(String.fromCharCode(92)).join(String.fromCharCode(47));

const [pack] = JSON.parse(result.stdout);
const files = pack.files.map((f) => toPosix(f.path));

let failures = 0;
const fail = (message) => {
  failures += 1;
  console.log(`  FAIL  ${message}`);
};

for (const file of files) {
  const forbidden = FORBIDDEN.find((rule) => rule.pattern.test(file));
  if (forbidden) fail(`${file} must not ship: ${forbidden.why}`);
  else if (!ALLOWED.some((rule) => rule.test(file))) fail(`${file} is not on the allowed list`);
}

// The files that make the package usable and lawful.
for (const required of [
  'package.json',
  'README.md',
  'LICENSE',
  'dist/bin.js',
  'dist/index.js',
  'dist/index.d.ts',
]) {
  if (!files.includes(required)) fail(`${required} is missing from the package`);
}

// Every profile the README documents has to be in the tarball, or --profile
// fails for whoever installed it while working for whoever cloned it.
const profiles = files.filter((f) => f.startsWith('profiles/'));
if (profiles.length < 9) {
  fail(`only ${profiles.length} profiles ship, and the README documents 9`);
}

const kb = (n) => `${(n / 1000).toFixed(1)} kB`;
console.log(`  ${files.length} files, ${kb(pack.size)} packed, ${kb(pack.unpackedSize)} unpacked`);
console.log(`  ${profiles.length} profiles`);

// Not a limit anyone imposed, a tripwire. Dependencies are not bundled and
// there are no assets; if this ever crosses, something is shipping by accident.
if (pack.unpackedSize > 400_000) {
  fail(`unpacked size ${kb(pack.unpackedSize)} is larger than this package has any reason to be`);
}

console.log(failures === 0 ? '  ok    nothing unexpected ships' : `\n${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
