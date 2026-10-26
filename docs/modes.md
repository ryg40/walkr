# Modes, commands and skills

Walkr has four modes. Each mode has one command and one agent skill.
A fifth skill, `walkr`, sends a request to the correct mode.

| Mode | Command | Skill | Use | Guide |
| --- | --- | --- | --- | --- |
| Core | `walkr-core` (also `walkr`) | `walkr-core` | Review one HTML or Markdown file, or a `localhost` page, and send exact feedback to the agent | [Core](core.md) |
| Double | `walkr-double` | `walkr-double` | Compare two candidates of one page side by side. Keep or delete regions over rounds. | [Double](double.md) |
| Coinflip | `walkr-coinflip` | `walkr-coinflip` | Pick a winner between two candidates of one component, round by round | [Coinflip](coinflip.md) |
| Trainer | `walkr-trainer` | `walkr-trainer` | Rank prepared items in groups of three to build a dataset | [Trainer](trainer.md) |

The `walkr` skill routes an original review to Core and a named mode to its skill.

## Commands

Each command shows help with no arguments and with `--help`, `-h` or `help`. Each command accepts `--version`.

- `walkr-core` runs the review commands: open, `poll`, `status`, `connect`, `disconnect`, `claim-wake` and `setup`.
- `walkr-double` runs the Double commands. `walkr double ...` is the same.
- `walkr-coinflip` runs the agent commands of Coinflip. Coinflip runs only in the shared GUI.
- `walkr-trainer` runs the Trainer server and the agent commands. `walkr trainer ...` is the same.

The client commands of Double, Coinflip and Trainer never start, replace or stop a server.
Core is different. `walkr-core <target>`, `poll`, `connect`, `disconnect` and `claim-wake` start the Core server in the background when no compatible Core server runs.
`walkr-core status` and `walkr-core setup` start no server.
Double, Coinflip and the shared GUI need a server that you start with `walkr-double serve`.
Trainer alone needs `walkr-trainer serve`.
No command opens a chat, loads a Pi extension or requests a model.

## Mode bar

The Core review page and the Double, Coinflip and Trainer pages show a bar with the four modes.
The active mode has `aria-current="page"`. Each link names its command in the title.
The reviewed page itself gets no bar.

The bar links to fixed guide pages:

- `/_walkr/modes/core`
- `/_walkr/modes/double`
- `/_walkr/modes/coinflip`
- `/_walkr/modes/trainer`

These pages accept only GET. They show how to start the mode. They create no session and show no private URL.
To open a review, use the command of the mode.

## Skills

`walkr-core setup` installs the five skills: `walkr`, `walkr-core`, `walkr-double`, `walkr-coinflip` and `walkr-trainer`.
The [install guide](../INSTALL.md) runs it for you.

```sh
walkr-core setup            # this project
walkr-core setup --global   # your user
```

| Scope | Skills | Pi prompt aliases | Agent guidance |
| --- | --- | --- | --- |
| Project | `.claude/skills`, `.agents/skills` in the current directory | `.pi/prompts` | A short block in `AGENTS.md` |
| Global | `~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills` | None | None |

Setup writes the absolute path of your clone into each skill. Keep the clone in its place.

### Use the skills

- Claude Code: `/walkr`, `/walkr-core`, `/walkr-double`, `/walkr-coinflip`, `/walkr-trainer`.
- Pi: the bare commands `/walkr` and the others are prompt aliases from a project setup. `/skill:walkr` is the native Pi skill command.
- Other agents read the installed skills by name.

Each Pi prompt alias tells the agent to read one installed skill file. It passes your text as request data.
Request data gives no tool, chat or extension authority.

### Install for a Pi profile

Global setup writes no Pi prompt aliases. For a Pi profile, call the exported API in `src/setup.js` with an explicit absolute `piAgentDir`:

```sh
node --input-type=module <<'JS'
import os from 'node:os';
import { installSkills } from './src/setup.js';
console.log(installSkills(process.cwd(), {
  global: true,
  home: os.homedir(),
  piAgentDir: '/absolute/path/to/pi-profile',
  dryRun: true,
}).join('\n'));
JS
```

`dryRun: true` runs every check and writes nothing. It prints each planned action.
Run the same call from the clone directory. Put the absolute path of your Pi profile in `piAgentDir`.
Then run it again with `dryRun: false` to install.

### Conflicts and updates

Setup checks every target before it writes anything. A conflict in the last target leaves the earlier targets unchanged.

- Setup records the hash of each generated file in `.walkr-setup.json`. An update replaces only unchanged generated files.
- A generated file that you changed, an unknown file of the same name, or a symbolic link at a target stops setup with the exact path.
- Setup never follows or replaces a symbolic link and never deletes a skill directory.
- A known old `human-review` skill moves to `.walkr-setup-backups/human-review-<hash>` in the same agent directory.
  Known old `AGENTS.md` guidance changes to the short Walkr block. Changed guidance stays and setup prints a warning.

The discovery check reads only the selected agent directories and the Pi profile in `piAgentDir`.
It does not scan parent directories, other Pi profiles, other configured resource paths or packages. Check those by hand.
The check reads skill frontmatter with a strict subset of YAML. It can refuse a valid skill with unusual frontmatter, for example a quoted multiline `description`.

There is no force option. Resolve each conflict by hand, then run setup again.
Use one setup at a time. Setup does not roll back a failed write.

## Compatibility names

Walkr comes from Human Review. These names stay for compatibility:

- The `HUMAN_REVIEW_*` environment variables.
- The `x-human-review-token` header of the local HTTP API.
- The default Core state directory `~/.human-review`.

The old `/human-review` skill is not installed. Setup replaces a known copy of it.
