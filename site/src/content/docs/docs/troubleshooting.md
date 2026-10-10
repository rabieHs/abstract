---
title: Troubleshooting
description: Common messages and how to fix them.
---

## Installing and starting

**`command not found: abstract` right after installing**
Open a **new** terminal window. The installer added `~/.local/bin` to your `PATH`, and only new
windows pick that up. Or run `export PATH="$HOME/.local/bin:$PATH"` in the current one.

**`checksum mismatch: … nothing was installed`**
The download was corrupted or interrupted. Run the installer again.

**macOS says *"abstract" cannot be opened because the developer cannot be verified***
This happens if you downloaded the file through a web browser instead of the installer. Use the
installer, or clear the download flag: `xattr -d com.apple.quarantine ./abstract`.

**`musl-based Linux … isn't supported`**
The standalone build needs a glibc Linux (Ubuntu, Debian, Fedora, Arch…). On Alpine, install
[with Bun](/docs/install/#for-developers-npm-or-bun) instead.

**`env: bun: No such file or directory`**
You installed the npm package, which runs on Bun. Use the [installer](/docs/install/) instead
(it needs nothing else), or [install Bun](https://bun.sh).

**`port 4477 is in use`**
That's fine: abstract picked the next free port; use the address it prints. To choose one
yourself: `abstract --port 5000`.

**The browser didn't open**
Open the printed address (`http://localhost:4477`) yourself. If you started with `--no-open`,
that's expected.

## Models

**`no model available for role "orchestrator"`**
No model is connected. Open **Settings** and use **Continue with ChatGPT** or add an API key.
See [Connect a model](/docs/models/).

**`the provider rejected the API key`**
The key is wrong or revoked. Click **manage** next to the provider in Settings and paste a new
one. If the key is set as an environment variable, that one wins, so update it there.

**`provider quota or credits exhausted`**
Your provider account is out of credit. Top it up, or switch models in the chat box.

**`the provider rate limit stayed saturated…`**
Too many requests too fast. Wait a minute and resend; everything so far is saved.

**Ollama models don't appear**
Make sure Ollama is running (`ollama serve`) and has a model pulled, and that the address in
Settings (or `OLLAMA_HOST`) is right (usually `http://localhost:11434`).

## ChatGPT plan

**Usage limit reached**
Your plan's allowance for abstract is used up. Click **Manage usage** to see or raise the cap, wait
for it to reset, or **Switch model**. Everything so far is saved.

**`This ChatGPT account can't use its plan in abstract`**
Plan usage needs ChatGPT **Plus or Pro**.

**`Your ChatGPT sign-in needs renewing`**
Open Settings and click **Continue with ChatGPT** again.

**`This sign-in link expired or was already used`**
Sign-ins expire after 10 minutes and don't survive a restart of abstract. Start again from
Settings.

**Settings says *plan usage off***
You signed in but didn't allow plan usage. Click **Continue with ChatGPT** again and allow it.

## Library and drafting

**Search only finds exact words**
No embedding model is connected, so search is keyword-only. Connecting OpenAI, Google, or Ollama
adds semantic search. See [Embeddings](/docs/models/#embeddings).

**`scanned PDF larger than 18MB`**
Split the PDF into smaller parts and add them separately.

**`no passages available from OPENED sources`**
The agent can only cite papers it has read. Ask it to read the papers it lists first, then draft
again.

**A sentence shows *This passage is no longer in the library***
The source file changed or was removed after the draft was written. Ask the agent to revise the
draft so those sentences are checked again.

**Export stops with *N sentence(s) are UNSUPPORTED***
Ask the agent to fix the unsupported sentences, then export again. To export anyway, tell the agent
you accept them. See [Export](/docs/export/#the-export-gate).

## The app

**`stopped at your request`**
You pressed stop. Everything is saved; send a message to continue.

**`a run is already in flight for this session`**
The agent is still working in this conversation. Reload the page to reattach to it, or stop it
first.

**`The interface hit a rendering error`**
Click **Reload**. Your work is saved on disk.

**`unknown API route …` or *the server answered … without JSON***
The page and the app are from different versions, usually right after updating. Restart abstract
(<kbd>Ctrl</kbd>+<kbd>C</kbd>, then `abstract`) and reload the page.

## Still stuck?

Open an issue on [GitHub](https://github.com/rabieHs/abstract/issues) with what you did, what you
expected, and the exact message. Mention the model you were using.
