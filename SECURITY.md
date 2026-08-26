# Security policy

## Supported versions

The latest published version is the supported one. faultmcp is small, and
fixes go out as a new release rather than as a backport.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | yes       |

## What this package is, before you report

faultmcp exists to make a tool misbehave on purpose. Wrong values, truncated
results and errors are the product, not a vulnerability. What *is* worth
reporting is anything that lets it reach beyond the process it was told to
break: reading or writing files it was not pointed at, network access it was
not configured for, or a profile that can execute code.

The bundled example tools deliberately touch neither disk nor network.
`read_file` reads a small in-memory corpus. If you find a path where they do,
that is a report.

## Reporting a vulnerability

Report privately, not as a public issue.

- **Preferred:** [open a private advisory](https://github.com/dimhold/faultmcp/security/advisories/new)
  through GitHub's private vulnerability reporting.
- **Or:** email <dimhold@gmail.com> with `faultmcp` in the subject.

Please include what you ran, what happened and what you expected. A profile
and a seed reproduce a run exactly, so those two lines are usually the whole
report.
