# Trainer

You rank prepared items in groups of three. Walkr saves the votes as a repository-scoped preference dataset.
Trainer is local-only. It starts from the agent CLI or from the [shared GUI prompt](#start-from-the-shared-gui).
Hosted Trainer, fetches from other services, upload, and model training are not part of it.
In this guide, "you" are the person who ranks, and "the agent" is the coding agent that prepares the data.

## Flow

1. The agent prepares a dataset with stable source IDs and exact text or Markdown content. Walkr never fetches anything.
2. The agent proposes a grouping plan: groups of exactly three source IDs, each with a stable group ID, plus a short explanation.
3. The agent submits the dataset and the plan with `walkr-trainer create`. The command prints a private page URL.
4. You review the plan on that page: approve, or request changes with a note.
   After a change request, the agent submits a revised plan with `walkr-trainer plan`. Each revision is kept.
5. After approval, the page shows one group at a time. Clicks assign ranks 1, 2, 3; 1 is the best.
   Clicking a ranked candidate removes its rank and closes the gap: removing 1 moves 2 and 3 to 1 and 2.
   The next click gets the next free rank. You can correct ranks, then use one Save and Next action.
6. Each saved vote creates an analysis request. The agent reads pending requests and submits or fails an analysis.

## Data contract

One record per session: `<root>/<repo-name>/dataset/<session-id>/dataset.json`.
The record is JSON with `schema: "walkr-trainer-dataset"`, `version: 1`, and a `checksum` of the rest of the record.

| Field | Content |
| --- | --- |
| `repo` | `{ name, remote?, revision? }` as supplied by the agent; `name` is validated |
| `sessionId`, `createdAt`, `updatedAt`, `revision` | Session identity, ISO times, and a counter that increases with each commit |
| `task` | The review task or rubric shown on the page |
| `status` | `plan-review`, `changes-requested`, `ranking`, `complete`, or `ended` |
| `createAction` | Action ID and request hash of the create request, for exact replay |
| `gui` | Optional: `{ sessionId, requestId, attemptId }` of the shared-GUI start that the create request named |
| `ended` | Optional: `{ actionId, requestSha256, at, fromStatus }` of the End that you selected |
| `items` | `{ sourceId, format, content, contentSha256, title?, uri? }` in submitted order; `format` is `text` or `markdown` |
| `datasetSha256` | Hash of the ordered source IDs, formats, and content hashes |
| `plans` | Every plan revision: explanation, groups, leftovers, submit action, and your `review` |
| `groups` | Built from the approved plan: `candidates` `{ candidateId, sourceId, contentSha256 }`, `displayOrder`, `vote`, `analysis` summary |
| `leftovers` | `{ sourceId, state: "unranked", contentSha256 }` |
| `analyses` | Separate analysis records: status, model identity, observations or error, and the hash of the vote they describe |

A `vote` has `ranks` (candidate ID to rank), `ranking` (candidate IDs from rank 1 to 3), optional `comment`, `submittedAt`, `voteSha256`, and its action ID.
The candidate-to-rank mapping does not depend on display order. Display order is a fixed permutation per group, saved in the record.
Content is stored exactly. Immutable external references are not supported in this slice; `uri` is metadata only.
The record is the export. JSONL or other export formats are not added.

### Create request

```json
{
  "actionId": "create-my-app-stories-1",
  "repo": { "name": "my-app", "revision": "3bc9b6c" },
  "task": "Rank the stories by clarity of acceptance criteria.",
  "items": [{ "sourceId": "STORY-1", "format": "markdown", "title": "Login", "content": "As a user ..." }],
  "plan": {
    "explanation": "Grouped by product area.",
    "groups": [{ "groupId": "g001", "sourceIds": ["STORY-1", "STORY-2", "STORY-3"], "explanation": "Login flow" }],
    "leftovers": []
  }
}
```

A create request from a shared-GUI start also has `"gui": { "sessionId", "requestId", "attemptId" }`, copied unchanged from the start packet.
The request hash covers it, so one create action links one start only.

Limits: 1 to 3000 items, 256 KiB per item content, 24 MiB per request.
IDs are nonempty, at most 200 characters, and contain no whitespace or control characters.

## Leftover policy

- Only complete groups of three. The plan has exactly `floor(n / 3)` groups and exactly `n mod 3` leftovers.
- Every source ID appears exactly once, in one group or in the leftovers. A missing, repeated, or unknown ID refuses the plan.
- Leftovers are listed on the page and in the record as `unranked`. They never get a vote.
- Candidates are never reused across groups, and no vote is invented. Only the page credential can save a vote.

## Storage path rules

- Default root: `~/.local/.walkr/trainer`.
- `HUMAN_REVIEW_TRAINER_ROOT` overrides the root. Tests and trials use a disposable directory.
- The root must be a canonical absolute path. Missing root directories are created with mode 0700.
  The root must belong to the current user and must not be group or world writable.
- The root, its ancestors, the repository directory, the `dataset` directory, and the session directory must not be symlinks.
  Repository, dataset, and session directories need mode 0700. Records need mode 0600 and one hard link.
- `<repo-name>` uses 1-100 letters, digits, dots, underscores, or hyphens and starts with a letter or digit.
- Session IDs are `YYYYMMDDTHHMMSSZ-<12 hex>`. The directory is reserved with an exclusive `mkdir`; a collision draws a new ID.
- Writes go to a temporary file in the session directory, then `fsync`, `rename`, and a directory `fsync`.
  A write refuses when the record changed outside this writer.
- Records are never deleted. Acknowledging or reading anything deletes nothing.
  A session directory without a record is an interrupted create; it is kept and holds no votes.

## Idempotency and recovery

- Each mutation carries an `actionId`. The same action and request returns the first result. The same action with another request returns `ACTION_CONFLICT`.
- A second Save and Next for an already saved group, from any action, returns `outcome: "already-saved"` with the first vote. The first vote never changes.
- `COMMIT_UNCERTAIN`, `RECOVERY_REQUIRED`, network loss, or an unreadable answer leave the request unresolved.
  The page keeps it in browser storage and offers a retry of the same request. Reload never sends it automatically.
- The store reads the record from disk for each request. A server restart keeps all saved votes.
  The private page URL belongs to one server run. After a restart, `walkr-trainer open` prints a new one.

## Analysis semantics

- Human ranks are ground truth. An analysis is an inferred interpretation (`kind: "inferred-interpretation"`) and never changes a vote.
- A saved vote sets the group analysis to `pending` at once.
- `preferred` describes the apparent attributes of the two higher-ranked candidates. `lowest` describes the traits of rank 3.
  Walkr fills in the candidate IDs from the vote; the agent supplies text and `model.id` (optional `provider`, `version`).
- The agent must name the `voteSha256` it analyzed. Another value returns `STALE_VOTE`.
- `analysis fail` records a failed attempt. The group stays pending, and a later submit adds a new attempt.
  A group with a complete analysis refuses another one (`ANALYSIS_EXISTS`).

## Agent commands

Set an explicit absolute `HUMAN_REVIEW_STATE_DIR`. The client checks that the server uses the same dataset root.

```sh
walkr-trainer serve
walkr-trainer create /absolute/request.json
walkr-trainer list <repo>
walkr-trainer view <repo> <session-id>
walkr-trainer open <repo> <session-id>
walkr-trainer review <repo> <session-id>
walkr-trainer plan <repo> <session-id> /absolute/plan.json          # { actionId, plan }
walkr-trainer wait <repo> <session-id> --for review|analysis [--timeout <seconds>]
walkr-trainer analysis pending <repo> <session-id>
walkr-trainer analysis submit <repo> <session-id> /absolute/analysis.json
walkr-trainer analysis fail <repo> <session-id> /absolute/failure.json
walkr-trainer gui view <gui-session-id>
walkr-trainer gui fail <gui-session-id> /absolute/fail.json        # { actionId, requestId, attemptId, message }
```

`walkr trainer ...` runs the same commands.
`serve` needs an empty state directory and runs a foreground loopback server. Run it in its own terminal or pane. Client commands never start or replace a server.
`wait` polls the server each 500 ms until the event or the timeout (default 240 seconds, maximum 3600).
The `gui` commands read a shared-GUI start and report a failed preparation. They need the shared GUI server (`walkr double serve`).

## HTTP interface

All routes sit under `/_walkr/trainer/`, keep the loopback Host check, and refuse query strings. Hosted mode refuses all of them.

| Route | Credential | Purpose |
| --- | --- | --- |
| `GET api/capabilities` | Agent | `{ trainer: 1, rootId }` |
| `POST api/sessions` | Agent | Create from dataset and plan; returns the private page path. With `gui`, the shared GUI links it first |
| `GET api/repos/<repo>` | Agent | List sessions |
| `GET api/sessions/<repo>/<id>` | Agent or page | Record and progress |
| `POST api/sessions/<repo>/<id>/open` | Agent | New private page path for this server run |
| `POST api/sessions/<repo>/<id>/plan` | Agent | Revised plan after a change request |
| `POST api/sessions/<repo>/<id>/review` | Page only | `{ actionId, revision, decision, note? }`; a change request for a GUI-started dataset needs the connected chat |
| `POST api/sessions/<repo>/<id>/save` | Page only | `{ actionId, groupId, ranks, comment? }` (Save and Next) |
| `GET api/sessions/<repo>/<id>/analysis` | Agent | Pending analysis requests with ranked content |
| `POST api/sessions/<repo>/<id>/analysis/submit` | Agent | `{ actionId, groupId, voteSha256, model, preferred, lowest }` |
| `POST api/sessions/<repo>/<id>/analysis/fail` | Agent | `{ actionId, groupId, voteSha256, error, model? }` |
| `GET s/<capability>` | None (capability URL) | The private page |

The agent credential cannot call `review` or `save` directly. A page credential reaches only its own session.
The agent relays the private page URL to you, so it can reach the page credential.
This split guards against mistakes, not against a hostile or steered agent. Dataset text is untrusted and can try to steer the agent.

## Page

The page uses the shared mode navigation, all seven themes, and the private shell CSP (`script-src 'self'`; the page loads no frames itself).
Its `frame-ancestors 'self'` lets the shared GUI of the same server show it in a frame; no other origin can frame it.
Item content renders as plain text in a `pre` element. Markdown is shown as source text, never as live HTML.
The page shows progress, the plan review, the ranking view with visible ranks, the group list with analysis status, and the leftovers.
An ended session shows a notice. For a GUI-started session, Request changes is disabled while the bound chat is disconnected.
Static HTML components are not supported in this slice.

## Start from the shared GUI

Training is the Trainer choice of the shared GUI.
The [connection steps](double.md#start-from-the-shared-gui) are the same as for Double and Coinflip: one explicitly connected Pi chat.

1. In the GUI, select Training, enter a brief, and select Send. The page switches to Training at once.
   The brief names the dataset and the ranking task. It is untrusted data, not tool, path, or destination authority.
2. The bound chat receives one `prepare` packet. Pi prepares the dataset and the plan and runs `walkr-trainer create`
   with the packet's `link` in the `gui` field. Pi does not relay the URL.
3. The GUI frames the private Trainer page of the linked dataset. You review the plan and rank there, with the page credential.
4. Each change request and each saved vote wakes the same chat with one packet: `plan-changes` or `analysis`.
5. When every group is saved, the review is finished and another review can start. Analysis continues until End.
   You select End Trainer session to close the session.

Training has no [prompt-box steering](steering.md). During a Training review the prompt text stays a draft, and Send instruction is hidden.

### How a start links to its dataset

- A start saves one `trainer-gui-<hash>.json` record in the Double archive: the brief, the bound chat, and one preparation request and attempt.
  The shared-GUI record keeps schema 1; its start entries can now name `trainer`.
- The create request names `{ sessionId, requestId, attemptId }` of the start. The shared GUI checks it before any dataset exists.
  It refuses an unknown start, a session of another mode, a wrong request or attempt (also an attempt before a Retry),
  a failed, interrupted, or ended start, and a disconnected chat.
- The dataset record keeps the same reference, and the GUI record keeps the dataset identity. An identical create replays to the same dataset.
  Any other create for a start that already has a dataset, in any repository of the root, is refused (`STALE_ATTEMPT`).
- If the link save fails after the dataset is created, the identical retry links it. If the chat disconnects first,
  the dataset stays unlinked in the root. A Retry cannot create a second dataset for that start, so you end the start.
- A dataset created with `walkr-trainer create` without `gui` is not a shared-GUI session. It does not count for the single-active rule,
  and it has no End: the standalone page has no End button.

### Wake-ups and receipts

- Wake-up events come from the durable records, not from the `notify` hook: one per start, per plan change request, and per saved vote.
  A crash between a commit and a notification cannot lose one. `notify` stays a no-op in the server.
- Delivery uses the existing receipt rules of [Double](double.md#delivery-to-the-pi-chat).
  An event is acknowledged only after its exact packet is in the bound Pi session file. A queued message is not a receipt.
- Preparation is attempt-bound like Coinflip generation. Disconnection marks it interrupted, and late work cannot link a dataset.
  On a failed or interrupted preparation the panel offers Retry or End. Retry needs the connected chat and the GUI browser credential.
  It keeps the saved request and brief, adds a new attempt, and sends one new `prepare` packet. Late work for an old attempt is refused.
  Nothing retries automatically.
- Votes and plan approval save while the chat is disconnected, because votes are ground truth.
  A change request asks Pi for new work, so it needs the connected chat (`DISCONNECTED`; the page disables the button).
- Wake-ups are never queued across a reconnection. A change request or a saved vote whose packet was never sent before
  the reconnection stays saved and pending; the listener holds it. The panel then offers Send pending requests (GUI browser
  credential, connected chat). That action sends each held request once, while it is still open. Pi can also read
  `walkr-trainer analysis pending` itself. An event that was sent before only recovers its receipt; it is never sent again.
- A failed delivery or a failed analysis never changes a vote. The GUI shows the delivery failure.
- After `walkr-trainer analysis fail` no new wake-up is sent. Pi retries only when it runs `analysis pending` itself.
- After End, no wake-up is sent, also for analysis requests that were saved but never delivered. Analysis of saved votes stays possible
  only through a manual `walkr-trainer analysis pending` run.
  `/shared-gui {"action":"retry-ack","sessionId":"<gui-session-id>","eventId":"<event-id>"}` checks the exact receipt again.

### End

- End Trainer session is the Trainer stop action.
  The panel also offers Retry and Send pending requests when they apply.
- End needs the GUI browser credential and works while disconnected. It closes the linked dataset first, then saves the GUI End.
  A saved End therefore always means that no vote is accepted. Every saved vote and analysis stays. Later plans, plan reviews, and votes are refused.
- If closing the dataset fails, the GUI session stays open and holds the slot. Select End again.
  A dataset record that cannot be read accepts no vote, so End saves and records the dataset as unavailable.
- End sends no final packet: the dataset record is the result.
- A finished review (every group saved) frees the single-active slot. The Pi listener stays for analysis until End.
  A failed preparation keeps the slot until Retry or End.
- A linked dataset that cannot be read shows as unavailable in the panel. The GUI connection, Double, Coinflip, and other sessions keep working.

### Serving and credentials

`walkr double serve` serves Trainer too. Set the same `HUMAN_REVIEW_STATE_DIR` and `HUMAN_REVIEW_TRAINER_ROOT` for the server and the agent.
The agent credential links datasets and reads events; it cannot end, retry, or send pending requests. The GUI browser credential does those
and reads the Trainer page path from the GUI view; it cannot call Trainer API routes. The framed page uses its own page credential for review and votes.
The GUI view is also agent-readable, so the agent can read `pagePath` from it, as from `walkr-trainer open`.
The agent can still reach the page and GUI URLs that it relays, so this split guards against mistakes, not against a hostile or steered agent.

`<id>` in this table is the route segment of the shared-GUI session id: `~` followed by `encodeURIComponent(id)`.
For example, the id `train-1` has the segment `~train-1`. The code is `encodeDoubleComparisonId` in `src/double-route.js`.
A raw id without the `~` gets no route. JSON bodies and CLI arguments take the raw id.
The dataset routes under `/_walkr/trainer/` above take the raw `<repo>` and `<id>` names, with no `~`.

| Interface | Credential | Contract |
| --- | --- | --- |
| `POST /api/double/gui/start` | GUI browser or agent | `{ actionId, mode: "trainer", brief }`; the shared start receipt rules |
| `GET /api/double/modes/trainer/sessions/<id>` | GUI browser or agent | Status, preparation request and earlier attempts, link, dataset progress, open analysis requests, `heldRequests`, private page path |
| `POST .../end` | GUI browser only | `{ actionId }` |
| `POST .../retry` | GUI browser only | `{ actionId, requestId, attemptId }` of the failed or interrupted attempt |
| `POST .../send-pending` | GUI browser only | `{ actionId }`; saves a release of the open unacknowledged change and analysis events |
| `GET .../events`, `POST .../ack` | Agent only | Derived events with acknowledgments, releases, and `datasetError`; `{ actionId, eventId }` |
| `POST .../fail` | Agent only | `{ actionId, requestId, attemptId, message }`; a failed preparation |

Archive compatibility: an older server refuses a shared-GUI record that holds a Trainer or Coinflip start (`RECOVERY_REQUIRED`).
Do not roll back to such a server with this archive.

## Tests

`test/trainer.test.js` uses real authenticated HTTP servers, disposable roots, jsdom for the page module, and a spawned CLI server.
It covers the 100-item accounting and restart, gap-closing rank removal and incomplete-ranking refusal, duplicate and uncertain saves,
analysis failure and retry, unsafe names, traversal, symlinked and writable roots, and the agent CLI.

`test/trainer-gui.test.js` covers the shared GUI start with installed Pi and an offline provider: one start packet, the dataset link,
refused links from another start, attempt, or mode, and one wake-up per change request and saved vote.
It also covers one active review across Double, Coinflip, and Training in both directions, End with saved votes, a refused create after End,
a failed or interrupted start (refused late creates, a browser Retry with a new attempt), a change request refused while disconnected,
a finished review that frees the slot, votes that stay when a delivery or an analysis fails, receipts that need the exact persisted packet,
requests held after reconnection until Send pending requests in the browser and then sent once, and old shared-GUI records.

## Limits

- The agent can reach the page credential through the URL that it relays (see HTTP interface). A possible later change:
  a one-use page URL, exchanged on first load for an HttpOnly cookie that `review` and `save` require.
  Then a URL that you already opened would be useless to the agent.
- One server process owns a root. Two servers on the same root are not supported; the record check refuses outside changes but is not a lock.
- The whole record is held in memory for each request. Very large datasets are slow.
- A home directory path with a symlinked component is refused for the default root. Set `HUMAN_REVIEW_TRAINER_ROOT` to a real path.
- Votes are final after Save and Next. There is no vote edit or undo after saving.
- The plan-change loop accepts any number of revisions and keeps all of them.
- The dataset file format is one JSON record per session.
- The GUI label is Training; the mode name stays `trainer`.
- Not verified: rendered layout in a real browser, accessibility with assistive technology, and a real model analysis.
  The shared GUI panel was checked in jsdom against a real `walkr double serve` process, not in a real browser.
