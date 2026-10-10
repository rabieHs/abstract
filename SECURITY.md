# Security

## Reporting a vulnerability

Please report security problems **privately** through
[GitHub's vulnerability reporting](https://github.com/rabieHs/abstract/security/advisories/new),
not as a public issue. Include what you found, how to reproduce it, and its impact. You'll get a
reply as soon as possible, and credit in the release notes if you'd like.

## What's in scope

abstract runs on the user's own computer, so the most important areas are:

- the local server, which must only be reachable from the same machine (`127.0.0.1`) and must
  reject requests from other websites;
- handling of API keys and the ChatGPT sign-in stored in `~/.abstract/`;
- files the agent reads, writes, or runs (`run_code`) inside a workspace;
- the installer and release files (checksums and build attestations).

## Supported versions

Fixes go into the latest release. Update with the installer or `npm i -g abstract-cli@latest`.
