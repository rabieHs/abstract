# Changelog

All notable changes to abstract are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [0.2.1] - 2026-10-10

### Changed

- `abstract` with no folder now opens `~/Abstract/default` the first time, instead of the folder
  the terminal happens to be in. It still reopens your last workspace when there is one.
- abstract never uses your home folder or the disk root as a workspace, from the command line or
  the Workspaces screen, because scanning them walks your whole computer.

### Fixed

- The file panel and the agent's file list no longer fail on broken links (seen with a stray
  application link); they skip anything they can't read, and don't follow links into other
  folders.

## [0.2.0] - 2026-10-10

### Added

- **Standalone builds** for macOS (Apple Silicon and Intel) and Linux (x64 and arm64): one file
  with everything inside. No Bun or Node needed.
- **One-line installer:** `curl -fsSL https://useabstract.co/install.sh | sh` downloads the build
  for your system, verifies its SHA-256 checksum, and installs it to `~/.local/bin`.
- Releases are built by GitHub Actions from the tagged source, with checksums and
  build-provenance attestations you can verify.
- `abstract --version`.
- Automated tests on every change, issue templates, and a security policy with private reporting.

### Changed

- The app's health check reports its real version.

## [0.1.1] - 2026-10-10

### Added

- Website and documentation at [useabstract.co](https://useabstract.co).

### Fixed

- Ollama: the address entered in Settings now works with or without `/v1`, and `OLLAMA_HOST`
  takes precedence over it, like API keys do.
- `abstract --help` now says what really happens without a folder: it reopens the last workspace
  you used, else the current directory.

### Changed

- README: npm, license, and Bun badges, a link to the docs, and a more precise account of what
  leaves your machine.
- The Workspaces screen now says your files are *stored* on this machine.

## [0.1.0] - 2026-10-09

The first open-source release.

### Added

- **Continue with ChatGPT:** run abstract on a ChatGPT Plus or Pro plan through OpenAI's Sign in
  with ChatGPT, with no API key. Includes the usage link, a first-use notice, a "Using ChatGPT plan"
  label in the chat, and a clear message when the plan's usage limit is reached.
- One model, picked in the chat box, runs every task. Models come from Anthropic, OpenAI, Google,
  OpenRouter, Ollama, or a ChatGPT plan, and each provider lists only its recent models.
- A research agent that ingests PDFs, Markdown, and text; searches OpenAlex, Crossref, and arXiv;
  follows citation chains; and keeps a PRISMA-style screening log.
- Verified drafting: per-sentence entailment checks with verbatim evidence, verified comparison
  tables, and gated export to Markdown, LaTeX, and BibTeX with a claim-to-passage audit file.
- Memory notes you approve, and skills written as `SKILL.md` files.

### Changed

- Global settings moved from `~/.openpaper` to `~/.abstract`. The folder is moved automatically the
  first time the new version starts; workspace `.openpaper` folders are unchanged.
