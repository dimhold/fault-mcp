# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-26

First release on npm, as **`fault-mcp`**. The code had been on GitHub since
2026-08-17 and was usable only by cloning it, while the README told people to
run `npx faultmcp`, which nobody could do.

The package is `fault-mcp` and the repository is `faultmcp`, because npm
refuses the unhyphenated name: *"Package name too similar to existing package
fastmcp"*. The hyphen is what the registry accepts. Both `fault-mcp` and
`faultmcp` are installed as commands, so either spelling works once it is on
your machine.

### Added

- Six fault kinds, configurable per tool and per call: `error`, `empty`,
  `latency`, `truncate`, `schema`, `corrupt`. The first two announce
  themselves. The last three hand the agent something that looks like an
  answer, which is the whole reason to reach for this.
- Nine bundled profiles: `off`, `loud-failure`, `quiet-corruption`,
  `truncating-stream`, `schema-drift`, `slow`, `flaky`, `chaos`, and a
  `per-tool` YAML example.
- A seed. The same seed replays a run exactly, so a failure found once can be
  handed to somebody else.
- A JSONL journal written before the result leaves the process, so grading an
  agent compares what it said against what the tool actually returned rather
  than against a reading of the reply.
- Proxy mode, which puts the injector in front of an MCP server you already
  run.
- Example tools that never touch disk or network. `read_file` reads a small
  in-memory corpus: a fault injector with real filesystem access would be a
  liability, and a fixed corpus makes the clean answer and the corrupted one
  directly comparable.

### Fixed

- The published build no longer carries source maps. The first pack of this
  repository contained 30 of them, every one pointing at a `src` directory
  the tarball does not ship. Caught by `check-package.mjs` before the package
  ever reached the registry.

[Unreleased]: https://github.com/dimhold/faultmcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/dimhold/faultmcp/releases/tag/v0.1.0
