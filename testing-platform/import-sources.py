#!/usr/bin/env python3
"""Import two pinned source snapshots and a reviewed overlay into an empty repo.

The final Git tree must equal the tree validated locally. Only the temporary
bootstrap layout is replaceable; an existing completed import is never replaced.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile


TARGET_REPOSITORY = "LUNCY579/TestingPlatform"
TARGET_BRANCH = "main"
SOURCES = (
    ("harness", "LUNCY579/deepseek-harness", "22ddee3792402c3e70ec5f86a63c3e3e895a2f60", ""),
    ("plugin", "LUNCY579/dsh-our-free-model", "e164fea59e0293ab6284fd62d25d3ab8a4f459ce", "plugins/dsh-our-free-model/"),
)
PAYLOAD = ".testingplatform-import"
MARKER = "testing-platform/source-import.json"
BOOTSTRAP_FILES = {
    "README.md",
    "testing-platform/import-sources.py",
    ".github/workflows/import-sources.yml",
    ".github/workflows/testing-platform-ci.yml",
}
MODES = {"100644", "100755", "120000"}


def run(args: list[str], *, cwd: Path | None = None) -> str:
    """Run a command without a shell and return its UTF-8 stdout."""
    result = subprocess.run(args, cwd=cwd, check=True, stdout=subprocess.PIPE)
    return result.stdout.decode("utf-8").strip()


def git(root: Path, *args: str) -> str:
    return run(["git", "-C", str(root), *args])


def safe_path(value: object) -> str:
    """Accept a relative Git path without traversal or Git-internal components."""
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        raise ValueError("Manifest contains an invalid path")
    path = PurePosixPath(value)
    if path.is_absolute() or str(path) != value or any(part in {".", "..", ".git"} for part in path.parts):
        raise ValueError(f"Unsafe manifest path: {value!r}")
    return value


def blob_sha(data: bytes) -> str:
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def source_inventory(root: Path, commit: str) -> dict[str, tuple[str, str]]:
    output = subprocess.check_output(["git", "-C", str(root), "ls-tree", "-rz", "--full-tree", commit])
    inventory: dict[str, tuple[str, str]] = {}
    for record in output.split(b"\0"):
        if not record:
            continue
        metadata, name = record.split(b"\t", 1)
        mode, kind, sha = metadata.decode().split()
        if kind != "blob" or mode not in MODES:
            raise ValueError("Source contains an unsupported Git entry")
        inventory[safe_path(name.decode("utf-8"))] = (mode, sha)
    return inventory


def disk_inventory(root: Path, *, exclude_git: bool = False) -> set[str]:
    """List files and symlinks without following symlink directories."""
    result: set[str] = set()
    for parent, directories, files in os.walk(root, followlinks=False):
        current = Path(parent)
        if exclude_git and current == root and ".git" in directories:
            directories.remove(".git")
        for name in list(directories):
            path = current / name
            if path.is_symlink():
                result.add(path.relative_to(root).as_posix())
                directories.remove(name)
        for name in files:
            path = current / name
            if exclude_git and current == root and name == ".git":
                continue
            result.add(path.relative_to(root).as_posix())
    return result


def verify_bootstrap(root: Path) -> str:
    """Reject an edited checkout or a repository that already contains user work."""
    head = git(root, "rev-parse", "HEAD")
    if git(root, "status", "--porcelain=v1", "--untracked-files=all"):
        raise ValueError("Bootstrap checkout is not clean")
    tracked = set(source_inventory(root, head))
    if tracked != disk_inventory(root, exclude_git=True):
        raise ValueError("Bootstrap checkout has untracked or ignored files")
    unexpected = sorted(path for path in tracked if path not in BOOTSTRAP_FILES and not path.startswith(PAYLOAD + "/"))
    if unexpected:
        raise ValueError(f"Refusing to overwrite non-bootstrap files: {unexpected[:5]}")
    return head


def load_manifest(root: Path) -> dict:
    manifest = json.loads((root / PAYLOAD / "manifest.json").read_text())
    if manifest.get("format_version") != 1 or manifest.get("target_repository") != TARGET_REPOSITORY or manifest.get("target_branch") != TARGET_BRANCH:
        raise ValueError("Import manifest targets a different format or repository")
    if not re.fullmatch(r"[0-9a-f]{40}", manifest.get("expected_tree_sha", "")):
        raise ValueError("Manifest requires the locally validated Git tree SHA")
    if not isinstance(manifest.get("expected_file_count"), int) or manifest["expected_file_count"] < 1:
        raise ValueError("Manifest requires the expected file count")
    if not isinstance(manifest.get("overlays"), list) or not isinstance(manifest.get("deletions", []), list):
        raise ValueError("Manifest overlays and deletions must be lists")
    seen: set[str] = set()
    for entry in manifest["overlays"]:
        path = safe_path(entry["path"])
        if path in seen or path == PAYLOAD or path.startswith(PAYLOAD + "/"):
            raise ValueError("Manifest has duplicate or recursive overlay paths")
        seen.add(path)
        if entry.get("mode") not in MODES or not re.fullmatch(r"[0-9a-f]{40}", entry.get("blob_sha", "")):
            raise ValueError(f"Invalid mode or blob hash for {path}")
    for path in manifest.get("deletions", []):
        safe_path(path)
    return manifest


def obtain_source(work: Path, key: str, repository: str, commit: str, local: str | None) -> Path:
    if local:
        checkout = Path(local).resolve()
    else:
        checkout = work / (key + "-git")
        run(["git", "init", "--quiet", str(checkout)])
        git(checkout, "fetch", "--quiet", "--no-tags", "--depth=1", "https://github.com/" + repository + ".git", commit)
    resolved = git(checkout, "rev-parse", commit + "^{commit}")
    if resolved != commit:
        raise ValueError(f"Unexpected {key} source commit")
    return checkout


def archive_source(checkout: Path, commit: str, destination: Path) -> None:
    """Extract a commit, retaining regular executable files and safe symlinks."""
    destination.mkdir(parents=True, exist_ok=True)
    process = subprocess.Popen(["git", "-C", str(checkout), "archive", "--format=tar", commit], stdout=subprocess.PIPE)
    assert process.stdout is not None
    try:
        with tarfile.open(fileobj=process.stdout, mode="r|") as archive:
            for member in archive:
                safe_path(member.name.rstrip("/"))
                archive.extract(member, path=destination, filter="data")
    finally:
        process.stdout.close()
    if process.wait() != 0:
        raise RuntimeError("Source archive failed")


def destination_path(root: Path, relative: str) -> Path:
    path = root / safe_path(relative)
    if not path.parent.resolve().is_relative_to(root.resolve()):
        raise ValueError(f"Overlay traverses a symlink outside the worktree: {relative}")
    return path


def compose(root: Path, work: Path, manifest: dict, local_harness: str | None, local_plugin: str | None) -> tuple[Path, dict[str, tuple[str, str]]]:
    combined = work / "combined"
    combined.mkdir()
    expected: dict[str, tuple[str, str]] = {}
    local_sources = {"harness": local_harness, "plugin": local_plugin}
    for key, repository, commit, prefix in SOURCES:
        checkout = obtain_source(work, key, repository, commit, local_sources[key])
        original = source_inventory(checkout, commit)
        archive_source(checkout, commit, combined / prefix)
        for path, entry in original.items():
            if key == "harness" and path.startswith(".github/workflows/"):
                path = "testing-platform/upstream-workflows/" + path.removeprefix(".github/workflows/")
            final_path = prefix + path
            if final_path in expected:
                raise ValueError(f"Source path collision: {final_path}")
            expected[final_path] = entry
        print(f"Imported {len(original)} files from {repository}@{commit}", flush=True)
    old_workflows = combined / ".github/workflows"
    archived_workflows = combined / "testing-platform/upstream-workflows"
    if archived_workflows.exists():
        raise ValueError("Source unexpectedly already has the archive destination")
    archived_workflows.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(old_workflows), archived_workflows)
    for relative in manifest.get("deletions", []):
        if relative not in expected:
            raise ValueError(f"Deletion does not refer to a source file: {relative}")
        destination_path(combined, relative).unlink()
        del expected[relative]
    for entry in manifest["overlays"]:
        relative = entry["path"]
        payload_file = root / PAYLOAD / "overlay" / relative
        if not payload_file.is_file() or payload_file.is_symlink():
            raise ValueError(f"Missing regular overlay payload: {relative}")
        data = payload_file.read_bytes()
        if blob_sha(data) != entry["blob_sha"]:
            raise ValueError(f"Overlay checksum mismatch: {relative}")
        path = destination_path(combined, relative)
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.is_symlink() or path.exists():
            path.unlink()
        if entry["mode"] == "120000":
            target = data.decode("utf-8")
            if not (path.parent / target).resolve().is_relative_to(combined.resolve()):
                raise ValueError(f"Overlay symlink escapes repository: {relative}")
            path.symlink_to(target)
        else:
            path.write_bytes(data)
            path.chmod(0o755 if entry["mode"] == "100755" else 0o644)
        expected[relative] = (entry["mode"], entry["blob_sha"])
    if disk_inventory(combined) != set(expected) or len(expected) != manifest["expected_file_count"]:
        raise ValueError("Composed file inventory differs from the reviewed manifest")
    marker = json.loads((combined / MARKER).read_text())
    if marker.get("completed") is not True or [(row["repository"], row["commit"]) for row in marker.get("sources", [])] != [(row[1], row[2]) for row in SOURCES]:
        raise ValueError("Completed-import marker does not identify both pinned sources")
    # GITHUB_TOKEN does not need workflow-write permission when these bytes are
    # already present in the reviewed bootstrap commit and remain unchanged.
    active = {path for path in expected if path.startswith(".github/workflows/")}
    preuploaded = {path for path in disk_inventory(root) if path.startswith(".github/workflows/")}
    if active != preuploaded or any((combined / path).read_bytes() != (root / path).read_bytes() for path in active):
        raise ValueError("Active workflows must exactly match their preuploaded versions")
    return combined, expected


def stage_tree(repo: Path, worktree: Path, paths_file: Path, *, remove_old: bool = False) -> str:
    if remove_old:
        git(repo, "add", "-u")
    run(["git", "-C", str(repo), "--work-tree=" + str(worktree), "add", "--force", "--pathspec-from-file=" + str(paths_file), "--pathspec-file-nul"])
    return git(repo, "write-tree")


def assert_remote_head(root: Path, expected_head: str) -> None:
    remote = git(root, "ls-remote", "--exit-code", "origin", "refs/heads/" + TARGET_BRANCH).split()
    if not remote or remote[0] != expected_head:
        raise ValueError("Destination main changed; refusing to overwrite or rebase it")


def publish(root: Path, combined: Path, paths_file: Path, manifest: dict, expected_head: str) -> str:
    assert_remote_head(root, expected_head)
    for child in root.iterdir():
        if child.name == ".git":
            continue
        if child.is_symlink() or child.is_file():
            child.unlink()
        else:
            shutil.rmtree(child)
    shutil.copytree(combined, root, symlinks=True, dirs_exist_ok=True)
    tree = stage_tree(root, root, paths_file, remove_old=True)
    if tree != manifest["expected_tree_sha"]:
        raise ValueError("Destination staging tree differs from the validated combined tree")
    assert_remote_head(root, expected_head)
    git(root, "-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com", "commit", "--quiet", "-m", "Import DeepSeek Harness and Our Free Model into TestingPlatform")
    # The ordinary push rejects any concurrent update; no force or rebase is used.
    git(root, "push", "origin", "HEAD:refs/heads/" + TARGET_BRANCH)
    commit = git(root, "rev-parse", "HEAD")
    assert_remote_head(root, commit)
    return commit


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worktree", default=".")
    parser.add_argument("--expected-head")
    parser.add_argument("--local-harness")
    parser.add_argument("--local-plugin")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--verify-only", action="store_true")
    mode.add_argument("--publish", action="store_true")
    args = parser.parse_args()
    root = Path(args.worktree).resolve()
    if (root / MARKER).exists():
        marker = json.loads((root / MARKER).read_text())
        if marker.get("completed") is True:
            print("TestingPlatform has already been imported; no files changed.")
            return 0
        raise ValueError("Import marker exists without a completed import")
    head = verify_bootstrap(root)
    if args.expected_head and head != args.expected_head:
        raise ValueError("Checkout does not match the requested bootstrap commit")
    if args.publish:
        if not args.expected_head:
            raise ValueError("Publishing requires an explicit bootstrap commit")
        remote_url = git(root, "remote", "get-url", "origin")
        if remote_url not in {"https://github.com/" + TARGET_REPOSITORY + ".git", "https://github.com/" + TARGET_REPOSITORY}:
            raise ValueError("Origin is not the authorized TestingPlatform repository")
        if os.environ.get("GITHUB_REPOSITORY", TARGET_REPOSITORY) != TARGET_REPOSITORY:
            raise ValueError("Workflow is running in a different repository")
    manifest = load_manifest(root)
    with tempfile.TemporaryDirectory(prefix="testing-platform-import-") as temporary:
        work = Path(temporary)
        combined, expected = compose(root, work, manifest, args.local_harness, args.local_plugin)
        paths_file = work / "final-paths.nul"
        paths_file.write_bytes(b"".join(path.encode("utf-8") + b"\0" for path in sorted(expected)))
        verification_repo = work / "tree-check"
        run(["git", "init", "--quiet", str(verification_repo)])
        tree = stage_tree(verification_repo, combined, paths_file)
        if tree != manifest["expected_tree_sha"]:
            raise ValueError(f"Composed tree {tree} differs from reviewed tree {manifest['expected_tree_sha']}")
        print(f"Verified {len(expected)} files and exact Git tree {tree}", flush=True)
        if args.publish:
            commit = publish(root, combined, paths_file, manifest, head)
            print(f"Published {TARGET_REPOSITORY}@{commit}", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"Import stopped: {error}", file=sys.stderr)
        raise SystemExit(1)
