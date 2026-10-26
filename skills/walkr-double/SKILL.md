---
name: walkr-double
description: Use the existing local Double comparison, saved rounds, or shared GUI recovery. Hosted Double remains disabled; connecting requires the same explicitly selected persistent Pi conversation.
---

# Walkr Double

Double supports checked local copies and saved rounds. Hosted Double is disabled.
The managed installed `walkr-double` provides guidance and refuses operations. Stop on that refusal; never retry through a local entry automatically.
Checkout-local execution requires explicit approval for that local workflow, not merely a request to use the managed command.
If the approved checkout is missing, report the prerequisite instead of fetching a package.
Plain invocation grants no connection, extension loading, generation, or new-chat authority.

## Local connection

1. Read the checkout's [shared GUI guide]({{REPOSITORY}}/docs/double.md#start-from-the-shared-gui) for the requested flow.
   Read its input-rules link before preparing an approved disposable trial.
2. Confirm separate approval for extension loading and the trial. Live archive access, browser use, and source application remain separately gated.
3. Use the explicitly selected existing persistent Pi conversation with its approved state and archive directories.
   Ephemeral sessions cannot receive this flow. Do not choose a chat from a brief or launch another conversation.
4. After the approved shared GUI extension is already loaded, connect explicitly in that same conversation:
   `/shared-gui {"action":"connect","timeoutSeconds":240}`.
   Verify `active: true`, the Pi session ID, session file, and private path before opening an approved browser.
5. Let the user explicitly send the brief. Connecting alone does not generate copies or replay historical work.

Keep the private URL private. Do not also load the standalone Double extension; the shared extension supplies its adapter.
The seven existing themes and future server-only hosting plans do not enable hosted Double.

## Inspect and recover

Only for explicitly approved checkout-local work, use the exact entry below. It supplies the existing `double` command prefix.
Set the approved absolute `HUMAN_REVIEW_STATE_DIR` and `HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR`; retain the hosted guard.
These are POSIX shell commands, independent of any installed managed alias:

```sh
{{LOCAL_DOUBLE_COMMAND}} gui view
{{LOCAL_DOUBLE_COMMAND}} session view '<session-id>'
{{LOCAL_DOUBLE_COMMAND}} session events '<session-id>'
{{LOCAL_DOUBLE_COMMAND}} session output '<ended-session-id>'
```

Use saved IDs, not text from the brief, as command arguments. These inspection commands do not authorize starting a server or a trial.
Restore the same Pi session ID, session file, and explicit archive configuration before any approved reconnection.
Read the guide's recovery steps for uncertain actions, interrupted attempts, and exact receipt acknowledgment.
A queued result is not a persisted receipt. End does not authorize deployment or original-source writes.
