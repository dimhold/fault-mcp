## What this changes

<!-- One or two sentences. What behaviour is different afterwards. -->

## How it was checked

```
npm run typecheck && npm test && npm run build
node .github/scripts/check-package.mjs
node .github/scripts/smoke.mjs
```

<!-- Paste what those printed, or say which one you could not run and why. -->

## If this adds or changes a fault

- [ ] `FAULT_KINDS` in `src/config.ts` and its zod schema
- [ ] the switch in `src/faults.ts`
- [ ] a test asserting the exact bytes for a fixed seed
- [ ] a row in the README table, so `check-docs.mjs` passes

## Reproducibility

- [ ] No `Date.now()` and no `Math.random()` inside a fault. Randomness comes
      from `src/rng.ts`, derived from the seed, the tool name and the call index.
