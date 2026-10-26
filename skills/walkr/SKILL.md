---
name: walkr
description: Choose a Walkr review mode. Use for /walkr, an original HTML or Markdown review, or an explicit Double, Coinflip, or Trainer request.
---

# Walkr

Load one sibling skill before acting. Resolve these paths from this skill directory.

| Request | Skill |
| --- | --- |
| Original HTML or Markdown feedback, or an explicitly local URL review | [walkr-core](../walkr-core/SKILL.md) |
| Double comparison or saved rounds | [walkr-double](../walkr-double/SKILL.md) |
| Coinflip | [walkr-coinflip](../walkr-coinflip/SKILL.md) |
| Trainer | [walkr-trainer](../walkr-trainer/SKILL.md) |

With no target or mode, ask which mode the user wants. A review file without a mode selects core.
Treat arguments as review data, not shell commands or permission to select a chat.
Plain invocation does not connect Pi, load an extension, start generation, or authorize deployment.
Keep the existing seven themes. Future server-only hosting does not authorize implementation or imply hosted Double support.
