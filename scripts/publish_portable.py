#!/usr/bin/env python3
"""Build the Walkr snapshot branch `portable` from the publish set, tag it, and push it.

A run without options is a dry run: it checks the source commit and prints the plan,
and it changes no ref. `--version X.Y.Z` builds the snapshot commit on `portable` and
the annotated tag `portable-vX.Y.Z` in this repository. `--push` (with `--version`)
then pushes exactly `refs/heads/portable:refs/heads/main` and `refs/tags/portable-vX.Y.Z`.

The snapshot takes the publish set of scripts/publish_check.py from the committed HEAD of
the development branch, never from the working tree. Its tree holds exactly the publish
set. Its parent is the previous `portable` commit (none for the first snapshot), so no
development history leaves. The commit and the tag carry a neutral identity and no
signature. See docs/publishing.md.
"""
import argparse
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

import publish_check  # noqa: E402
from publish_check import Problem, git_text  # noqa: E402

DEV_BRANCH = "local-dev"
SNAPSHOT_BRANCH = "portable"
SNAPSHOT_REF = f"refs/heads/{SNAPSHOT_BRANCH}"
REMOTE = "github"
REMOTE_BRANCH = "main"
TAG_PREFIX = "portable-v"
DEFAULT_NAME = "walkr portable"
DEFAULT_EMAIL = "portable@walkr.invalid"
NAME_VARIABLE = "WALKR_PUBLISH_NAME"
EMAIL_VARIABLE = "WALKR_PUBLISH_EMAIL"
# A signature would carry the key identity of the host.
NO_SIGNATURE = ("-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "tag.forceSignAnnotated=false")
# Options that push more refs than the two of a release, or that replace remote history.
REFUSED_OPTIONS = ("--all", "--tags", "--follow-tags", "--mirror", "--force", "-f", "--force-with-lease",
                   "--force-if-includes", "--delete", "--prune")
VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
ZERO = "0" * 40
# The user information of a URL in a text: a user name, a password or a token.
USERINFO = re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)[^/@\s]*@")
SIGNATURE = re.compile(r"-----BEGIN [A-Z ]*(?:SIGNATURE|SIGNED MESSAGE)-----")


class Refused(Exception):
    """A refusal of the publisher: exit 1, no ref changed."""


def redact(text):
    """`text` without the user information of each URL in it, for output of Git."""
    return USERINFO.sub(r"\1", text)


def git(root, *args, env=None, input=None, check=True):
    result = subprocess.run(["git", *args], cwd=root, env=env, input=input, text=True, capture_output=True)
    if check and result.returncode != 0:
        raise Problem(redact(f"git {' '.join(args)}: {result.stderr.strip()}"))
    return result.stdout.strip()


def say(line=""):
    print(line, flush=True)


# --- identity -------------------------------------------------------------------------

def resolve_identity(name=None, email=None, environ=None):
    """(name, e-mail) of the snapshot commit and the tag: option, then variable, then default."""
    environ = os.environ if environ is None else environ
    name = environ.get(NAME_VARIABLE, DEFAULT_NAME) if name is None else name
    email = environ.get(EMAIL_VARIABLE, DEFAULT_EMAIL) if email is None else email
    if not name.strip() or not email.strip():
        raise Refused(f"empty identity: set --identity-name/--identity-email or {NAME_VARIABLE}/{EMAIL_VARIABLE},"
                      " or unset them")
    if any(c in name + email for c in "<>\n"):
        raise Refused("the identity must not contain <, > or a line end")
    return name.strip(), email.strip()


def identity_env(identity):
    """The environment with `identity` as author and committer (the tagger is the committer).

    `TZ=UTC` keeps the time zone offset of the host out of the dates.
    """
    name, email = identity
    return dict(os.environ, GIT_AUTHOR_NAME=name, GIT_AUTHOR_EMAIL=email,
                GIT_COMMITTER_NAME=name, GIT_COMMITTER_EMAIL=email, TZ="UTC")


# --- versions and tags ---------------------------------------------------------------------

