# Repo notes

Settings to apply when the repository is created on GitHub. Not part of the package.

## Name

`faultmcp`

## Description (one line, for the repo header)

> An MCP server that injects tool faults on purpose: errors, silent corruption, latency, truncation, schema violations and empty results, seeded and reproducible.

## Topics

```
mcp
model-context-protocol
fault-injection
chaos-engineering
llm
llm-agents
agents
ai-agents
testing
reliability
typescript
claude
anthropic
observability
```

## Settings

- Website: leave empty until there is a docs page.
- Issues: on. Discussions: off for now.
- Wiki, Projects: off.
- Releases: tag `v0.1.0` when publishing to npm.
- Social preview: `assets/hero.svg` rendered to PNG at 1280x640.

## Publishing checklist

1. `npm run typecheck && npm test && npm run build`
2. Verify `npm pack --dry-run` ships `dist/`, `profiles/`, `README.md`, `LICENSE` and nothing else.
3. Smoke test the packed tarball: `npx ./faultmcp-0.1.0.tgz --list-profiles`
4. Tag and publish.

## Things left undone

- HTTP transport is not wired up. Only stdio, which is what MCP clients use today.
- The generic corrupter is deliberately blunt. Tools that ship their own `corrupt()` produce a far more convincing wrong answer, and proxied tools currently cannot.
- No grading helper. The journal gives you ground truth; comparing it against a transcript is still your code.
