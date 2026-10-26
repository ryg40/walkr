# Core

Core opens one HTML file, one Markdown file, or one `localhost` page in your browser.
You edit, delete and comment on the page. Then you select Send.
Your agent receives all of the feedback in one batch and applies it to the source.

Everything runs on your computer. Core needs no account, cloud service or database.

## Start a review

```sh
walkr-core /absolute/path/page.html
```

`walkr` is the same command as `walkr-core`.
The command starts a local server, opens the page in your browser and prints the review URL.
The URL has the form `http://127.0.0.1:<port>/s/<session-id>`.
Set `HUMAN_REVIEW_NO_BROWSER=1` to print the URL without opening a browser.

The target can be one of these:

- An HTML file.
- A Markdown file. Core renders it for the review.
- A page on `localhost`, `127.0.0.1` or `[::1]`, for example `http://localhost:3000/`.

The command also prints the next steps for the agent: a bounded `poll` and a `status` read.

## What you can do on the page

- Edit text directly, and use basic formatting such as bold and italic.
- Make lists. Type `- ` or `1. ` at the start of a line.
- Add a link. Select text and press Cmd/Ctrl+K.
- Resize an image by its corner. Move an image or a block by its drag handle.
- Paste an image from the clipboard.
- Select a phrase and write a comment on it.
- Click an element, for example an image or a section, and write a comment on it.
- Delete an element. Deletes and moves have Undo.
- Write an overall note.
- Select Send. All edits and comments go to the agent in one batch.
- Select End review to stop the review and release the waiting agent.

For HTML files, direct edits save to the file at once. Revert all puts the file back.
For Markdown files and `localhost` pages, select Send so that the agent applies the changes to the source.

The bar at the top links to the four modes: Core, Double, Coinflip and Trainer.
The panel has a theme picker with seven themes.

## Hover and selection marks

Core marks the block under the pointer and the selected block in two different ways.
The marks are outside the reviewed page, so saved HTML never contains them.

- Hover: a thin gray line goes around the block under the pointer. The delete chip and the move handle show next to it. Hover never saves anything.
- Selection: a green glowing reticle with four corner marks goes around the selected block. It stands 4 px outside the block, so it does not cover the content.

A block becomes selected when one of these occurs:

- You click the block. The comment card opens for that block.
- You select text. The block that holds all of the selected text is selected.
  If no one block holds all of it, the block of the first selected character is selected.
- You type in the block.
- You save a comment, or you click a comment card or a highlight. The block of that comment is selected.

The selection ends when you click outside every block with no draft in the comment card, cancel the card, remove the comment, or delete the block.
The reticle takes no pointer input. It follows scroll, resize and moves of the block.

## The feedback loop with an agent

The agent collects a Send only with `walkr-core poll`. The [walkr-core skill](../skills/walkr-core/SKILL.md) gives the agent these rules:

1. Give the review URL. Then start a bounded poll in the same turn. The poll waits for a Send.

   ```sh
   walkr-core poll /absolute/path/page.html --timeout 240
   ```

2. Run the same poll again after each timeout. Stop after 60 minutes of waits in one turn, or when the user asks you to stop.
3. Apply the batch to the source. Verify the change.
4. Acknowledge the batch with its id. The poll then waits for the next Send.

   ```sh
   walkr-core poll /absolute/path/page.html --ack <batch_id> --timeout 240
   ```

5. Before the final reply, run `walkr-core status /absolute/path/page.html`. If it reports `feedback-waiting`, poll and apply that batch first.

### When no agent waits

The server saves each Send as a batch for the review target. If no poll waits, the batch stays saved.
`walkr-core status` then reports `feedback-waiting` and `collected: false`.
The page shows "Sent — no agent is collecting it" and a handoff box.

The handoff box holds a message for the chat that started the review.
Select Copy prompt and paste the message into that chat.
The message names the skill, the exact poll command, the waiting `batch_id`, the acknowledgment command and the status command.

The box also shows after a poll took the batch ("Feedback delivered"), and while a batch waits for the next poll ("Sent — queued for the agent").
In those states no poll waits, and the server cannot tell if the agent still works. The message then starts "If the agent stopped before it finished".

### Batch ids

Each Send gets a stable `batch_id`, for example `batch-0123456789abcdef`.
The id is the same in the poll output, in `walkr-core status`, in the handoff box and after a server restart.

`walkr-core status <target>` reports these fields:

| Field | Meaning |
| --- | --- |
| `batch_id` | The current batch, or `null` when no batch waits |
| `collected` | `true` when a poll already took the current batch |
| `carried_batch_ids` | Earlier batches that were delivered and not acknowledged. The current batch carries them under `earlier_batches`. |
| `wake` | The wake-up binding: `bound`, `watching`, `lease_expired`, and `bound_to_caller` when the read names a chat |

A batch stays saved until its acknowledgment. A second poll before the acknowledgment returns the same batch.
If a newer Send came first, the poll returns the newer batch. Its `earlier_batches` hold each unacknowledged batch.
The acknowledgment of the newer `batch_id` clears all of them.

### Acknowledgment

`walkr-core poll <target> --ack <batch_id>` clears one batch. The server accepts these ids:

- The current batch, after a poll collected it. This clears the batch and every batch that it carries.
- One carried batch. This clears only that batch.