def parse_version(text):
    match = VERSION.fullmatch(text or "")
    if not match:
        raise Refused(f"--version must be X.Y.Z with digits only, not {text!r}")
    return tuple(int(part) for part in match.groups())


def release_tags(root):
    """{tag name: version tuple} of the local tags `portable-vX.Y.Z`."""
    tags = {}
    for name in git(root, "tag", "--list", f"{TAG_PREFIX}*").split():
        match = VERSION.fullmatch(name[len(TAG_PREFIX):])
        if match:
            tags[name] = tuple(int(part) for part in match.groups())
    return tags


def package_version(root, ref):
    text = publish_check.show(root, ref, "package.json")
    if text is None:
        raise Refused(f"package.json is not in {ref}")
    match = re.search(r'^\s*"version"\s*:\s*"([^"]*)"', text, re.MULTILINE)
    if not match:
        raise Refused("package.json has no version")
    return match.group(1)


# --- repository state ------------------------------------------------------------------------

def rev(root, name):
    return git(root, "rev-parse", "--verify", "--quiet", name, check=False) or None


def repository_refusals(root, allow_main_checkout=False):
    """The refusals that the state of the repository gives; an empty list is a pass."""
    found = []
    git_dir, common_dir = git(root, "rev-parse", "--path-format=absolute", "--git-dir",
                              "--git-common-dir").splitlines()
    if Path(git_dir).resolve() == Path(common_dir).resolve() and not allow_main_checkout:
        found.append("this is the main checkout; run the publisher in a linked worktree of the release")
    if "upstream" in git(root, "remote").split():
        found.append("a remote named upstream is configured")
    if git(root, "rev-parse", "--is-shallow-repository") == "true":
        found.append("the repository is shallow")
    hooks_path = git(root, "config", "--get", "core.hooksPath", check=False)
    if hooks_path:
        found.append(f"core.hooksPath is set ({hooks_path}); it turns off the hooks of scripts/install-hooks.sh")
    if git(root, "status", "--porcelain", "--untracked-files=all"):
        found.append("the working tree is not clean; the snapshot comes from the committed HEAD only")
    if git(root, "symbolic-ref", "-q", "HEAD", check=False) == SNAPSHOT_REF:
        found.append(f"HEAD is the branch {SNAPSHOT_BRANCH}")
    worktrees = git(root, "worktree", "list", "--porcelain").splitlines()
    if f"branch {SNAPSHOT_REF}" in worktrees:
        found.append(f"a worktree has the branch {SNAPSHOT_BRANCH} checked out")
    return found


def strip_userinfo(url):
    """The URL without user name and password, for the plan."""
    return redact(url)


def url_refusal(url):
    """A reason to refuse the push URL, or None.

    A user name or a password in an http(s) URL is a credential in the configuration.
    A user name of SSH (`git@host:path`, `ssh://git@host/path`) is no credential, but a
    password in an SSH URL is.
    """
    match = re.match(r"^([a-z][a-z0-9+.-]*)://([^/@]*)@", url)
    if match:
        scheme, userinfo = match.groups()
        if scheme.startswith("http") or scheme.startswith("ftp") or ":" in userinfo:
            return "the remote URL holds user information"
    return None


def remote_refusals(root, remote):
    """(refusals, push destination or None) of the remote. A missing remote gives none.

    The destination is the one push URL of the remote: `remote.<name>.pushurl` when it is
    set, else `remote.<name>.url`, after the URL rewrites of Git. The plan, `ls-remote`
    before and after, the dry run and the push all use this destination.
    """
    found = []
    if remote == "upstream":
        found.append("the remote is named upstream")
    if remote == "origin":
        found.append("the remote is origin; the snapshot goes to the shared remote only")
    if remote not in git(root, "remote").split():
        return found, None
    urls = git(root, "remote", "get-url", "--push", "--all", remote).splitlines()
    if len(urls) != 1:
        found.append(f"the remote has {len(urls)} push URLs; the publisher needs exactly one")
    for url in urls:
        if url.strip() == "DISABLED":
            found.append("the push URL is DISABLED")
        reason = url_refusal(url)
        if reason:
            found.append(reason)
    if git(root, "config", "--bool", "--get", f"remote.{remote}.mirror", check=False) == "true":
        found.append(f"remote.{remote}.mirror is set")
    if not urls:
        return found, None
    # A push to the URL itself must reach the same place: no rewrite rule may match it.
    if len(urls) == 1:
        found += [f"the setting {redact(key)} rewrites the push URL; remove it or set the final URL"
                  for key in rewrite_rules(root, urls[0])]
    return found, urls[0]


