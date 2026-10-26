# Walkr

Walkr lets you review the work of a coding agent in your browser.
It opens an HTML file, a Markdown file or a `localhost` page.
You edit text, delete elements and write comments on the page. Then you select Send.
Your agent receives all of the feedback in one batch, with the exact text and element of each comment.

Walkr also has three modes for design choices and data.
Double shows two candidates of a page side by side, and you keep or delete regions over rounds.
Coinflip shows two candidates of one component, and you pick a winner round by round.
Trainer shows items in groups of three, and your ranks become a preference dataset.
Everything runs on your computer. Walkr needs no account, cloud service or database.

## Install

You need Node.js 20.19.0 or newer, npm and Git.

```sh
git clone https://github.com/ryg40/walkr.git ~/walkr && cd ~/walkr && ./install.sh
```

The script installs the dependencies, links the five commands into `~/.local/bin` and installs the agent skills.
The [install guide](INSTALL.md) explains each option, the manual steps and the uninstall.

## Quick start

1. Open a file for review:

   ```sh
   walkr /absolute/path/page.html
   ```

   Walkr starts a local server and opens the page in your browser.
   It prints the review URL, for example `http://127.0.0.1:<port>/s/<session-id>`.
2. Edit and comment on the page. Then select Send.
3. The agent collects the feedback with a bounded poll, applies it, and acknowledges the batch:

   ```sh
   walkr poll /absolute/path/page.html --timeout 240
   walkr poll /absolute/path/page.html --ack <batch_id> --timeout 240
   walkr status /absolute/path/page.html
   ```

You seldom type these commands yourself. The agent skills tell the agent to run them.
`walkr-core setup` installs five skills: `walkr`, `walkr-core`, `walkr-double`, `walkr-coinflip` and `walkr-trainer`.
`walkr-core setup --global` installs them for your user. The installer runs setup for you.
Then ask your agent for a review, or type `/walkr <file>`.

## Modes

| Mode | Command | What you do | Guide |
| --- | --- | --- | --- |
| Core | `walkr-core` (also `walkr`) | Review one HTML or Markdown file, or a `localhost` page. Send exact feedback to the agent. | [Core](docs/core.md) |
| Double | `walkr-double` | Compare two candidates of one page side by side. Keep or delete regions over rounds. | [Double](docs/double.md) |
| Coinflip | `walkr-coinflip` | Pick a winner between two candidates of one component, round by round. | [Coinflip](docs/coinflip.md) |
| Trainer | `walkr-trainer` | Rank items in groups of three to build a dataset. | [Trainer](docs/trainer.md) |

Double, Coinflip and Trainer share one browser view, the shared GUI. You type a brief there, and the connected agent makes the candidates.
In Double and Coinflip, the prompt box also [steers](docs/steering.md) an active review.
[Modes, commands and skills](docs/modes.md) lists every command and skill. The [glossary](GLOSSARY.md) defines the words.

## Pi integrations

Walkr has optional extensions for the Pi coding agent in `integrations/pi/*.ts`.
`shared-gui.ts` connects one Pi chat to the shared GUI.
`double-chat.ts` and `double-session-chat.ts` return Double results to the chat that started them.
`core-wake.ts` wakes the chat that started a Core review when a Send waits.
Nothing loads them automatically. Load one when you start Pi, with `pi --extension <absolute path>`.
Claude Code, Codex and other agents use the commands and the skills.

## Credits

Walkr is a fork of [Human Review](https://github.com/petergyang/human-review) 0.8.2 by Peter Yang, from upstream commit `f9a5581`, under the MIT license.

## License

MIT. See [LICENSE](LICENSE).
