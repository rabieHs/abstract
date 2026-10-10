---
title: Skills
description: Built-in and custom skills, reusable instructions the agent loads when a task calls for them.
---

A **skill** is a set of instructions for a kind of task: a venue's review rubric, how to write a
methods section, a systematic-review checklist. The agent sees each skill's name and description,
and loads the full instructions when your request matches. You can also ask for one by name: "use
the review-cbmi skill".

Skills shape **style and method**. They can't weaken verification, because that's enforced in code.

## Built-in skills

abstract ships with **38 skills**:

- **8 review rubrics:** `review-neurips-icml-iclr`, `review-acl-emnlp`, `review-cvpr-iccv`,
  `review-cbmi`, `review-ictai`, `review-ieee-journals`, `review-nature-science`, `review-generic`.
- **30 research and writing skills**, including `literature-review-chapter`,
  `systematic-review-prisma`, `related-work-section`, `abstract-writing`, `methods-section`,
  `discussion-limitations`, `rebuttal-response-letter`, `thesis-introduction`, `statistics-review`,
  `reproducibility-review-ml`, `search-strategy-systematic`, `data-extraction-matrix`,
  `medical-reporting-standards`, `figure-table-audit`, `camera-ready-checklist`, and more.

Built-in skills are installed once. If you edit or delete one, it stays the way you left it.

## The Skills screen

Open **Skills** in the sidebar to:

- turn a skill **on** or **off**,
- **edit** its description and instructions,
- **delete** it,
- **approve** skills the agent proposed (shown as pending),
- create one with **+ New skill**: a kebab-case name, a description, and the instructions in
  Markdown.

You can also ask in chat ("make a skill for my lab's writing style"), and the agent will
interview you, then write it. Skills it creates on its own initiative wait for your approval.

## Writing a skill by hand

Skills are Markdown files in `~/.abstract/skills/`, shared by every workspace. Two layouts work:

- a single file: `my-skill.md`
- a folder: `my-skill/SKILL.md`, plus any reference files next to it (checklists, examples,
  templates; up to 30 files of 60 KB each), which the agent opens only when needed.

A skill starts with a small header:

```markdown
---
name: lab-style
description: Our lab's house style for papers. Use when drafting or revising any manuscript.
---

# Lab style

- Use British spelling.
- Report effect sizes with 95% confidence intervals.
- …
```

- `name`: letters, digits, and dashes (defaults to the file name).
- `description`: when to use it. This is what the agent reads to decide, so make it specific.
- `status` (optional): `active` (default), `pending`, or `disabled`.

To keep skills somewhere else, set `ABSTRACT_SKILLS_DIR`.
