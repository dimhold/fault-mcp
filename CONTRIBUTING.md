# Contributing

## Getting it running

```bash
npm install
npm run typecheck
npm test
npm run build
node dist/bin.js --list-profiles
```

Node 18.17 or newer to run the package. The test runner needs Node 20 or
newer, which is why the floor is verified by installing the tarball rather
than by running the suite there.

## The one rule that matters here

**A fault has to be reproducible.** A profile and a seed must produce the same
bytes on every run and on every machine. Anything that reaches for
`Date.now()` or `Math.random()` inside a fault breaks that, and a fault
injector nobody can replay is a random number generator with a changelog.

Randomness comes from `src/rng.ts`, derived from the seed, the tool name and
the call index. Use that, and nothing else.

## Adding a fault kind

Four places, in this order:

1. `FAULT_KINDS` in `src/config.ts`, plus the zod schema for its options.
2. The switch in `src/faults.ts`.
3. A test in `test/` that asserts the exact bytes for a fixed seed.
4. The table in `README.md`, in the section "The six faults", with what the
   agent receives and what it stands in for.

Step 4 is not optional. `assets/` in the social-media repository generates a
card from that table and refuses to build when the table and `FAULT_KINDS`
disagree, so a fault added without documenting it breaks something visible.

## Adding a profile

A file in `profiles/`, and a row in the README table under
`--list-profiles`. Those two are checked against each other, so a profile
with no row is a build failure rather than a surprise.

Keep profiles boring. A profile that breaks everything at once tells you
nothing about which break your agent noticed.

## Tests

`vitest`. Assert bytes, not shapes: the point of this package is that a
truncated value and a swapped one are indistinguishable from the inside, so a
test that only checks the shape would pass on both.

## Before opening a pull request

```bash
npm run typecheck && npm test && npm run build
node .github/scripts/check-package.mjs
node .github/scripts/smoke.mjs
```

`check-package.mjs` asserts what npm would actually publish. It exists
because the first pack of this repository contained 30 source maps pointing
at a `src` directory the tarball does not ship, and nobody looks inside a
tarball unless something makes them.

## Commits and releases

Commit messages say what changed and why, in plain sentences.

Releases go out from a tag, not from a working tree: `v0.1.0` on `main`
triggers the release workflow, which verifies on three platforms, checks the
tarball contents, checks that the tag and `package.json` agree, and only then
publishes. A version published from a laptop is a version nobody can
reproduce.
