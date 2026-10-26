#!/bin/sh
# Install the Walkr commands from this clone and the Walkr agent skills.
# Writes only into $HOME, the bin directory and the clone. Never uses sudo.
set -eu

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Install the Walkr commands and agent skills from this clone.

Options:
  --bin-dir <dir>    Link the commands into <dir> (default: ~/.local/bin).
  --project <dir>    Install the skills into the project <dir>.
  --global           Install the skills for your user (~/.claude, ~/.codex, ~/.agents).
  --skip-setup       Link the commands only. Do not install skills.
  --pi-extension     Print how to load the optional Pi extensions.
  --dry-run          Print each action. Change nothing.
  --uninstall        Remove the command links that this script made.
  --yes              Do not ask. Without --project or --global, use the current directory.
  --help             Show this text.

Commands: walkr, walkr-core, walkr-double, walkr-coinflip, walkr-trainer.
EOF
}

fail() { printf 'install: %s\n' "$*" >&2; exit 2; }
say() { printf 'install: %s\n' "$*"; }
# Print $1 as one shell word in single quotes.
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

# Print an action; run it unless --dry-run.
run() {
  if [ "$dry" = yes ]; then
    printf 'would run: %s\n' "$*"
  else
    printf 'run: %s\n' "$*"
    "$@"
  fi
}

ask() {
  # $1 question. Sets $answer. Fails without a terminal.
  # Probe in a subshell: a failed exec redirection exits the shell itself.
  if ! (exec 3<>/dev/tty) 2>/dev/null; then
    fail "no terminal to ask: $1
Without a terminal, give --yes and one of --project <dir>, --global or --skip-setup."
  fi
  exec 3<>/dev/tty
  printf '%s ' "$1" >&3
  IFS= read -r answer <&3 || fail "cancelled"
  exec 3>&-
}

# Refuse a path ($2, named $1) with a newline or another control character.
# Command substitution drops a trailing newline and so changes such a path.
check_path() {
  case $2 in
    *[[:cntrl:]]*) fail "the $1 contains a newline or another control character; use another path" ;;
  esac
}

# Print the physical path of the existing directory $2 (named $1). The marker
# keeps a trailing newline of the path, so check_path sees it.
physdir() {
  p=$(cd -P "$2" && pwd -P && echo .) || exit 2
  p=${p%.}; p=${p%?}
  check_path "$1" "$p"
  printf '%s\n' "$p"
}

bin_dir='' project='' scope='' dry=no uninstall=no yes=no pi_ext=no
while [ "$#" -gt 0 ]; do
  case $1 in
    --bin-dir) [ "$#" -ge 2 ] || fail "--bin-dir needs a directory"; bin_dir=$2; shift 2 ;;
    --project) [ "$#" -ge 2 ] || fail "--project needs a directory"
      [ -z "$scope" ] || fail "choose only one of --project, --global and --skip-setup"
      scope=project; project=$2; shift 2 ;;
    --global|--skip-setup)
      [ -z "$scope" ] || fail "choose only one of --project, --global and --skip-setup"
      scope=${1#--}; shift ;;
    --pi-extension) pi_ext=yes; shift ;;
    --dry-run) dry=yes; shift ;;
    --uninstall) uninstall=yes; shift ;;
    --yes) yes=yes; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option: $1 (see --help)" ;;
  esac
done

