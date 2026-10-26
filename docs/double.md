# Double

Double shows two candidates of one page side by side.
You mark the regions to keep, delete regions with or without feedback, and send the result to the agent.
The words that Double uses are in the [glossary](../GLOSSARY.md#double).

Double is local only. It runs on `127.0.0.1` with a foreground server that you start.

## Three ways to use Double

| Way | Who starts it | What happens |
| --- | --- | --- |
| Shared GUI | You type a brief in the browser | The connected Pi chat makes two candidates. You review them round by round and choose a final page. |
| Session | The agent, with `walkr-double session create` | The same rounds as the shared GUI, started from the CLI with prepared copies |
| One comparison | The agent, with `walkr-double create` | One pair, one Send. The agent collects the result with `poll`. |

The shared GUI also runs [Coinflip](coinflip.md) and Training ([Trainer](trainer.md)).
Only one shared review can be active at a time across the three modes.

## Configure and start the server

Double needs two separate, absolute directories:

- `HUMAN_REVIEW_STATE_DIR`: the runtime state. It holds the local agent credential in `server.json`.
- `HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR`: the archive. It holds every saved action, batch and final page.

The two directories must not be nested. They need mode `0700`, the current user as owner and no symbolic links.
The parent of the archive must exist. The state directory must be empty or absent.

```sh
export HUMAN_REVIEW_STATE_DIR=/absolute/path/walkr-state
export HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR=/absolute/path/walkr-archive
walkr-double serve
```

`serve` runs in the foreground on `127.0.0.1` with a free port. It prints a ready line and no credential.
Run it in its own terminal. Stop it with Ctrl-C. The archive and your files stay.
Set the same two variables in every terminal that runs a client command, and in the Pi chat.

Only one server can write to an archive.
After a crash, start the server with a new empty state directory and the same archive.

The server stops after the idle time of `HUMAN_REVIEW_IDLE_MS` (default 45 minutes). `0` turns the idle stop off.

## Start from the shared GUI

The shared GUI needs one persistent Pi chat. Ephemeral, print and JSON one-shot Pi sessions are refused.

1. Start the server as shown above.
2. Start Pi with the same two variables and the shared GUI extension. Use an absolute path.

   ```sh
   pi --extension /absolute/path/walkr/integrations/pi/shared-gui.ts
   ```

3. In that chat, run the connect command.

   ```text
   /shared-gui {"action":"connect","timeoutSeconds":240}
   ```

   The response is `{ active, status, origin, path, sessions }`. Check that `active` is `true` and `status` is `"connected"`.
   `origin.piSessionId` and `origin.piSessionFile` name the bound chat. `path` is the private GUI path.
   The connection lasts `timeoutSeconds` (default 240, at most 3600).
4. Open the private URL in your browser. Select Double, type a brief and select Send to Double.
   The page switches at once. The chat gets one request and prepares two candidates.

Warning: the private GUI URL gives access to the archive's shared review. Do not publish it.

The extension registers the `shared_gui_chat` tool and the `/shared-gui` command.
It also installs the Double session adapter, so do not load `double-session-chat.ts` in the same Pi run.
Loading and connecting do not request a model. A Send in the browser wakes the chat with one packet.

The agent prepares two static copies with its own tools. Each copy must pass the [input rules](double-input.md).
The first pair shows only after both copies pass the check and their bytes are saved in the archive.

## Review a pair

Each component has Keep and Discard controls and its own Comment field in the right column.
On narrow screens, the column moves below the previews.

A click on a component in the preview, or on a corner of its reticle, steps through three states:

| State | Mark | Next click |
| --- | --- | --- |
| Not selected | Gray | Kept |
| Kept | Green | Discarded |
| Discarded | Red | Not selected |

Hover never saves anything. Discarded content stays visible during the review. Done removes it from the final page.

The third click clears a component to Not selected. Undo is different: it restores the state before the deletion, so it can bring back Kept.

For [nested scopes](double-input.md#nested-scopes), the outermost kept or discarded `group` decides for every component inside it.
Their own choices stay saved but have no effect, so their Keep and Discard controls are off and show "Overridden by" the group. Their comments still save.
Clear the group to make their own choices apply again.

- A component comment saves without a change of the keep or discard state.
- An overall comment applies to the current round.
- Select Save comment before Next Round or Done. Unsaved text blocks both buttons.

### Session controls

| Status | Pair | Controls |
| --- | --- | --- |
| `editing` | Keepers, comments, deletions, Undo | Next Round, Send instruction, Done |
| `generating` | The last pair, read-only | Done |
| `failed` | The last pair and the failure text | Retry, Done |
| `ended` | The final pair, read-only | None |

- Next Round saves the round and asks for a new pair. Zero keepers is allowed.
- The new left page is the combined page. It keeps every keeper's content and design, and fills gaps from the brief and the feedback.
- The new right page is the challenger. It uses the feedback, and it can redesign the keeper regions.
- A deleted region is not restored unchanged.
- Send instruction is Next Round with a new instruction from the prompt box. See [Steering](steering.md).
- Retry repeats the saved request with a new attempt. Nothing retries automatically.
- Done opens a choice of Left or Right. Nothing is preselected. The chat gets the whole chosen page with its deletions and the feedback history.

While Pi is disconnected, new generation is off. Saved work stays readable, and Done can still save the result.
The page shows delivery as pending until the chat receives the final packet.

### Stop before the first pair

Select Stop before the first pair to end a shared review with no result.
The brief and the history stay. Late candidates cannot reopen it.

## Final page

The final result has the chosen page and the history of every round:

```js
{
  sessionId: "landing-session",
  page: {
    comparisonId: "round-2", pane: "left", entry: "index.html",
    deletedComponentIds: ["hero"], deletionMode: "static-display-none",
    files: [{ path: "index.html", sha256: "<hash>", base64: "<checked bytes>" }]
  },
  history: [ /* every round's saved batch, in order */ ]
}
```

- `files` holds the entry and every declared asset, with SHA-256 hashes and the bytes in base64.
- A deleted component gets an inline `display:none!important`. A deleted `frame` component keeps its children and loses only its own border, background and padding.
- A discarded frame keeps its margins, gaps, inherited styles such as `color` or `font`, `::before` and `::after` content, transforms and filters, and the rules that style its children through its class. The reset is not a complete strip.
- A deletion hides the markup. It does not remove the markup or the assets from the delivered HTML and `files`.
- A page without deletions keeps its exact original bytes.
- Double writes no output file. The agent decides where the result goes.

## Reconnect and recover

1. Read the saved state:

   ```sh
   walkr-double gui view
   walkr-double session view '<session-id>'
   walkr-double session events '<session-id>'
   walkr-double session output '<ended-session-id>'
   ```

2. For an uncertain browser action, select Resolve saved request or Retry. This sends the exact original request again.
3. Use the same Pi chat and the same archive. Another chat cannot take over the binding of an archive.
4. Reconnect with `/shared-gui {"action":"connect"}` after the old connection stopped. After a server restart, use the new private URL.
5. For an interrupted generation, select Mark interrupted attempt failed. Then select Retry, Stop or Done.
6. For a failed delivery, retry the receipt of that event:

   ```text
   /shared-gui {"action":"status"}
   /shared-gui {"action":"retry-ack","sessionId":"<session-id>","eventId":"<event-id>"}
   /shared-gui {"action":"disconnect"}
   ```

A reconnection never repeats an earlier generation.

After a server restart, `session reopen` needs both copy folders unchanged, because the frames read them. Reopen refuses a changed or missing copy.
Without the copies, the saved view, the events, the acknowledgments and the final output stay readable.

Drafts that the browser saved to the server come back at a new server URL.
Unconfirmed browser actions and drafts that were saved only in the browser stay with the old URL, because each port is a separate browser origin.
The browser saves drafts and unconfirmed actions before it sends them. A reload never sends them again by itself.

## Delivery to the Pi chat

The chat receives a packet with `pi.sendMessage`. A packet counts as received only when its exact text is in the session file of the bound chat.
Then the extension acknowledges the event in the archive.
A packet larger than 256 KiB stays complete in the archive. The page then shows `oversized_output`, and nothing is cut.

Receipt limits: a session file up to 8 MiB, 4096 entries and 256 KiB per line.

## Session from the CLI

The agent can start a session without the shared GUI, from two prepared copies:

```sh
walkr-double session create /absolute/create-request.json   # { sessionId, brief, manifest }
walkr-double session view <session-id>
walkr-double session reopen <session-id>
walkr-double session events <session-id>
walkr-double session attach <session-id> /absolute/attach-request.json
walkr-double session fail <session-id> /absolute/fail-request.json
walkr-double session ack <session-id> /absolute/ack-request.json
walkr-double session output <session-id>
```

`manifest` follows the [input rules](double-input.md#input). `reopen` prints a private session page URL.
You use the page for Next Round, Retry and Done.
The commands `session actions`, `session next`, `session retry` and `session end` send the same requests from a file.

### Request files

Each request file holds one JSON object with exactly these fields. A missing or extra field is refused with `INVALID_REQUEST`.

| Command | Fields | Where the values come from |
| --- | --- | --- |
| `session actions` | `{ actionId, expectedRevision, comparisonId, action }` | `action` is one comparison action from the table below, without its own `actionId` or `expectedRevision` |
| `session next` | `{ actionId, expectedRevision, comparisonId }` | `revision` and `currentComparisonId` of the session view |
| `session end` | `{ actionId, expectedRevision, comparisonId, pane }` | As for Next. `pane` is `"left"` or `"right"`, from the last shown pair |
| `session retry` | `{ actionId, expectedRevision, requestId, attemptId }` | `revision`, `generation.requestId` and `generation.attempt.id` of a failed view |
| `session attach` | `{ actionId, requestId, attemptId, manifest }` | The running `generation.requestId` and `generation.attempt.id`, and the manifest of the new pair |
| `session fail` | `{ actionId, requestId, attemptId, message }` | The running attempt. `message` is a nonblank failure text |
| `session ack` | `{ actionId, eventId }` | An event id from `session events` |

The `action` object of `session actions` holds exactly the fields of one kind. Walkr gives the inner action its own id and revision.

| `kind` | `action` | Effect |
| --- | --- | --- |
| `keeper` | `{ kind: "keeper", pane, componentId, selected }` | `selected` is `true` or `false`. Marks or unmarks the component as a keeper |
| `delete` | `{ kind: "delete", pane, componentId }` | Deletes the component from the pane |
| `feedback-delete` | `{ kind: "feedback-delete", pane, componentId, feedback }` | Deletes the component and saves `feedback` |
| `comment` | `{ kind: "comment", pane, componentId, feedback }` | Saves `feedback` for the component. Also allowed on a deleted component |
| `round-comment` | `{ kind: "round-comment", feedback }` | Saves `feedback` for the whole round |
| `undo` | `{ kind: "undo", deletionActionId }` | Restores the component to its state before the deletion |
| `clear` | `{ kind: "clear", deletionActionId }` | Removes the deletion and the keeper mark of the component |

`pane` is `"left"` or `"right"`. `feedback` is a nonblank comment. `componentId` is a component `id` from `comparison.panes.<pane>.components` of the session view.
`deletionActionId` is the `deletionActionId` of a deleted component in that list, or an `id` in `comparison.history`. It is not the `actionId` of your request.
Undo and Clear accept only the current deletion of a component. Keeper and the two deletions of a deleted component return `INVALID_TRANSITION`; undo the deletion first.

Replay rules:

- One `actionId` names one complete request in the whole session. Keep the request until its receipt arrives.
- The same request with the same `actionId` returns the first receipt again. This check comes before all state and revision checks.
- The same `actionId` with another operation or another field value returns `ACTION_CONFLICT`. The key order does not matter.
- After an uncertain response, send the exact request again, also when the view has changed. Do not make a new `actionId`.
- A new request with an old `expectedRevision` returns `STALE_REVISION`. A request for another pair returns `STALE_COMPARISON`.
- A new Attach or Fail for an attempt that is not the current running attempt returns `STALE_ATTEMPT`. Retry needs a failed attempt.
- A receipt has `{ actionId, kind, revision }`. Next and Retry add `requestId`, `attemptId` and `eventId`. End and Ack add `eventId`. A successful Attach adds `comparisonId`.
- The first Attach of a shared-GUI session can fail on invalid prepared input. Walkr then saves a Fail receipt for that attempt: `kind` is `"fail"`, and it has no `comparisonId`.
  The attempt is failed and its message starts with `Initial validation failed:`. Send `session retry` for a new attempt. The exact Attach request again returns the same Fail receipt.
- An acknowledgment records receipt only. It does not change the pair or the generation.

The CLI sends each request to `/api/double/sessions/<id>/<command>`, for example `/api/double/sessions/~landing-session/next`.
`<id>` is the route segment of the session id: `~` followed by `encodeURIComponent(id)` (`encodeDoubleComparisonId` in `src/double-route.js`).
A raw id without the `~` gets no route. Request files and CLI arguments take the raw id.

To return each round to the Pi chat, load `integrations/pi/double-session-chat.ts` and run:

```text
/double-session-chat {"action":"start","doubleSessionId":"<session-id>","timeoutSeconds":240}
```

Its other actions are `status`, `cancel` and `retry-ack`.

## One comparison from the CLI

1. The agent prepares two copies and a manifest. See [input rules](double-input.md).
2. The agent creates the comparison. The command prints a private URL and opens no browser.

   ```sh
   walkr-double create /absolute/manifest.json
   ```

3. You open the URL. Each pane has the component controls:
   - Keep marks a keeper.
   - ✕ deletes a component without feedback.
   - Delete with feedback deletes it with a saved note.
   - Undo in the deleted-items list restores a deletion. The note stays as history.
4. You select Send. The result is then read-only.
5. The agent collects the result and records the receipt:

   ```sh
   walkr-double poll <comparison-id> --timeout 240
   walkr-double ack <comparison-id> <batch-id> --action-id <id>
   ```

`poll` waits up to `--timeout` seconds (default 240, at most 3600). On a timeout it prints `{"status":"timeout"}`.
An acknowledgment records receipt, not a source change. Retry a lost acknowledgment with the same batch id and action id.

Other commands: `walkr-double reopen <comparison-id>` prints the private URL again. `view` and `status` print the saved state.

### Return the result to a Pi chat

`integrations/pi/double-chat.ts` returns the result of one comparison to the Pi chat that created it.

1. Start Pi with the same two variables and `pi --extension /absolute/path/walkr/integrations/pi/double-chat.ts`.
2. Create the comparison. Do not share its URL yet.
3. In the chat, arm the subscription:

   ```text
   /double-chat {"action":"start","comparisonId":"<comparison-id>","timeoutSeconds":240}
   ```

4. Check that the response has `status: "waiting"` and `active: true`. Then share the URL.

On Send, the extension starts a chat turn with the result. The agent can use the `double_chat` tool with the same JSON.
Other actions: `status`, `cancel`, and `retry-ack` for an acknowledgment that failed.

## Security

- All `/api/double` routes need the `x-human-review-token` header. The Host must be `127.0.0.1:<port>` or `localhost:<port>`.
- The agent, the shared browser page, a session page and each frame have separate credentials.
- Candidate pages show in sandboxed frames with an opaque origin. Only the Walkr frame script runs in them; a candidate's own scripts are refused by the input rules.
- Briefs, labels, feedback and paths are data. They never select a chat, a tool or an output target.
- The agent relays the private URL, so it can reach the browser credential. The split protects against mistakes, not against a hostile agent.

## Limits

- One writer per archive. The archive has no lock across processes.
- An HTTP request is at most 24 MiB. A CLI response is at most 64 MiB, so a large final output can pass the CLI limit. The Pi receipt limits above are smaller.
- The copy folders must stay in place while the review runs, because the frames read them. The final page does not need them.
- Hosted Double is not supported in this release.
- The tests use jsdom and an offline Pi provider. Not verified: real model quality, visual contrast, real browser layout and screen readers.
