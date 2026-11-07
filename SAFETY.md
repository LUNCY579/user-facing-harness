# Safety

English | [中文](SAFETY.zh.md)

## Experimental status

DeepSeek Harness is experimental developer-preview software. It has not undergone a security audit and must not be treated as secure or production-ready.

The project can execute model-generated code and commands, load third-party plugins, and access the network, processes, credentials, and files made available to it. Incorrect model output, defects, misconfiguration, malicious input, or untrusted plugins may damage the host computer, modify or delete files, disclose data or credentials, or cause other unintended effects.

## Sandbox limitations

Sandboxing, approval prompts, and permission controls can reduce risk, but they do not guarantee isolation or prevent damage. Even correctly enforced restrictions cannot protect resources that the project is allowed to access.

Do not rely on DeepSeek Harness as the sole security control for untrusted workloads.

## Responsible use

- Run the project with the least privileges and access required.
- Prefer a disposable virtual machine, container, or dedicated environment.
- Keep backups of files that the project can access.
- Do not expose sensitive credentials or data unless you accept the risk.
- Review plugins, configuration, and proposed commands before allowing them to run.

## Untrusted content

Content the model reads is not commands you approved. Fetched web pages, repository files, MCP tool results, and recorded sessions can carry instructions addressed to the model (prompt injection). A sandboxed, denied, or denied-then-escalated outcome is the containment for a malicious instruction, not a product defect to be worked around. Review proposed commands and writes the same way you review a patch from an untrusted contributor: by what they do, not by who asked.

## Plugins, MCP servers, and skills

Plugins, MCP servers, and skills are third-party code and instructions that run with your privileges. Installing one is an execution decision, not a configuration preference: review its source and declared tools before enabling it, prefer sources you can attribute, and treat a marketplace listing as unvetted regardless of its description. A plugin that asks for credential access or unrestricted execution should be treated like any other program that asks for those things.

## Network access of web tools

The local `web_fetch` provider fetches from this machine and by design reaches intranet and loopback addresses (it is how the agent inspects local dev servers). Anything the fetcher can reach, model-driven requests can read, so a deployment that must keep internal services invisible should compose the sandbox with `network: 'deny'` or run the agent in an isolated network namespace. The DeepSeek Fetch API provider runs remotely and cannot reach intranet or loopback addresses.

## No warranty or liability

Use DeepSeek Harness at your own risk. The software is provided without warranty under the [MIT License](LICENSE). To the maximum extent permitted by applicable law, the authors and copyright holders are not responsible for damage to computers, loss or disclosure of data, loss of files, or other harm arising from use of the project.