[ -z "${SUDO_USER:-}" ] || fail "do not run this script with sudo; run it as your own user"
case ${HOME:-} in /*) ;; *) fail "HOME must be set to an absolute path" ;; esac
# Refuse control characters before any normalization.
check_path "home directory" "$HOME"
check_path "current directory" "${PWD:-}"
check_path "clone path" "$0"
check_path "bin directory" "$bin_dir"
check_path "project directory" "$project"
home=$(physdir "home directory" "$HOME")
clone=$(physdir "clone path" "$(dirname "$0")")
cwd=$(physdir "current directory" .)
[ -f "$clone/package.json" ] && [ -f "$clone/src/cli.js" ] || fail "run install.sh from a Walkr clone"

# Resolve a directory path that may not exist yet. Prints an absolute path
# without . or .. components. Existing parts resolve with cd -P; a missing
# part cannot be a link, so a .. after it removes it.
absdir() {
  case $1 in /*) rest=$1 ;; *) rest=$cwd/$1 ;; esac
  d=/
  while [ -n "$rest" ]; do
    c=${rest%%/*}
    case $rest in */*) rest=${rest#*/} ;; *) rest='' ;; esac
    case $c in
      ''|.) ;;
      ..) d=${d%/*}; [ -n "$d" ] || d=/ ;;
      *) next=${d%/}/$c
         if [ -d "$next" ]; then d=$(physdir "bin directory" "$next")
         elif [ -e "$next" ] || [ -L "$next" ]; then fail "$next is not a directory"
         else d=$next; fi ;;
    esac
  done
  printf '%s\n' "$d"
}

# True when $1 is $home, $clone or inside one of them.
allowed() {
  for root in "$home" "$clone"; do
    case $1 in "$root"|"$root"/*) return 0 ;; esac
  done
  return 1
}

bin_dir=$(absdir "${bin_dir:-$home/.local/bin}")

# name:target pairs. Targets come from the bin field of package.json.
# human-review is not linked: that npm name belongs to the upstream project.
links="walkr:src/cli.js walkr-core:src/walkr-core.js walkr-double:src/walkr-double.js walkr-coinflip:src/walkr-coinflip.js walkr-trainer:src/walkr-trainer.js"

if [ "$uninstall" = yes ]; then
  removed=0
  for pair in $links; do
    link=$bin_dir/${pair%%:*}
    target=$clone/${pair#*:}
    if [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ]; then
      run rm -f "$link"; removed=$((removed + 1))
    elif [ -e "$link" ] || [ -L "$link" ]; then
      say "keep $link: not a link to this clone"
    fi
  done
  if [ "$dry" = yes ]; then
    say "dry run: would remove $removed link(s) from $bin_dir"
  else
    say "removed $removed link(s) from $bin_dir"
  fi
  say "installed skills stay; remove them by hand if you want (see INSTALL.md)"
  exit 0
fi

# Prerequisites. The minimum comes from the engines field of package.json.
need=$(sed -n 's/.*"node": *">=\([0-9][0-9.]*\)".*/\1/p' "$clone/package.json")
[ -n "$need" ] || fail "cannot read the Node version from package.json"
command -v node >/dev/null 2>&1 || fail "Node.js $need or newer is required, and node is not on PATH"
have=$(node --version 2>/dev/null | sed 's/^v//')
version_ok() {
  # $1 >= $2, both as X.Y.Z
  old_ifs=$IFS; IFS=.
  # shellcheck disable=SC2086
  set -- $1 $2
  IFS=$old_ifs
  a1=${1:-0} a2=${2:-0} a3=${3:-0} b1=${4:-0} b2=${5:-0} b3=${6:-0}
  for v in "$a1" "$a2" "$a3" "$b1" "$b2" "$b3"; do
    case $v in ''|*[!0-9]*) return 1 ;; esac
  done
  [ "$a1" -gt "$b1" ] && return 0; [ "$a1" -lt "$b1" ] && return 1
  [ "$a2" -gt "$b2" ] && return 0; [ "$a2" -lt "$b2" ] && return 1
  [ "$a3" -ge "$b3" ]
}
have_core=${have%%-*}
# A prerelease (20.19.0-rc.1) is below its base version, so it must be newer than the minimum.
if [ "$have_core" != "$have" ] && version_ok "$need" "$have_core"; then
  fail "Node.js $need or newer is required; found the prerelease $have. Install a release Node and run again."
fi
if ! version_ok "$have_core" "$need"; then
  fail "Node.js $need or newer is required; found ${have:-an unknown version}. Install a newer Node and run again."
fi
command -v npm >/dev/null 2>&1 || fail "npm is required, and npm is not on PATH"
say "Node $have, npm found"

