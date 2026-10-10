---
title: Command line
description: The abstract command, its options, and what it prints.
---

```text
abstract [dir]          open a workspace (default: the last one you opened,
                        else the current directory)
abstract --port <n>     serve on a specific port
abstract --no-open      don't open the browser
abstract --version      print the version
```

| Option | What it does |
|---|---|
| `dir` | The folder to open as a workspace. `~` works. Without it, abstract reopens the last workspace that still exists, or uses the current directory. |
| `--port <n>`, `-p <n>` | The port to use. The default is `4477` (change it permanently with `port` in [config.json](/docs/configuration/)). |
| `--no-open` | Start without opening a browser tab. |
| `--version`, `-v` | Print the installed version, e.g. `abstract 0.2.0`. |
| `--help`, `-h` | Print the usage text. |

## What happens when it starts

```text
  Abstract · workspace "my-review"
  http://localhost:4477
```

abstract serves the app on your own computer only (`127.0.0.1`) and opens your browser at that
address. If the port is busy it tries the next one — `port 4477 is in use — trying 4478` — up to
20 ports, and stops with `no free port found` if none is free.

Stop it with <kbd>Ctrl</kbd>+<kbd>C</kbd>. Work in progress is saved before it exits.

## Examples

```bash
abstract                      # reopen the last workspace
abstract ~/thesis             # open a specific folder
abstract ~/thesis --port 5000 --no-open
```

You can run two workspaces at once in separate terminals — the second one takes the next free
port.