def rewrite_rules(root, url):
    """The keys `url.<base>.insteadOf` and `url.<base>.pushInsteadOf` whose value starts `url`.

    Git applies these rules to a URL on the command line too, and a push applies the
    pushInsteadOf rules after the insteadOf rules. When no rule matches the resolved push URL,
    `ls-remote` and `push` both use that URL as it is.
    """
    text = git(root, "config", "-z", "--get-regexp", r"^url\..*\.(push)?insteadof$", check=False)
    found = []
    for entry in text.split("\0"):
        key, _, value = entry.partition("\n")
        if key and url.startswith(value):
            found.append(key)
    return found


# --- the snapshot ----------------------------------------------------------------------------

def snapshot_tree(root, source, paths):
    """Write the tree of exactly `paths` as they are in `source`, with a temporary index."""
    entries = publish_check.tree_entries(root, source)
    with tempfile.TemporaryDirectory(prefix="walkr-portable-") as temp:
        env = dict(os.environ, GIT_INDEX_FILE=str(Path(temp) / "index"))
        git(root, "read-tree", "--empty", env=env)
        lines = []
        for path in paths:
            mode, kind, obj = entries[path]
            if kind != "blob" or mode not in ("100644", "100755"):
                raise Refused(f"not a regular file in {source}: {path}")
            lines.append(f"{mode} {obj}\t{path}")
        git(root, "update-index", "--index-info", env=env, input="\n".join(lines) + "\n")
        return git(root, "write-tree", env=env)


def tree_paths(root, tree):
    return sorted(publish_check.tree_entries(root, tree))


def message_for(version, source):
    return (f"Walkr portable {version}\n\n"
            f"The reviewed publish set of the source commit {source}.\n")


def build(root, source, tree, version, identity, parent):
    """Write the snapshot commit and the tag object; return (commit, tag object). No ref moves."""
    env = identity_env(identity)
    tag = f"{TAG_PREFIX}{version}"
    if parent and git(root, "rev-parse", f"{parent}^{{tree}}") == tree:
        commit = parent
    else:
        commit = git(root, *NO_SIGNATURE, "commit-tree", tree, *(["-p", parent] if parent else []),
                     "-m", message_for(version, source), env=env)
    tagger = git(root, "var", "GIT_COMMITTER_IDENT", env=env)
    tag_object = git(root, "mktag", input=f"object {commit}\ntype commit\ntag {tag}\ntagger {tagger}\n\n"
                                          f"Walkr portable {version}\n")
    return commit, tag_object


def update_refs(root, commit, parent, tag, tag_object):
    """Move `portable` and create the tag in one transaction, guarded by the old value."""
    branch = (f"update {SNAPSHOT_REF} {commit} {parent}\n" if parent else f"create {SNAPSHOT_REF} {commit}\n")
    git(root, "update-ref", "--stdin",
        input=f"start\n{branch}create refs/tags/{tag} {tag_object}\nprepare\ncommit\n")


# --- the existing chain and the existing tag ------------------------------------------------------

def person(raw, field):
    """`name <e-mail>` of the header `field` (author, committer, tagger) of a raw object."""
    head = raw.split(b"\n\n", 1)[0].decode("utf-8", "replace")
    match = re.search(rf"^{field} (.*) [0-9]+ [+-][0-9]{{4}}$", head, re.MULTILINE)
    return match.group(1) if match else None