# Choose where the skills go.
if [ -z "$scope" ]; then
  if [ "$yes" = yes ]; then
    scope=project; project=.
  else
    say "Walkr installs five agent skills for Claude Code, Codex and Pi."
    ask "Install skills for [p]roject $cwd, [g]lobal (your user), or [s]kip? [p/g/s]:"
    case $answer in
      p|project|'') scope=project; project=. ;;
      g|global) scope=global ;;
      s|skip) scope=skip-setup ;;
      *) fail "choose p, g or s" ;;
    esac
  fi
fi
if [ "$scope" = project ]; then
  [ -d "$project" ] || fail "project directory does not exist: $project"
  project=$(physdir "project directory" "$project")
  allowed "$project" || fail "project $project is outside your home directory and the clone"
fi

# Refuse before any write when a link name is taken by something else.
for pair in $links; do
  link=$bin_dir/${pair%%:*}
  target=$clone/${pair#*:}
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ]; then continue; fi
  if [ -e "$link" ] || [ -L "$link" ]; then
    fail "$link exists and is not a link to this clone; move it away and run again"
  fi
done

say "clone: $clone"
say "bin directory: $bin_dir"
case $scope in
  project) say "skills: project $project" ;;
  global) say "skills: global, in $home" ;;
  *) say "skills: skipped" ;;
esac
if [ "$yes" = no ] && [ "$dry" = no ]; then
  ask "Continue? [y/N]:"
  case $answer in y|Y|yes) ;; *) fail "cancelled; nothing changed" ;; esac
fi

# 1. Dependencies, without package install scripts.
if [ "$dry" = yes ]; then
  printf 'would run: (cd %s && npm ci --ignore-scripts)\n' "$clone"
else
  printf 'run: (cd %s && npm ci --ignore-scripts)\n' "$clone"
  (cd "$clone" && npm ci --ignore-scripts)
fi

# 2. Command links.
[ -d "$bin_dir" ] || run mkdir -p "$bin_dir"
for pair in $links; do
  link=$bin_dir/${pair%%:*}
  target=$clone/${pair#*:}
  if [ -L "$link" ]; then
    say "keep $link: already linked"
  else
    run ln -s "$target" "$link"
  fi
done
case :${PATH:-}: in
  *:"$bin_dir":*) ;;
  *) say "warning: $bin_dir is not on PATH. Add it to PATH in your shell startup file, for example:"
     # The user's shell expands $PATH, not this script.
     # shellcheck disable=SC2016
     printf '  export PATH="%s:$PATH"\n' "$bin_dir" ;;
esac

# 3. Skills, through the setup command of walkr-core.
case $scope in
  global)
    if [ "$dry" = yes ]; then
      printf 'would run: (cd %s && node %s/src/walkr-core.js setup --global)\n' "$home" "$clone"
    else
      printf 'run: (cd %s && node %s/src/walkr-core.js setup --global)\n' "$home" "$clone"
      (cd "$home" && node "$clone/src/walkr-core.js" setup --global)
    fi ;;
  project)
    if [ "$dry" = yes ]; then
      printf 'would run: (cd %s && node %s/src/walkr-core.js setup)\n' "$project" "$clone"
    else
      printf 'run: (cd %s && node %s/src/walkr-core.js setup)\n' "$project" "$clone"
      (cd "$project" && node "$clone/src/walkr-core.js" setup)
    fi ;;
esac

# 4. Optional Pi extensions. Pi loads each one with --extension; nothing is copied.
if [ "$pi_ext" = yes ]; then
  say "Pi extensions are optional. Load one in a Pi session with --extension:"
  for file in "$clone"/integrations/pi/*.ts; do
    [ -f "$file" ] || continue
    printf '  pi --extension %s\n' "$(quote "$file")"
  done
  say "see the Pi integrations section of INSTALL.md before you load one"
fi

if [ "$dry" = yes ]; then
  say "dry run: nothing changed"
else
  say "done. Try: walkr --help"
fi
