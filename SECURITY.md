# Security Policy

English | [中文](SECURITY.zh.md)

## Supported status

DeepSeek Harness is experimental developer-preview software. See [SAFETY.md](SAFETY.md) for the standing risk disclosure. Issues are triaged by their effect on the latest default configuration; there is no long-term-support branch.

## Reporting a vulnerability

Do not open a public GitHub issue for a vulnerability. Report privately:

- Email the maintainers at **security@deepseek.ai** with `DeepSeek Harness` in the subject, or
- If you have a private channel to a maintainer, use it and ask them to forward the report.

Include: affected package or app, a minimal reproduction, the configuration in effect (`cordis.yml` sandbox/credential sections may be redacted), and your assessment of impact. You will receive an acknowledgement; we aim to respond within 7 days.

Please do not test against third-party systems, do not exfiltrate real data, and stop at proof of impact.

## What is in scope

- Sandbox escape or confinement that silently degrades (an enforcement claim that does not hold).
- Credential disclosure through logs, session exports, snapshots, telemetry, or spill files.
- Authorization bypass in the API gateway or remote access (`packages/api`).
- Plugin, MCP, or skill loading that executes code without the documented trust prompt.
- Webhook signature verification bypass; WebSocket or HTTP admission bypass on the local web server.
- Injection from fetched web content or MCP tool results into command execution.

## What is out of scope

- The inherent risks documented in [SAFETY.md](SAFETY.md): a deployment that grants the agent access to a resource grants the model's execution that resource. Reports whose impact requires a misconfiguration the product warns about at load are handled as bugs, not vulnerabilities.
- Volumes and rate limits on the local loopback server without an escalation path.
- Vulnerabilities in dependencies that require no harness-specific trigger — report upstream and tell us the tracking issue.

## Hardening expectations

The repository enforces security-relevant invariants as executed gates (`verify-secrets-scan`, sandbox fail-closed tests, credentials mode checks). A fix for a vulnerability should extend or add such a gate when the invariant is mechanically checkable.