The server refuses any other id with `status: "ack-refused"`, a `reason` and exit code 1. A refused acknowledgment clears nothing.
A value after `--ack` that is not a valid batch id fails in the CLI with exit code 1, before any request.

The bare `--ack` without an id is the old form. It works only where it can name one collected batch:

| Pending state | Bare `--ack` |
| --- | --- |
| No batch, or a batch that no poll collected and that carries nothing | Clears nothing; the poll delivers the batch |
| A collected batch that carries nothing | Clears it |
| An uncollected batch that carries exactly one batch | Clears the carried batch |
| A collected batch that carries batches, or an uncollected batch that carries two or more | Refused |

Only one chat must poll a target. If two chats poll the same target, both can apply some items twice.
A chat that remembers the `batch_id` values that it applied can skip them.

## Automatic wake-up for Pi

A Pi chat cannot react to a Send after its turn ends. The optional extension `integrations/pi/core-wake.ts` fixes this.
It wakes the chat that started the review when a Send waits and no poll collects it.

Load it only when you start Pi, with an absolute path:

```sh
pi --extension /absolute/path/walkr/integrations/pi/core-wake.ts
```

Loading registers the `walkr_core_wake` tool and the `/walkr-core-wake` command. It does not bind a chat.

### Connect a chat

Run the connect command in the chat that started the review. The chat must be a persistent TUI or RPC chat with a session file.

```text
/walkr-core-wake {"action":"connect","target":"/absolute/path/page.html"}
```

The agent can do the same with the `walkr_core_wake` tool. It binds only the calling chat.
The extension then runs `walkr-core connect`. The server saves the binding in `state.json`, so the binding survives a server restart.

What the watcher does:

1. It reads `walkr-core status` every `intervalSeconds` (default 5, from 1 to 10). Each read renews a lease of 120 seconds.
2. A batch that no poll collected wakes the chat only while no poll is attached.
3. Before a wake, the extension claims the batch with `walkr-core claim-wake`. The server grants one claim for each batch id. So a batch wakes the chat only once, also after a restart of Pi or of the server.
4. The extension sends one follow-up message that starts a turn. The message names the target, the batch id and the exact poll, acknowledgment and status commands.
5. The agent collects the batch with poll and acknowledges it. The extension never polls, applies or acknowledges.

The watcher stops on `{"action":"disconnect"}`, on Pi shutdown or session navigation, at the end of `timeoutSeconds` (default 3600, at most 43200), after five failed status reads in a row, or when the binding moves to another chat.
On a stop, the extension releases its binding. A stopped watcher never reconnects itself.

`HUMAN_REVIEW_CORE_COMMAND` can name another command for the watcher, as a JSON array of arguments.

### Binding rules

- A connect from another chat is refused while the lease is live. After 120 seconds without a renewal, a new connect replaces the binding.
- `walkr-core disconnect <target>` with the same chat identity releases the binding.
- `walkr-core disconnect <target> --force` releases another chat's binding only after its lease expired.
- On the review page, the "Disconnect the Pi chat" button releases a live binding. It shows while a chat is bound.
- `walkr-core status` never names the bound chat. A caller learns only whether the binding is its own.

### Page text

| State | Text |
| --- | --- |
| Watcher live, no batch waits | "Agent connected; it wakes on Send" |
| Watcher live, batch not collected | "Sent — waking the connected agent"; the handoff box stays as the fallback |
| No watcher, batch not collected | "Sent — no agent is collecting it" |
| A chat is bound | The "Disconnect the Pi chat" button |

## Commands

| Command | Use |
| --- | --- |
| `walkr-core <file-or-localhost-url>` | Open a review and print its URL |
| `walkr-core poll <target> [--ack <batch_id>] [--timeout <secs>]` | Wait for a Send and print the batch as JSON |
| `walkr-core status <target>` | Report whether feedback waits, without waiting |
| `walkr-core connect <target> --pi-session-id <id> --pi-session-file <file>` | Bind the Pi chat that wakes on Send (the extension runs this) |
| `walkr-core disconnect <target> --pi-session-id <id> --pi-session-file <file>` or `--force` | Release the binding |
| `walkr-core claim-wake <target> --batch-id <batch_id> --pi-session-id <id> --pi-session-file <file>` | Claim the one wake for a batch (the extension runs this) |
| `walkr-core setup [--global]` | Install the five Walkr skills. See [Modes](modes.md#skills). |
| `walkr-core --help`, `walkr-core --version` | Show help or the version |

## Settings

| Variable | Effect |
| --- | --- |
| `HUMAN_REVIEW_STATE_DIR` | The state directory. The default is `~/.human-review`. It holds `state.json` and the server record `server.json`. |
| `HUMAN_REVIEW_NO_BROWSER` | `1` prints the URL and opens no browser |
| `HUMAN_REVIEW_PORT` | A fixed port for the server. The default is a free port. |
| `HUMAN_REVIEW_IDLE_MS` | The idle time before the server stops. The default is 45 minutes. |
| `HUMAN_REVIEW_CORE_COMMAND` | The command of the wake-up watcher, as a JSON array |

## Limits

- A wake can race a poll. Then the wake still starts a turn, and the poll returns the batch. The `batch_id` rule prevents a second application.
- If Pi exits between the claim and the wake message, that batch does not wake the chat again. The handoff box stays the fallback.
- `state.json` holds the bound chat identity. A process that can read the state directory can see it.
- A local process that has the page token can call the page actions. This is the same trust level as Send and End review.
