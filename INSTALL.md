# Install Walkr

Walkr is a local review tool. It opens an HTML or Markdown file in your browser on `localhost`. You comment in the browser, and your agent reads the comments.

The code also has a hosted mode (`HUMAN_REVIEW_HOSTED`). This release does not support hosted mode.

This page installs Walkr from a clone of this repository. The [question list](skills/walkr-install/SKILL.md) is for an agent that installs Walkr for a user.

Words used below:

- `<clone>`: the directory of this repository, for example `~/walkr`.
- `<bin>`: the directory for the command links. The default is `~/.local/bin`.

## Prerequisites

- Node.js 20.19.0 or newer. The `engines` field of `package.json` holds the minimum.
- npm. It comes with Node.js.
- Git, any current version.
- A browser on the same computer.
- Linux or macOS. Windows is not supported.

Check the versions:

```sh
node --version
npm --version
```

Run `install.sh`, or follow [the manual steps](#manual-install).

## Clone

```sh
git clone https://github.com/ryg40/walkr.git ~/walkr
cd ~/walkr
```

Keep the clone in its place. The command links point into it.

## Run install.sh

```sh
./install.sh
```

The script does these steps, in this order:

1. It checks Node.js and npm. It stops when Node.js is too old.
2. It runs `npm ci --ignore-scripts` in the clone. No package install script runs.
3. It links five commands into `<bin>`: `walkr`, `walkr-core`, `walkr-double`, `walkr-coinflip` and `walkr-trainer`.
4. It installs the Walkr agent skills with `walkr-core setup`.

The script asks where the skills go, then asks for approval. It never uses `sudo`. It writes only into your home directory, `<bin>` and the clone. It stops before the first write when a link name is occupied by another target.

### Options

| Option | Effect |
| --- | --- |
| `--bin-dir <dir>` | Link the commands into `<dir>` in place of `~/.local/bin`. |
| `--project <dir>` | Install the skills into the project `<dir>`. The directory must be inside your home directory or inside the clone. |
| `--global` | Install the skills for your user, in `~/.claude`, `~/.codex` and `~/.agents`. |
| `--skip-setup` | Link the commands only. Install no skills. |
| `--pi-extension` | Print the command that loads each optional Pi extension. See [Pi integrations](#pi-integrations). |
| `--dry-run` | Print each action. Change nothing. |
| `--uninstall` | Remove the command links that the script made. See [Uninstall](#uninstall). |
| `--yes` | Do not ask. Without `--project` or `--global`, the skills go into the current directory. |
| `--help` | Show the options. |

Without a terminal, give `--yes` and one of `--project`, `--global` or `--skip-setup`.

The script refuses a home, clone, bin or project path that contains a newline or another control character. This includes a path that gets such a character through a symbolic link.

Examples:

```sh
./install.sh --dry-run --global
./install.sh --global --yes
./install.sh --project ~/code/my-site --bin-dir ~/bin
```

### Where the skills go

`walkr-core setup` installs five skills: `walkr`, `walkr-core`, `walkr-double`, `walkr-coinflip` and `walkr-trainer`.

- Project: `<project>/.claude/skills`, `<project>/.agents/skills`, Pi prompt aliases in `<project>/.pi/prompts`, and a short block in `<project>/AGENTS.md`.
- Global: `~/.claude/skills`, `~/.codex/skills` and `~/.agents/skills`. Global setup installs no Pi prompt aliases.

Setup stops with a conflict message when a target file is a link or was changed by hand. It changes no file in that case.

## First review

Make sure that `<bin>` is on `PATH`. Then open a file:

```sh
walkr ~/code/my-site/index.html
```

Walkr starts a local server and opens the page in your browser. Click an element and write a comment. Your agent reads the comments with the commands below:

```sh
walkr status ~/code/my-site/index.html
walkr poll ~/code/my-site/index.html --timeout 240
```

In an agent with the skills, ask for a review, or type `/walkr`.

## Modes

| Mode | Command | Use |
| --- | --- | --- |
| Core | `walkr-core <file>` (same as `walkr`) | Review one HTML or Markdown file, or a `localhost` page. Comments go back to the agent. |
| Double | `walkr-double` | Compare two candidates of one page side by side. Send changes back over rounds. |
| Coinflip | `walkr-coinflip` | Pick a winner between two candidates of one component, in the shared browser view. |
| Trainer | `walkr-trainer` | Rank prepared items in groups of three. The agent saves the votes as a dataset. |

Each command has `--help`. The skills of the same names tell the agent how to use each mode.

## Pi integrations

Walkr has four optional extensions for the Pi coding agent, in `integrations/pi/`:

| File | Use |
| --- | --- |
| `shared-gui.ts` | Connects one Pi conversation to the shared browser view of Double, Coinflip and Trainer. |
| `double-chat.ts` | Returns the result of one Double comparison to the Pi conversation that started it. |
| `double-session-chat.ts` | Returns each round of a Double session to the Pi conversation that started it. |
| `core-wake.ts` | Wakes the Pi chat that started a Core review when a Send waits and no poll collects it. See [Core: Automatic wake-up for Pi](docs/core.md#automatic-wake-up-for-pi). |

Nothing loads them automatically. The installer copies nothing into Pi. Load one extension when you start Pi, with an absolute path:

```sh
pi --extension ~/walkr/integrations/pi/shared-gui.ts
```

Loading registers a tool and a command only. It does not connect to Walkr. The connection needs an explicit command in the Pi conversation. `./install.sh --pi-extension` prints the line for each file of your clone.

Claude Code and Codex do not use these files. They use the commands and the skills.

## Uninstall

```sh
./install.sh --uninstall
```

Give the same `--bin-dir` as for the install. The script removes each link in `<bin>` that points into this clone. It keeps every other file in `<bin>`.

The script does not remove the skills. To remove them, delete these files from the directories in [Where the skills go](#where-the-skills-go):

- the five `walkr*` folders in each `skills` directory,
- the `.walkr-setup.json` file in each of `.claude`, `.codex`, `.agents` and `.pi`,
- the five `walkr*.md` files in `.pi/prompts` of a project,
- the block between `<!-- walkr:start -->` and `<!-- walkr:end -->` in `AGENTS.md` of a project.

Then delete the clone.

## Manual install

Use these steps when `install.sh` cannot run.

```sh
cd ~/walkr
npm ci --ignore-scripts
npm link
node src/walkr-core.js setup --global
```

Warning: `npm link` also links the `human-review` command, and it writes into the global npm prefix.

## Troubleshooting

### Node.js is too old

`install.sh` prints `Node.js 20.19.0 or newer is required`. Install a newer Node.js, for example with your version manager. Then run `install.sh` again.

### `walkr: command not found`

`<bin>` is not on `PATH`. The installer prints a warning in that case. Add the line to your shell startup file, for example `~/.bashrc` or `~/.zshrc`:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Open a new shell, then run `walkr --help`.

### A link name is already in use

The installer stops with `exists and is not a link to this clone`. Another program uses the name, or an old clone has the link. Move the file away, or choose another directory with `--bin-dir`.

### The port is in use

Walkr chooses a free port by default. You can set a fixed port with `HUMAN_REVIEW_PORT`. When another program uses that port, the server prints `could not listen on port` and stops. Choose another port:

```sh
HUMAN_REVIEW_PORT=4802 walkr ~/code/my-site/index.html
```

### Setup reports a conflict

A skill file exists and differs from the Walkr copy, or it is a link. Setup changes nothing in that case. Move the named file away, then run `install.sh` again.
