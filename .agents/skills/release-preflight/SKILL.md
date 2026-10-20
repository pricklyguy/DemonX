
---
name: release-preflight
description: Audit the sanitized public DemonX repository for initial commits, updates, and release readiness. Verify privacy, safety, builds, CI, packaging, and release versions. Never publish automatically.
---

# DemonX Release Preflight

Read the repository's AGENTS.md before starting.

## Purpose

Act as the release quality-control inspector for
pricklyguy/DemonX.

This is the PUBLIC repository. Development happens
in the separate private DemonX-Builds repository.

Never assume that tests passing in the private
repository proves the sanitized export is correct.

## Operating rules

- Default to read-only inspection.
- Do not modify files without explicit authorization.
- Never commit or push.
- Never create or push tags.
- Never publish releases or upload release assets.
- Never merge pull requests.
- Never alter Git remotes.
- Never weaken tests or security checks.
- Never operate CNC or laser equipment.
- Never treat simulator tests as hardware validation.

## Phase 1: Establish repository state

Inspect:

- Git working tree, branch, and remotes.
- Current HEAD SHA and origin/main SHA.
- Last public release and tags.
- Version declarations and lockfiles.
- Changes since the previous public baseline.
- AGENTS.md and CLAUDE.md.
- Available workflows and release scripts.

If no prior public release tag exists, identify
the relevant initial baseline commit instead.

Report missing information. Do not invent it.

## Phase 2: Public security audit

Inspect all new and modified files.

Check for:

- API keys, tokens, credentials, and private keys.
- Real private network details and hostnames.
- Personal filesystem paths and email addresses.
- Device identifiers and internal infrastructure.
- Private development notes and test captures.
- Runtime databases, configuration, and logs.
- Unexpected binary files and generated artifacts.
- Unsafe workflow or dependency changes.
- Unintended source or license disclosures.

Verify .export-manifest.json is excluded from Git.

Distinguish real sensitive values from synthetic
test data. Do not change tests merely because
they contain legitimate private-network examples.

A confirmed sensitive disclosure is a blocker.

## Phase 3: Source and version integrity

Verify both applications are present:

- DemonX CNC: server/, web/, shared/
- DemonX Design: design/

Check:

- Package manifests and lockfiles.
- Root, server, and web application versions.
- Design's separate package version convention.
- Release notes matching the proposed tag.
- Public repository references.
- Updater version comparison behavior.
- Windows asset naming and SHA-256 requirements.
- Compatibility with existing user data.
- Changes to motion, laser, and machine safety.

Flag anything that breaks expected updates.

## Phase 4: Local validation

After confirming that the working tree and local
runtime data will not be damaged, run:

npm ci
npm ci --prefix design
npm run typecheck:all
npm run test:all
npm run build
npm run build --prefix design

Use the repository's actual scripts and supported
Node.js version.

If an operation would overwrite important local
files, stop and report before proceeding.

Run applicable browser tests in isolated test
environments when their prerequisites are met.

Review applicable update, packaging, and security
tests. Record every skipped or unrun test.

Never report an unexecuted test as passing.

## Phase 5: Update safety

Inspect the current implementations of:

- scripts/update.sh
- design/scripts/update.sh
- server/src/updateApply.ts
- server/src/designLink.ts
- Relevant Design busy-state handlers
- Windows update implementation

Verify:

- No update interrupts an active machine operation.
- New operations cannot begin during unsafe
  installation and restart windows.
- Both CNC and Design are protected.
- Locks cover all relevant operation entry points.
- Busy-state query failures fail closed.
- Lock acquisition and release are safe.
- Restart failures preserve usable installations.
- No release is considered safe when an update
  mechanism has an unresolved safety defect.

Do not automatically repair safety-critical code.

## Phase 6: GitHub Actions

If the candidate commit exists on GitHub:

- Identify the exact candidate SHA.
- Fetch Actions runs for that SHA.
- Wait for required checks to complete when
  executing an owner-requested readiness review.
- Inspect failed jobs and report their errors.
- Distinguish passing, failing, pending, skipped,
  and unavailable checks.
- Do not accept success from a different commit.

If the candidate exists only locally, mark GitHub
Actions NOT VERIFIED.

Do not initiate releases or workflows that
publish artifacts.

## Phase 7: Release documentation

Review the proposed release notes for:

- Actual CNC and Design changes.
- Installation and upgrade instructions.
- Known limitations.
- Accurate simulator and hardware test claims.
- CNC and laser safety warnings.
- Correct version and download asset references.

For the first public release, explain that the
software is in active development with limited
real-hardware validation.

Do not invent feature claims or test results.

## Phase 8: Final report

Return this report:

# DemonX Release Preflight

Candidate version:
Current commit SHA:
Public repository:
Previous public release:

| Check | Result |
|---|---|
| Git state | |
| Privacy and secrets | |
| Sanitization | |
| Dependency integrity | |
| Typechecking | |
| Automated tests | |
| Builds | |
| Browser tests | |
| GitHub Actions | |
| Updater safety | |
| Release packaging | |
| Release notes | |
| Hardware validation | |

## Release blockers
List each blocker, file, cause, and correction.

## Warnings
List incomplete validation and nonblocking risks.

## Changes since previous public version
Summarize meaningful user-facing changes.

## Proposed commit message
Suggest a summary and description.

## Proposed release
Provide a version recommendation only if verified.

## Final decision

Choose one:

- READY FOR OWNER REVIEW
- HOLD — ACTION REQUIRED
- BLOCKED — DO NOT RELEASE

Never interpret READY FOR OWNER REVIEW as permission
to publish anything.

Stop after delivering the report.