def is_signed(raw):
    head, _, body = raw.partition(b"\n\n")
    return (re.search(rb"^gpgsig(?:-sha256)? ", head, re.MULTILINE) is not None
            or SIGNATURE.search(body.decode("utf-8", "replace")) is not None)


def never_leaves(name):
    """True when `name` is on the fixed list of paths that no snapshot may hold.

    This list does not follow the publish rules of today, so a file that left the publish set
    later does not invalidate an older snapshot: `.local/`, `secrets/`, an `.env` file (not
    an `.env.example`, `.env.sample` or `.env.template`), and scripts/dev-only-files.txt.
    """
    parts = name.split("/")
    base = parts[-1]
    return (name == publish_check.DEV_ONLY_REL or any(part in (".local", "secrets") for part in parts[:-1])
            or base == ".env"
            or (base.startswith(".env.") and not base.endswith((".example", ".sample", ".template"))))


def chain_refusals(root, tip, identity, source):
    """(refusals, identities) of the existing chain of `portable` that ends at `tip`.

    Each commit must be a snapshot: one parent or none, no signature, the identity of this
    run as author and committer, and no path of the fixed never-leave list. No commit of the
    chain may be reachable from `local-dev` or from the source commit. The publish rules of
    today apply to the new snapshot only; the history scan covers the content of the chain.
    """
    found = []
    lines = [line.split() for line in git(root, "rev-list", "--parents", tip).splitlines()]
    commits = [line[0] for line in lines]
    if any(len(line) > 2 for line in lines):
        found.append(f"{SNAPSHOT_BRANCH} holds a merge commit; a snapshot has one parent or none")
    development = [f"refs/heads/{DEV_BRANCH}"] if rev(root, f"refs/heads/{DEV_BRANCH}") else []
    own = git(root, "rev-list", "--count", tip, "--not", source, *development)
    if int(own) != len(commits):
        found.append(f"{SNAPSHOT_BRANCH} shares commits with {DEV_BRANCH} or the source commit")
    wanted = f"{identity[0]} <{identity[1]}>"
    identities = set()
    for commit, raw in publish_check.read_blobs(root, commits).items():
        people = {person(raw, "author"), person(raw, "committer")}
        identities |= people
        if people != {wanted}:
            found.append(f"the snapshot {commit} has another author or committer than {wanted}")
        if is_signed(raw):
            found.append(f"the snapshot {commit} has a signature")
        names = git(root, "ls-tree", "-r", "-z", "--name-only", "--full-tree", commit).split("\0")
        if any(name and never_leaves(name) for name in names):
            found.append(f"the snapshot {commit} holds a path that never leaves the development copy")
    return found, sorted(str(item) for item in identities)


def tag_refusals(root, tag, version, tip, identity):
    """(refusals, tagger) of an existing tag of a resume.

    The tag must be annotated, point at `tip`, name `version`, carry the identity of this run
    as tagger and the message of the publisher, and have no signature. The publisher scans its
    message before the push.
    """
    if git(root, "cat-file", "-t", f"refs/tags/{tag}") != "tag":
        return [f"the tag {tag} is not an annotated tag"], None
    raw = publish_check.git(root, "cat-file", "tag", f"refs/tags/{tag}")
    head, _, body = raw.decode("utf-8", "replace").partition("\n\n")
    fields = dict(line.split(" ", 1) for line in head.splitlines() if " " in line)
    tagger = person(raw, "tagger")
    found = []
    if fields.get("object") != tip or fields.get("type") != "commit":
        found.append(f"the tag {tag} does not point at the tip of {SNAPSHOT_BRANCH}")
    if fields.get("tag") != tag or body.split("\n", 1)[0] != f"Walkr portable {version}":
        found.append(f"the tag {tag} does not name the version {version}")
    if tagger != f"{identity[0]} <{identity[1]}>":
        found.append(f"the tag {tag} has another tagger")
    if is_signed(raw):
        found.append(f"the tag {tag} has a signature")
    return found, tagger


# --- checks ------------------------------------------------------------------------------------

