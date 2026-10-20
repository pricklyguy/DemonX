# DemonX — Claude Code Instructions

This is the public DemonX distribution repository.

## Required instructions

Read and follow the root `AGENTS.md` before performing any work. Its release safety rules, security requirements, testing instructions, and approval restrictions apply to Claude Code.

## Repository roles

- `pricklyguy/DemonX-Builds`: Private development repository.
- `pricklyguy/DemonX`: Public distribution repository.

This checkout is the public repository. Never synchronize changes back to the private repository without explicit authorization.

## Release safety

- Never independently push commits or tags.
- Never merge pull requests or publish releases.
- Never bypass tests or security checks.
- Never change version numbers without approval.
- Do not change application code during a release audit unless specifically requested.
- Always verify the exact candidate commit and associated CI results.
- Always provide a release readiness report before recommending publication.

The owner maintains final authority over all public releases.

## First public release

The last confirmed development release is `v2.2.1`.

The proposed first public release is `v2.2.2`, pending version, updater, security, and build verification.

A release tag must never be created automatically.

Follow `AGENTS.md` for all additional requirements.