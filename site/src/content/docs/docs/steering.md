---
title: Steering the agent
description: Plans, talking to the agent while it works, stopping, long runs, and parallel readers.
---

abstract's agent works in steps (searching, reading, writing, checking) and can run for a long
time on big tasks. You stay in control the whole way.

## The plan

For multi-step work the agent keeps a **plan**: a short task list shown in the chat, with each task
marked pending, in progress, or done. It updates the plan as it goes and shows *plan complete* when
it's finished. Tasks can depend on others ("blocked by …").

If the agent stops while plan items are still open, or after saying it will do more ("I'll now…"),
abstract nudges it to continue, up to four times. If it still hasn't finished, you'll see a notice
listing the open items; send a message to carry on. A question to you ends the turn normally.

## Talking while it works

You don't have to wait. While the agent is busy, the chat box says *message the agent while it
works…*. Type and send as usual. Your message shows as *sent · the agent reads it at its next
step*, and it's delivered at the next step. Use this to redirect ("skip the medical papers"), add
context, or answer a question early.

If the run has already ended, your message is sent as a normal one.

## Stopping

Press the **stop** button (the black square) to stop the agent, including any sub-agents. Everything
up to that point is saved: sources, notes, drafts, the screening record, the plan. Send a message
to continue.

## Reloading and crashes

- **Reloading the page** reattaches to a run in progress, so you won't lose it.
- **If abstract quits mid-run,** start it again and resend your message; the run resumes from the
  steps that already finished.

## Long runs and budgets

Very long tasks are kept in check by limits you can tune in
[configuration](/docs/configuration/#budgets):

- a **soft budget** (1.5M input tokens by default): past it, the agent is asked to pace itself;
- a **hard budget** (3M): past it, if the plan is still open, earlier steps are summarized and
  the work continues in a fresh segment, up to 2 extra segments;
- a **3-hour** limit per message.

When a limit ends a turn, the message says so and everything is saved; send another message to
continue. Long conversations are summarized automatically so they keep fitting in the model's
context. The full history stays in the workspace.

## Parallel readers

For a large reading list, the agent can split the work across **up to four sub-agents** (two run at
a time). Each reads and reports back under the same rules: it can only cite what it opened. You
can ask for this directly: "split the reading across sub-agents."

## Rules

You can forbid specific actions with your own rules, for example never fetching from a
particular site. See [Rules](/docs/configuration/#rules).