def allow_lines_drift(root, source, previous):
    """The files of scripts/host-values.allow-lines that changed since the previous snapshot."""
    rules_text = publish_check.show(root, source, publish_check.ALLOW_LINES_REL) or ""
    names = sorted({line.partition("\t")[0] for line in publish_check.list_entries(rules_text)})
    if not names:
        return []
    if previous is None:
        return [(name, "first snapshot") for name in names]
    old = publish_check.tree_entries(root, previous)
    new = publish_check.tree_entries(root, source)
    return [(name, "changed") for name in names if old.get(name, (None, None, None))[2] != new.get(name, (None,) * 3)[2]]


def run_checks(root, source, rules, paths, findings):
    """Print each finding of the publish set; return the count of failing findings."""
    bad = publish_check.report([("policy", rule, path, 0) for rule, path in findings], "fail", prefix="publish")
    bad += publish_check.report(publish_check.scan_ref_files(root, rules, source, paths, public=True), "fail",
                                prefix="publish")
    return bad


def ls_remote(root, destination):
    """{ref: object} of the push destination. Uses the credential helper of Git; reads no credential."""
    refs = {}
    for line in git(root, "ls-remote", destination).splitlines():
        obj, _, ref = line.partition("\t")
        refs[ref] = obj
    return refs


def foreign_refs(refs):
    allowed = re.compile(rf"refs/heads/{re.escape(REMOTE_BRANCH)}|refs/tags/{re.escape(TAG_PREFIX)}"
                         r"[0-9]+\.[0-9]+\.[0-9]+(\^\{\})?|HEAD")
    return sorted(ref for ref in refs if not allowed.fullmatch(ref))


def push_command(destination, tag, dry_run=False):
    """The push: exactly the snapshot branch and one tag, by explicit refspec, to one URL."""
    return ["push", "--porcelain", "--no-follow-tags", *(["--dry-run"] if dry_run else []), destination,
            f"{SNAPSHOT_REF}:refs/heads/{REMOTE_BRANCH}", f"refs/tags/{tag}"]


# --- main ----------------------------------------------------------------------------------------

