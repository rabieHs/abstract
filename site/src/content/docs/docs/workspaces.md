---
title: Workspaces and your library
description: Workspaces, the Files panel, adding papers, and how documents become searchable.
---

A **workspace** is an ordinary folder. Everything for one project lives in it: your papers, the
drafts, the agent's notes, and the conversations. Open one with `abstract <folder>`, or from the
**Workspaces** screen.

## Creating and switching

On the **Workspaces** screen you can:

- **Create a new workspace** — it's made in `~/Abstract/<name>`.
- **Open** a recent workspace (the last 8 are listed), or type any existing folder path
  (`~` works) to open it.
- **Delete** a workspace you're not currently in. This permanently removes the folder and
  everything inside it — your files included. As a safeguard, abstract only deletes folders that
  contain an `.openpaper/` folder (created the first time a folder is opened as a workspace), and
  never your home folder or the workspace that's open.

Running `abstract` with no folder reopens the last workspace you used.

## What's in a workspace

| Folder | What goes there |
|---|---|
| `sources/` | papers you add or the agent downloads |
| `drafts/` | documents the agent writes, plus exports |
| `figures/` | page images the agent rendered to look at |
| `analysis/` | scripts and outputs from data analysis |
| `.openpaper/` | the library database, conversations, memory, and reading notes (hidden) |

You can add your own folders and files anywhere.

## The Files panel

The panel on the right shows the workspace. Folders come first; `drafts/` and `sources/` open by
default, and it refreshes every few seconds.

- **Click** a file to preview it — PDFs and HTML, images, rendered Markdown, or plain text.
- **Hover** a file to download it, delete it, or (for Markdown) open a printable view with **PDF**
  so you can save it as a PDF.
- **Drag** files between folders to move them. A moved paper keeps its library entry and notes.
- **folder+** creates a folder; **+ Add** saves files into `sources/`.
- The virtual **notes** folder shows the agent's private reading notes, one per source.
  They help it remember what it read, but they're never cited as evidence.

When you've been searching the literature, a **screening** bar at the top shows how many papers
were identified, screened, and included.

## Adding papers

Click **+** in the chat box:

- **Save files to workspace** — PDFs, Markdown, text, LaTeX, BibTeX, or images go into `sources/`.
  A file with the same name is replaced.
- **Attach to this message (not saved)** — up to 6 files (PDF, Markdown, text, images) sent with
  one message only, for quick questions.
- **Import from URL** — paste a paper URL, DOI, or arXiv id and the agent fetches it.

Or simply copy files into the workspace folder.

## How papers become searchable

Saving a file does **not** index it. The agent ingests a paper when it needs it — or ask it to
("ingest everything in sources/"). Ingesting:

1. extracts the text, page by page, and splits it into passages;
2. looks the paper up in Crossref and OpenAlex — by DOI if it finds one, otherwise by title —
   so citations use the official record;
3. assigns a **grade**: <code>peer-reviewed</code>, <code>preprint</code> (for example arXiv), or
   <code>note</code> (no registry match — your own notes, for instance);
4. catalogs figures, tables, charts, and equations so they're searchable too.

Ingested files show **INGESTED** and their grade in the Files panel.

**Scanned PDFs** (image-only pages) are detected automatically and transcribed by your model, ten
pages at a time. A scanned PDF must be under 18 MB — split larger ones first.

:::caution[Reading before citing]
The agent can only cite sources it has actually **opened** — read page by page, viewed, or
summarized in a note. A downloaded but unread paper can't be cited. If you ask for a draft before
anything was read, it will tell you which papers it still needs to read.
:::

## Conversations

Each workspace keeps its own conversations, listed in the sidebar (up to 50). **+ New chat**
starts a fresh one; the last open one comes back when you reload. The agent can search your other
conversations in the same workspace when you refer to earlier work.
