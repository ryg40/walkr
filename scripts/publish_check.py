#!/usr/bin/env python3
"""The publish set, the public reader rules and the scan of Walkr.

Usage:
  publish_check.py [--ref REF] [--allow-no-local-deny]
      Check the publish set of REF (default HEAD): every exact file exists, every tracked
      file is published or excluded, no secret, no host value, no public reader finding.
  publish_check.py --list [--ref REF]
      Print the publish set of REF, one path for each line.
  publish_check.py scan [--level warn|fail] [--allow-no-local-deny] <mode> [<argument>]
      The scan of scripts/scan.sh. See docs/secret-handling.md.

The script needs Python 3.9 or later and Git. It uses no network and no package.
A finding names the rule, the file and the line. It never holds text of the file.
"""
import hashlib
import os
import re
import subprocess
import sys
from pathlib import Path

# --- the publish set ------------------------------------------------------------

# Exact files. Each one must exist in the source commit; a missing file is a finding.
PUBLISH = (
    ".gitattributes",
    ".gitignore",
    "CHANGELOG.md",
    "GLOSSARY.md",
    "INSTALL.md",
    "LICENSE",
    "README.md",
    "install.sh",
    "package-lock.json",
    "package.json",
)
# Directory rules: each tracked file below these directories is published.
PUBLISH_DIRS = (
    ".github/workflows/",
    "assets/",
    "docs/",
    "integrations/pi/",
    "prompts/",
    "skills/",
    "src/",
    "test/",
)
# The files of scripts/ that are published: the publisher, its scan, its hooks and its tests.
# Each one must exist; `scripts/git-hooks/` is a directory rule.
PUBLISH_SCRIPTS = (
    "scripts/host-values.allow",
    "scripts/host-values.allow-lines",
    "scripts/host-values.deny",
    "scripts/host-values.regex",
    "scripts/install-hooks.sh",
    "scripts/publish_check.py",
    "scripts/publish_portable.py",
    "scripts/scan.sh",
    "scripts/test_publish.py",
)
PUBLISH_SCRIPT_DIRS = ("scripts/git-hooks/",)
# Tracked files of the development copy that never leave. The list excludes itself.
DEV_ONLY_REL = "scripts/dev-only-files.txt"

# --- the lists of the scan (docs/secret-handling.md) ------------------------------

DENY_REL = "scripts/host-values.deny"
LOCAL_DENY_REL = ".local/host-values.deny"
REGEX_REL = "scripts/host-values.regex"
ALLOW_REL = "scripts/host-values.allow"
ALLOW_LINES_REL = "scripts/host-values.allow-lines"
DENY_FILES = (DENY_REL, LOCAL_DENY_REL)
ALLOW_NO_LOCAL_DENY_VARIABLE = "SCAN_ALLOW_NO_LOCAL_DENY"
LOCAL_DENY_VARIABLE = "SCAN_LOCAL_DENY"