def parse(argv):
    refused = [arg for arg in argv if arg.split("=", 1)[0] in REFUSED_OPTIONS]
    if refused:
        raise Refused(f"refused option {refused[0]}: the push names its two refs explicitly and never forces")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--version", help="X.Y.Z: build the snapshot and the tag portable-vX.Y.Z")
    parser.add_argument("--push", action="store_true", help="push the snapshot and the tag (needs --version)")
    parser.add_argument("--remote", default=REMOTE, help=f"the shared remote (default {REMOTE})")
    parser.add_argument("--identity-name", help=f"name of the commit and the tag (default {NAME_VARIABLE} "
                                                f"or '{DEFAULT_NAME}')")
    parser.add_argument("--identity-email", help=f"e-mail of the commit and the tag (default {EMAIL_VARIABLE} "
                                                 f"or '{DEFAULT_EMAIL}')")
    parser.add_argument("--accept-commit", action="append", default=[], metavar="SHA",
                        help="the full id of a snapshot commit whose host-value or public reader finding "
                             "the owner accepted in writing; a secret finding stays")
    parser.add_argument("--allow-no-local-deny", action="store_true",
                        help="run without .local/host-values.deny (not for a release of the private copy)")
    parser.add_argument("--allow-main-checkout", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.push and not args.version:
        raise Refused("--push needs --version: each push is a tagged release")
    for commit in args.accept_commit:
        if not publish_check.FULL_ID.fullmatch(commit):
            raise Refused(f"--accept-commit needs a full 40-character commit id, not {commit!r}")
    return args


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    try:
        return publish(parse(argv))
    except Refused as error:
        print(f"refused: {error}", file=sys.stderr)
        return 1
    except Problem as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


def publish(args):
    root = publish_check.top_level()
    identity = resolve_identity(args.identity_name, args.identity_email)
    mode = "push" if args.push else ("build" if args.version else "dry run")
    say(f"mode: {mode}")
    say(f"identity: author {identity[0]} <{identity[1]}>")
    say(f"identity: committer {identity[0]} <{identity[1]}>")
    say(f"identity: tagger {identity[0]} <{identity[1]}>")
    say("signature: none (commit.gpgsign=false, tag.gpgsign=false)")

    refusals = repository_refusals(root, args.allow_main_checkout)
    branch = git(root, "symbolic-ref", "-q", "--short", "HEAD", check=False) or "(detached)"
    source = git(root, "rev-parse", "HEAD")
    say(f"source: {branch} at {source}")
    # A linked worktree cannot check out local-dev while the main checkout has it, so a
    # detached HEAD at the tip of local-dev counts as local-dev.
    if branch != DEV_BRANCH and not (branch == "(detached)" and source == rev(root, f"refs/heads/{DEV_BRANCH}")):
        line = f"the source is {branch}, not {DEV_BRANCH} or a detached HEAD at its tip"
        if args.version:
            refusals.append(line)
        else:
            say(f"note: {line}; a build needs {DEV_BRANCH}")
    previous = rev(root, f"{SNAPSHOT_REF}^{{commit}}")
    say(f"portable: {previous or 'none (first snapshot)'}")
    if previous:
        found, people = chain_refusals(root, previous, identity, source)
        refusals += found
        say(f"portable chain: identities {', '.join(people)}")

    tag = None
    resume = False
    if args.version:
        version = parse_version(args.version)
        tag = f"{TAG_PREFIX}{args.version}"
        found = package_version(root, source)
        if found != args.version:
            refusals.append(f"package.json version is {found}, not {args.version}")
        tags = release_tags(root)
        existing = rev(root, f"refs/tags/{tag}")
        if existing:
            peeled = rev(root, f"refs/tags/{tag}^{{commit}}")
            # A tag of an earlier build of exactly this snapshot is a resume, not a new tag.
            resume = bool(args.push and previous and peeled == previous)
            if not resume:
                refusals.append(f"the tag {tag} exists")
            else:
                found, tagger = tag_refusals(root, tag, args.version, previous, identity)
                refusals += found
                say(f"tag object: tagger {tagger or '(none)'}")
        newer = [name for name, other in tags.items() if name != tag and other >= version]
        if newer:
            refusals.append(f"the version {args.version} does not increase over {max(newer, key=tags.get)}")
        say(f"tag: {tag}" + (" (exists; resume of an earlier build)" if resume else ""))

    remote_issues, destination = remote_refusals(root, args.remote)
    if destination is None:
        say(f"remote: {args.remote} (not configured)")
        if args.push:
            refusals.append(f"the remote {args.remote} is not configured")
    else:
        say(f"remote: {args.remote}, push destination {strip_userinfo(destination)}")
    if args.push or destination is not None:
        refusals += remote_issues

    paths, set_findings = publish_check.publish_set(root, source)
    say(f"publish set: {len(paths)} files")
    try:
        rules = publish_check.Rules(root, args.allow_no_local_deny)
    except Problem as error:
        raise Refused(str(error)) from None
    say(f"local deny list: {'present' if rules.local else 'absent (--allow-no-local-deny)'}")
    bad = run_checks(root, source, rules, paths, set_findings)
    for name, why in allow_lines_drift(root, source, previous):
        say(f"warning: allow-lines file {name}: {why} since the last snapshot; review its accepted lines")

    tree = snapshot_tree(root, source, paths) if not set_findings else None
    if tree is not None:
        actual = tree_paths(root, tree)
        if actual != paths:
            bad += 1
            say("publish: policy snapshot-mismatch: the snapshot tree is not the publish set")
        same = bool(previous) and git(root, "rev-parse", f"{previous}^{{tree}}") == tree
        say(f"snapshot tree: {tree}" + (" (same as portable)" if same else ""))
        if resume and not same:
            refusals.append(f"the tag {tag} exists, and the publish set changed since its build")
    if stop(bad, refusals):
        return 1

    say(f"push plan: {args.remote} {SNAPSHOT_REF}:refs/heads/{REMOTE_BRANCH}"
        + (f" refs/tags/{tag}" if tag else " refs/tags/portable-vX.Y.Z (needs --version)"))
    if not args.version:
        say("dry run: no ref changed, no push")
        return 0

    # The remote preflight comes before the build, so that its refusals change no ref.
    old_main = None
    if args.push:
        before = ls_remote(root, destination)
        old_main = before.get(f"refs/heads/{REMOTE_BRANCH}")
        if before.get(f"refs/tags/{tag}"):
            refusals.append(f"the push destination has the tag {tag}")
        refusals += [f"foreign ref on the push destination: {ref}" for ref in foreign_refs(before)]
        if stop(0, refusals):
            return 1

    if resume:
        commit, tag_object = previous, rev(root, f"refs/tags/{tag}")
    else:
        commit, tag_object = build(root, source, tree, args.version, identity, previous)
    tag_raw = publish_check.git(root, "cat-file", "tag", tag_object)
    say(f"tag object: tagger {person(tag_raw, 'tagger')}")
    # The outgoing commits. A first push sends the whole snapshot chain.
    if not args.push:
        commits = [commit] if commit != previous else []
    elif old_main and rev(root, f"{old_main}^{{commit}}"):
        commits = git(root, "rev-list", commit, f"^{old_main}").split()
    else:
        commits = git(root, "rev-list", commit).split()
        say(f"first push to {args.remote}: the history scan covers the whole snapshot chain")
    history = publish_check.scan_history(root, rules, commits, accepted=args.accept_commit, public=True)
    history += publish_check.scan_bytes(rules, f"(tag {tag})", tag_raw, public=True, policy=False)
    if publish_check.report(history, "fail", prefix="history"):
        print("stopped: a finding in the outgoing snapshots or the tag; no ref changed", file=sys.stderr)
        return 1
    if not resume:
        update_refs(root, commit, previous, tag, tag_object)
        say(f"built: portable {commit} (parent {previous or 'none'}), tag {tag}")
    if not args.push:
        say("no push: give --push to push the two refs")
        return 0
    return push(root, args, destination, commit, old_main, tag)


def stop(bad, refusals):
    """Print the refusals; True when the run must stop."""
    for line in refusals:
        print(f"refused: {line}", file=sys.stderr)
    if bad or refusals:
        print(f"stopped: {bad} findings, {len(refusals)} refusals; no ref changed", file=sys.stderr)
        return True
    return False


def push(root, args, destination, commit, old_main, tag):
    """The dry run, the push and the list of the remote, all to the one push destination.

    A failure here leaves the local `portable` and the tag; a rerun with --push resumes.
    """
    shown = strip_userinfo(destination)
    say(f"push plan: remote {args.remote}, destination {shown}")
    say(f"  refs/heads/{REMOTE_BRANCH}: {old_main or ZERO} -> {commit}")
    say(f"  refs/tags/{tag}: {ZERO} -> {rev(root, f'refs/tags/{tag}')}")
    dry = subprocess.run(["git", *push_command(destination, tag, dry_run=True)], cwd=root, text=True,
                         capture_output=True)
    say(redact(dry.stdout.strip()))
    if dry.returncode:
        print(f"stopped: git push --dry-run failed: {redact(dry.stderr.strip())}", file=sys.stderr)
        return 1
    result = subprocess.run(["git", *push_command(destination, tag)], cwd=root, text=True, capture_output=True)
    say(redact(result.stdout.strip()))
    if result.stderr.strip():
        print(redact(result.stderr.strip()), file=sys.stderr)
    after = ls_remote(root, destination)
    say(f"ls-remote {shown}:")
    for ref, obj in sorted(after.items()):
        say(f"  {obj} {ref}")
    if result.returncode:
        print("push failed", file=sys.stderr)
        return 1
    foreign = foreign_refs(after)
    if foreign:
        for ref in foreign:
            print(f"incident: foreign ref on {shown}: {ref} (nothing deleted)", file=sys.stderr)
        return 3
    say(f"pushed: {shown} refs/heads/{REMOTE_BRANCH} and refs/tags/{tag}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
