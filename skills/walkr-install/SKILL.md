---
name: walkr-install
description: Guide an agent through installing Walkr from a clone for a user - the five walkr commands, the agent skills, and the optional Pi extensions. Use when a user asks to install, set up, update or uninstall Walkr. Ask questions and follow INSTALL.md.
---

# Install Walkr for a user

Read [INSTALL.md](../../INSTALL.md) first. It holds the order, the commands and the checks. This is a question list, not a second install flow.

Use your question tool, or plain text. Offer two to four concrete options, with the recommended option first. Ask before each change to the machine: an install, a new directory, a link. Never run `install.sh` with `sudo`.

## Questions

- "Which Node.js do you want Walkr to use?" Ask when several installs exist or `node --version` is below 20.19.0. Options: the newest installed Node (recommended), install a newer Node first. Follow [the prerequisites](../../INSTALL.md#prerequisites).
- "Where is the clone, or where do I clone it?" Ask only when unclear. Options: `~/walkr` (recommended), a directory that the user names. Follow [the clone](../../INSTALL.md#clone).
- "Where do the command links go?" Options: `~/.local/bin` (recommended), another directory on `PATH` (`--bin-dir`). Say when the directory is not on `PATH`. Follow [the options](../../INSTALL.md#options).
- "Where do the agent skills go?" Options: this project (`--project <dir>`, recommended when the user works in one project), all projects of the user (`--global`), no skills (`--skip-setup`). Follow [where the skills go](../../INSTALL.md#where-the-skills-go).
- "Do you use Pi, and do you want the Pi extension lines?" Ask only when `pi` is on `PATH`. Options: no (recommended), yes (`--pi-extension`). The extensions load per session; nothing is copied. Follow [Pi integrations](../../INSTALL.md#pi-integrations).
- "Run a dry run first?" Options: yes (recommended), no. A yes is `--dry-run` with the same options. Show its output before the real run.

Then run `install.sh` with the answers and `--yes`. When a link name is in use, or setup reports a conflict, stop and ask. Do not move or delete a file of the user without a separate yes. Follow [troubleshooting](../../INSTALL.md#troubleshooting).

For an uninstall, ask "Remove the command links only, or the skills too?" Options: links only (recommended), links and skills. Follow [uninstall](../../INSTALL.md#uninstall).

## Checks

1. `walkr --help` prints the help. This proves that the link and `PATH` work.
2. The five `walkr*` skills exist in the chosen skills directories. With `--skip-setup`, record this check as "not run".
3. Optional, with a yes from the user: `walkr <file.html>` opens the page in the browser. Follow [the first review](../../INSTALL.md#first-review).

Record each check that did not run as "not run".

## Report

End with this shape:

```text
Clone: <path>
Node: <version>
Command links: <bin directory>, on PATH: yes|no
Skills: project <dir> | global | skipped
Pi extensions: lines printed | not asked
Checks: walkr --help <pass|fail|not run>; skills <pass|fail|not run>; first review <pass|fail|not run>
Open items: <PATH line to add, conflicts, or none>
```