# Secret rules. A match always fails. This file is in the publish set, so no expression
# matches its own source text, and no comment gives an example of a match.
SECRET_RULES = (
    ("private-key", re.compile(r"-----BEGIN[ A-Z0-9]*PRIVATE" r" KEY( BLOCK)?-----")),
    ("aws-access-key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("github-token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}")),
    ("gitlab-token", re.compile(r"\bglpat-[A-Za-z0-9_-]{20,}")),
    ("slack-token", re.compile(r"\bxox[abposr]-[A-Za-z0-9-]{10,}")),
    ("api-key-sk", re.compile(r"\bsk-(?:ant-|proj-|live-)?[A-Za-z0-9_-]{32,}")),
    ("google-api-key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("npm-token", re.compile(r"\bnpm_[A-Za-z0-9]{36}\b")),
    ("url-credential", re.compile(r"\b[a-z][a-z0-9+.-]*://[^\s/:@\"'<>()]+:[^\s/@\"'<>()]+@[A-Za-z0-9.-]+")),
    ("authorization-bearer", re.compile(r"(?i)\bauthorization\b[\"']?\s*[:=]\s*[\"']?bearer\s+[A-Za-z0-9._~+/=-]{20,}")),
    ("secret-assignment", re.compile(
        r"(?i)\b(?:api[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|passw(?:or)?d)\b"
        r"[\"']?\s*[:=]\s*[\"'][A-Za-z0-9_./+=-]{20,}[\"']")),
)

# Public reader rules: content that a reader of the public copy must not get
# (docs/publishing.md, "Public reader rules"). Written so that no expression matches its
# own source text.
PUBLIC_RULES = (
    # A reference to an entry of a private tracker: the word for an issue or a ticket, then
    # a number; a decision with a letter code.
    ("tracker-reference", re.compile(
        r"(?i)\b(?:(?:issue|ticket)s?[ \t]+#?[0-9]+|decision[ \t]+[A-Z][0-9]+)\b")),
    # A path of the home directory of the administrator or of a stack layout of one host.
    ("machine-path", re.compile(r"(?<![A-Za-z0-9_.~-])/(?:root|opt/" r"stacks)(?:/|\b)")),
    # A record of work on one host: the phrase for the one reference machine; a record word
    # and a date in one line; a date and a phrase for one host in one line, in each order.
    ("host-record", re.compile(
        r"(?i)\b(?:reference[ \t]+host\b"
        r"|(?:observ(?:ed|ation)|verified|seen|decided|approved|accepted)\b[^\n]{0,60}?\b20[0-9]{2}-[0-9]{2}-[0-9]{2}\b"
        r"|20[0-9]{2}-[0-9]{2}-[0-9]{2}\b[^\n]{0,80}?\b(?:this|live|lab|test)[ \t]+(?:host|vm)\b"
        r"|(?:this|live|lab|test)[ \t]+(?:host|vm)\b[^\n]{0,80}?\b20[0-9]{2}-[0-9]{2}-[0-9]{2}\b)")),
)

# Policy: a tracked file that can hide content from the scan, or a file of one host.
IGNORE_FILES = (".gitleaksignore", ".gitleaksbaseline", ".betterleaksignore", ".betterleaksbaseline")
ARCHIVE = re.compile(
    r"(?i)\.(?:zip|jar|war|ear|whl|egg|apk|aab|ipa|nupkg|tar|tgz|taz|tbz|tbz2|tb2|txz|tlz|tzst|gz|bz2|xz|zst|lz|"
    r"lz4|lzma|lzo|z|7z|rar|cab|cpio|ar|deb|rpm|iso|dmg|sql|dump|pgdump|backup|db|sqlite|sqlite3|db3|mdb|accdb|"
    r"rdb|bundle|pack)$")
MAGIC = (b"\x1f\x8b", b"\x1f\x9d", b"PK\x03\x04", b"PK\x05\x06", b"BZh", b"\xfd7zXZ\x00", b"\x28\xb5\x2f\xfd",
         b"7z\xbc\xaf\x27\x1c", b"Rar!\x1a\x07", b"!<arch>\n", b"SQLite format 3\x00", b"PGDMP",
         b"# v2 git bundle", b"# v3 git bundle", b"PACK\x00\x00\x00", b"REDIS0")

# The longest list of warnings that a scan prints in full.
WARN_LIMIT = 40


class Problem(Exception):
    """A tool or usage error: exit 2."""


# --- Git ----------------------------------------------------------------------------

def git(root, *args, input=None, env=None, check=True):
    """Bytes of the standard output of `git <args>` in `root`."""
    result = subprocess.run(["git", *args], cwd=root, input=input, env=env, capture_output=True)
    if check and result.returncode != 0:
        raise Problem(f"git {' '.join(args)}: {result.stderr.decode('utf-8', 'replace').strip()}")
    return result.stdout


def git_text(root, *args, **kwargs):
    return git(root, *args, **kwargs).decode("utf-8", "surrogateescape").strip()


def top_level(path="."):
    try:
        return Path(git_text(path, "rev-parse", "--show-toplevel")).resolve()
    except (Problem, OSError) as error:
        raise Problem("not inside a Git working tree") from error


def tree_entries(root, ref):
    """{path: (mode, type, object)} of every entry of the tree of `ref`, recursive."""
    entries = {}
    for item in git(root, "ls-tree", "-r", "-z", "--full-tree", ref).split(b"\0"):
        if not item:
            continue
        meta, _, path = item.partition(b"\t")
        mode, kind, obj = meta.decode().split()
        entries[path.decode("utf-8", "surrogateescape")] = (mode, kind, obj)
    return entries


def read_blobs(root, objects):
    """{object: bytes} for each blob id, with one `git cat-file --batch` call."""
    objects = sorted(set(objects))
    if not objects:
        return {}
    out = git(root, "cat-file", "--batch", input=("\n".join(objects) + "\n").encode())
    blobs, at = {}, 0
    for obj in objects:
        end = out.index(b"\n", at)
        header = out[at:end].split()
        if len(header) != 3:
            raise Problem(f"cannot read object {obj}")
        size = int(header[2])
        blobs[obj] = out[end + 1:end + 1 + size]
        at = end + 1 + size + 1
    return blobs


def show(root, ref, path):
    """Text of `path` in `ref`, or None."""
    result = subprocess.run(["git", "show", f"{ref}:{path}"], cwd=root, capture_output=True)
    return result.stdout.decode("utf-8", "replace") if result.returncode == 0 else None


# --- the publish set ------------------------------------------------------------------

def list_entries(text):
    return [line.strip() for line in text.splitlines() if line.strip() and not line.strip().startswith("#")]


def dev_only_entries(root, ref):
    """The entries of scripts/dev-only-files.txt in `ref`: exact paths or prefixes ending in /."""
    text = show(root, ref, DEV_ONLY_REL)
    if text is None:
        return ()
    entries = list_entries(text)
    for entry in entries:
        parts = entry.removesuffix("/").split("/")
        if (any(c.isspace() or ord(c) < 32 for c in entry) or "\\" in entry or entry.startswith("/")
                or any(part in ("", ".", "..") for part in parts)):
            raise Problem(f"{DEV_ONLY_REL}: invalid path entry")
    return tuple(entries)


def matches(name, entry):
    return name.startswith(entry) if entry.endswith("/") else name == entry


def publish_set(root, ref="HEAD"):
    """(sorted publish set, findings) of `ref`. A finding is (rule, path).

    The set is the exact files, the directory rules and the publisher files of scripts/,
    minus the files of scripts/dev-only-files.txt. Every tracked file must be in the set or
    in the dev-only list, every exact file must exist, and every dev-only entry must name
    a tracked file.
    """
    entries = tree_entries(root, ref)
    tracked = set(entries)
    findings = []
    dev_only = dev_only_entries(root, ref)
    excluded = {name for name in tracked if name == DEV_ONLY_REL or any(matches(name, e) for e in dev_only)}
    for entry in dev_only:
        if not any(matches(name, entry) for name in tracked):
            findings.append(("dev-only-unused", entry))
        elif not entry.endswith("/") and any(name.startswith(entry + "/") for name in tracked):
            findings.append(("dev-only-directory", entry))
    wanted = set()
    for name in PUBLISH + PUBLISH_SCRIPTS:
        if name not in tracked:
            findings.append(("publish-missing", name))
        elif name in excluded:
            findings.append(("publish-excluded", name))
        else:
            wanted.add(name)
    for name in tracked - excluded:
        if any(name.startswith(prefix) for prefix in PUBLISH_DIRS + PUBLISH_SCRIPT_DIRS):
            wanted.add(name)
    for name in sorted(tracked - excluded - wanted):
        findings.append(("unreviewed-file", name))
    for name in sorted(wanted):
        mode, kind, _ = entries[name]
        if kind != "blob" or mode not in ("100644", "100755"):
            findings.append(("publish-not-a-file", name))
    return sorted(wanted), findings


# --- the rules of the scan ---------------------------------------------------------------

def local_deny_file(root):
    """The path of the local deny list, or None.

    `SCAN_LOCAL_DENY` names the file. Else it is `.local/host-values.deny` of the checkout
    at `root`, or of the main checkout for a linked worktree.
    """
    named = os.environ.get(LOCAL_DENY_VARIABLE)
    if named:
        return Path(named) if Path(named).is_file() else None
    own = Path(root) / LOCAL_DENY_REL
    if own.is_file():
        return own
    try:
        common = Path(git_text(root, "rev-parse", "--path-format=absolute", "--git-common-dir"))
    except Problem:
        return None
    if common.name == ".git" and (common.parent / LOCAL_DENY_REL).is_file():
        return common.parent / LOCAL_DENY_REL
    return None


def read_list(path):
    try:
        return list_entries(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, UnicodeError) as error:
        raise Problem(f"cannot read {path}") from error


class Rules:
    """The deny lists, the regex list, the allow list and the accepted lines of one checkout."""

    def __init__(self, root, allow_no_local_deny=False):
        root = Path(root)
        tracked = read_list(root / DENY_REL)
        if tracked is None:
            raise Problem(f"missing {DENY_REL}")
        for pattern in tracked:
            if any(c in pattern for c in "'\"\\"):
                raise Problem(f"{DENY_REL}: a pattern contains a quote or a backslash")
        self.deny = [(f"host-value-{n}", p.lower()) for n, p in enumerate(tracked, 1)]
        local = local_deny_file(root)
        local_patterns = read_list(local) if local is not None else None
        self.local = bool(local_patterns)
        if not local_patterns:
            allowed = allow_no_local_deny or os.environ.get(ALLOW_NO_LOCAL_DENY_VARIABLE) == "1"
            if not allowed:
                state = "absent" if local is None else "empty"
                raise Problem(f"the local deny list {LOCAL_DENY_REL} is {state}. Write it, or give "
                              f"--allow-no-local-deny (or {ALLOW_NO_LOCAL_DENY_VARIABLE}=1) in a public clone")
        else:
            self.deny += [(f"host-value-local-{n}", p.lower()) for n, p in enumerate(local_patterns, 1)]
        self.regex, self.samples = [], []
        regex_lines = read_list(root / REGEX_REL)
        if regex_lines is None:
            raise Problem(f"missing {REGEX_REL}")
        for line in regex_lines:
            fields = line.split()
            if len(fields) != 3 or not re.fullmatch(r"[A-Za-z0-9-]+", fields[0]) or fields[0].startswith("local-"):
                raise Problem(f"{REGEX_REL}: each rule is <name> <sample> <regex>")
            try:
                expression = re.compile(fields[2])
            except re.error as error:
                raise Problem(f"{REGEX_REL}: rule {fields[0]} is not a valid expression") from error
            self.regex.append((f"host-value-{fields[0]}", expression))
            self.samples.append((f"host-value-{fields[0]}", fields[1].replace("_", ".").replace("-", ":")))
        self.allow = read_list(root / ALLOW_REL) or []
        for url in self.allow:
            if any(c in url for c in "'\"\\ \t") or not re.fullmatch(r"https://[^/]+/.+", url):
                raise Problem(f"{ALLOW_REL}: each line is an exact https URL with a path")
        self.accepted = set()
        for line in read_list(root / ALLOW_LINES_REL) or []:
            path, tab, digest = line.partition("\t")
            if not tab or not path or not re.fullmatch(r"[0-9a-f]{64}", digest) or path.startswith("/") \
                    or any(part in ("", ".", "..") for part in path.split("/")):
                raise Problem(f"{ALLOW_LINES_REL}: each line is <path><TAB><sha256>")
            self.accepted.add((path, digest))
        if not self.deny and not self.regex:
            raise Problem("no host-value rule")

    def host_rules(self, path, line):
        """The host-value rule ids that `line` of `path` matches."""
        found = [rule for rule, expression in self.regex if expression.search(line)]
        if path not in DENY_FILES:
            outside = line
            for url in self.allow:
                outside = outside.replace(url, "\x01")
            outside = outside.lower()
            found += [rule for rule, pattern in self.deny if pattern in outside]
        return found

    def is_accepted(self, path, line):
        return (path, hashlib.sha256(line.encode("utf-8", "surrogateescape")).hexdigest()) in self.accepted


def policy_findings(path, data):
    name = path.rsplit("/", 1)[-1].lower()
    if name in IGNORE_FILES:
        return [("policy-ignore-file", path, 0)]
    if path.startswith(".local/"):
        return [("policy-local-file", path, 0)]
    if ARCHIVE.search(path) or data.startswith(MAGIC) or data[257:262] == b"ustar":
        return [("policy-archive", path, 0)]
    return []


def scan_bytes(rules, path, data, public=False, policy=True):
    """Findings (class, rule, path, line) of one file. Class: secret, policy, host, public."""
    found = [("policy", rule, p, n) for rule, p, n in policy_findings(path, data)] if policy else []
    text = data.decode("utf-8", "replace")
    for number, line in enumerate(text.split("\n"), 1):
        for rule, expression in SECRET_RULES:
            if expression.search(line):
                found.append(("secret", rule, path, number))
        host = rules.host_rules(path, line)
        reader = [rule for rule, expression in PUBLIC_RULES if expression.search(line)] if public else []
        if (host or reader) and not rules.is_accepted(path, line):
            found += [("host", rule, path, number) for rule in host]
            found += [("public", rule, path, number) for rule in reader]
    return found


def scan_names(rules, names, where, public=False):
    """Findings in a list of file names; the line is the place in the sorted list."""
    data = "\n".join(sorted(names)).encode("utf-8", "surrogateescape")
    return [(kind, rule, where, n) for kind, rule, _, n in scan_bytes(rules, where, data, public=public, policy=False)]


# --- the modes of the scan --------------------------------------------------------------------

def scan_tree(root, rules):
    """The tracked files of the working tree, their staged content and their names."""
    found = []
    index = {}
    for item in git(root, "ls-files", "-s", "-z").split(b"\0"):
        if item:
            meta, _, path = item.partition(b"\t")
            mode, obj, _ = meta.decode().split()
            index[path.decode("utf-8", "surrogateescape")] = (mode, obj)
    staged = read_blobs(root, [obj for mode, obj in index.values() if mode != "160000"])
    for path, (mode, obj) in sorted(index.items()):
        if mode == "160000":
            continue
        file = Path(root) / path
        if file.is_symlink():
            data = os.readlink(file).encode("utf-8", "surrogateescape")
        elif file.is_file():
            data = file.read_bytes()
        else:
            data = None
        if data is not None:
            found += scan_bytes(rules, path, data)
        if data != staged[obj]:
            found += scan_bytes(rules, path, staged[obj])
    found += scan_names(rules, index, "(file names)")
    return found


def scan_staged(root, rules):
    """The staged changes: the new content of each added or changed file, and their names."""
    raw = git(root, "diff", "--cached", "--raw", "-z", "--no-renames", "--no-abbrev", "--diff-filter=ACMRT")
    parts = [part for part in raw.split(b"\0")]
    changes = []
    for at in range(0, len(parts) - 1, 2):
        meta = parts[at].decode()
        if not meta.startswith(":"):
            continue
        fields = meta[1:].split()
        changes.append((parts[at + 1].decode("utf-8", "surrogateescape"), fields[1], fields[3]))
    blobs = read_blobs(root, [obj for _, mode, obj in changes if mode != "160000"])
    found = []
    for path, mode, obj in changes:
        if mode != "160000":
            found += scan_bytes(rules, path, blobs[obj])
    found += scan_names(rules, [path for path, _, _ in changes], "(file names)")
    return found


def commit_ids(root, revisions=None, stdin=False):
    if stdin:
        ids = [line.strip() for line in sys.stdin.read().split() if line.strip()]
        return [git_text(root, "rev-parse", "--verify", f"{c}^{{commit}}") for c in ids]
    return [c for c in git_text(root, "rev-list", *revisions).split() if c]


# A finding class that the owner can accept for one commit. A secret or a policy finding
# is never accepted.
ACCEPTABLE = ("host", "public")
FULL_ID = re.compile(r"[0-9a-f]{40}")


def scan_history(root, rules, commits, accepted=(), public=False):
    """Each commit: its raw object (identities and message), the new content of each file
    that it adds or changes against its first parent, and the names of those files.

    `public` adds the public reader rules. A host-value or public reader finding of a
    commit whose full 40-character id is in `accepted` gets the class `accepted`.
    """
    accepted = set(accepted)
    for commit in accepted:
        if not FULL_ID.fullmatch(commit):
            raise Problem("an accepted commit must be a full 40-character id")
    found = []
    for commit in commits:
        short = commit[:12]
        raw = git(root, "cat-file", "commit", commit)
        parents = git_text(root, "rev-list", "--parents", "-n", "1", commit).split()[1:]
        base = [parents[0]] if parents else ["--root"]
        diff = git(root, "diff-tree", "-r", "-z", "--raw", "--no-renames", "--no-abbrev",
                   "--diff-filter=ACMRT", "--no-commit-id", *base, commit)
        parts = diff.split(b"\0")
        changes = []
        for at in range(0, len(parts) - 1):
            meta = parts[at].decode("utf-8", "surrogateescape")
            if meta.startswith(":") and len(meta[1:].split()) == 5:
                fields = meta[1:].split()
                changes.append((parts[at + 1].decode("utf-8", "surrogateescape"), fields[1], fields[3]))
        blobs = read_blobs(root, [obj for _, mode, obj in changes if mode != "160000"])
        here = [(kind, rule, f"(commit {short})", n) for kind, rule, _, n in
                scan_bytes(rules, f"(commit {short})", raw, public=public, policy=False)]
        for path, mode, obj in changes:
            if mode != "160000":
                here += [(kind, rule, f"{path} (commit {short})", n)
                         for kind, rule, _, n in scan_bytes(rules, path, blobs[obj], public=public)]
        here += [(kind, rule, f"(file names of commit {short})", n)
                 for kind, rule, _, n in scan_names(rules, [p for p, _, _ in changes], "-", public=public)]
        if commit in accepted:
            here = [("accepted" if kind in ACCEPTABLE else kind, rule, path, n) for kind, rule, path, n in here]
        found += here
    return found


def scan_ref_files(root, rules, ref, paths, public=False):
    """The files `paths` as they are in `ref`."""
    entries = tree_entries(root, ref)
    blobs = read_blobs(root, [entries[p][2] for p in paths if p in entries])
    found = []
    for path in paths:
        if path in entries:
            found += scan_bytes(rules, path, blobs[entries[path][2]], public=public)
    found += scan_names(rules, paths, "(file names)")
    return found


def selftest(rules):
    """Negative control: synthetic tokens, each host rule and a clean text.

    The tokens are built at run time, so no tracked file contains them.
    """
    problems = []
    token = "gh" + "p_" + "Zx9QwEr7TyUi3OpA" + "s5DfGh1JkLz2XcVbNm4Q"
    for line in (f'token = "{token}"', f"key: {'AKIA' + 'Q7XZ' + 'W3RT' + 'Y6UI' + 'P9LK'}"):
        if not any(kind == "secret" for kind, *_ in scan_bytes(rules, "selftest.txt", line.encode())):
            problems.append("a synthetic token gives no finding")
    for rule, sample in rules.samples:
        if rule not in {r for _, r, *_ in scan_bytes(rules, "selftest.txt", f"host = {sample}\n".encode())}:
            problems.append(f"{rule} does not find its sample")
    for rule, pattern in rules.deny:
        if rule not in {r for _, r, *_ in scan_bytes(rules, "selftest.txt", f"host = x{pattern}x\n".encode())}:
            problems.append(f"{rule} does not find its pattern")
    version = "10" + "." + "2.3.4"
    clean = (f"nothing here\npin = pkg=={version} pkg>={version} pkg-{version} v{version}\n"
             f"loopback = {'127' + '.0.0.1'} ::1\n")
    if scan_bytes(rules, "selftest.txt", clean.encode()):
        problems.append("a clean text gives a finding")
    for problem in problems:
        print(f"selftest: FAIL - {problem}", file=sys.stderr)
    if not problems:
        print("selftest: ok - the rules find the synthetic tokens and each host rule")
    return 1 if problems else 0


# --- report -----------------------------------------------------------------------------------

def failing(findings, level):
    return [f for f in findings if f[0] in ("secret", "policy", "public") or (f[0] == "host" and level == "fail")]


def report(findings, level, prefix="scan"):
    """Print each finding without file text; return the number of failing findings."""
    bad = failing(findings, level)
    warnings = [f for f in findings if f not in bad]
    for kind, rule, path, line in sorted(set(bad)):
        print(f"{prefix}: {kind} {rule}: {path}" + (f":{line}" if line else ""))
    shown = sorted(set(warnings))
    for kind, rule, path, line in shown[:WARN_LIMIT]:
        label = "accepted" if kind == "accepted" else f"warning {kind}"
        print(f"{prefix}: {label} {rule}: {path}" + (f":{line}" if line else ""))
    if len(shown) > WARN_LIMIT:
        print(f"{prefix}: {len(shown) - WARN_LIMIT} more warnings not shown")
    return len(set(bad))


def default_level(root):
    refs = os.environ.get("SCAN_REF")
    if refs is None:
        branch = git_text(root, "symbolic-ref", "-q", "--short", "HEAD", check=False)
        tags = git_text(root, "tag", "--points-at", "HEAD", check=False)
        refs = f"{branch} {tags}"
    for ref in refs.split():
        ref = ref.removeprefix("refs/heads/").removeprefix("refs/tags/")
        if ref == "portable" or ref.startswith("portable-v"):
            return "fail"
    return "warn"


def scan_main(argv):
    level, allow_no_local, rest = None, False, list(argv)
    while rest and rest[0].startswith("-"):
        option = rest.pop(0)
        if option == "--level" and rest:
            level = rest.pop(0)
        elif option.startswith("--level="):
            level = option.split("=", 1)[1]
        elif option == "--allow-no-local-deny":
            allow_no_local = True
        else:
            raise Problem("usage")
    if level not in (None, "warn", "fail") or not rest:
        raise Problem("usage")
    mode, args = rest[0], rest[1:]
    script_root = Path(__file__).resolve().parents[1]
    rules = Rules(script_root, allow_no_local)
    if mode == "selftest" and not args:
        return selftest(rules)
    root = top_level()
    level = level or default_level(root)
    if mode == "tree" and not args:
        found = scan_tree(root, rules)
    elif mode == "staged" and not args:
        found = scan_staged(root, rules)
    elif mode == "history" and len(args) <= 1:
        stdin = args == ["--stdin"]
        found = scan_history(root, rules, commit_ids(root, args or ["HEAD"], stdin=stdin))
    elif mode == "all" and not args:
        found = scan_tree(root, rules) + scan_history(root, rules, commit_ids(root, ["HEAD"]))
    else:
        raise Problem("usage")
    bad = report(found, level)
    local = "with" if rules.local else "without"
    if bad:
        print(f"scan: {mode}: {bad} findings at level {level}, {local} a local deny list", file=sys.stderr)
        return 1
    print(f"scan: {mode}: clean at level {level}, {local} a local deny list", file=sys.stderr)
    return 0


def check_main(argv):
    ref, allow_no_local, listing = "HEAD", False, False
    rest = list(argv)
    while rest:
        option = rest.pop(0)
        if option == "--ref" and rest:
            ref = rest.pop(0)
        elif option == "--allow-no-local-deny":
            allow_no_local = True
        elif option == "--list":
            listing = True
        else:
            raise Problem("usage")
    root = top_level()
    names, findings = publish_set(root, ref)
    if listing:
        print("\n".join(names))
        return 1 if findings else 0
    rules = Rules(root, allow_no_local)
    bad = report([("policy", rule, path, 0) for rule, path in findings], "fail", prefix="publish")
    bad += report(scan_ref_files(root, rules, ref, names, public=True), "fail", prefix="publish")
    if bad:
        print(f"publish check failed: {bad} findings in a publish set of {len(names)} files", file=sys.stderr)
        return 1
    print(f"publish check valid: {len(names)} files (not a release approval)")
    return 0


USAGE = ("usage: publish_check.py [--ref REF] [--list] [--allow-no-local-deny]\n"
         "       publish_check.py scan [--level warn|fail] [--allow-no-local-deny] "
         "tree|staged|history [<range>|--stdin]|all|selftest")


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    try:
        if argv[:1] == ["scan"]:
            return scan_main(argv[1:])
        return check_main(argv)
    except Problem as error:
        message = USAGE if str(error) == "usage" else f"error: {error}"
        print(message, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
