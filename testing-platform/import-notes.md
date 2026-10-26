# Source import reference

[source-import.json](source-import.json) identifies the two exact commits imported into TestingPlatform. The harness retains its directory layout at the repository root. The complete plugin lives under `plugins/dsh-our-free-model`, including its standalone app, desktop app, worker, assets, native engine, tests, and licenses. Source history remains available in the two original repositories; TestingPlatform starts with a combined snapshot and its own subsequent commits.

## Workflows

The 27 original harness workflows are preserved byte for byte in [upstream-workflows](upstream-workflows). They require upstream enterprise runners, release credentials, publishing settings, or repository policies, so they are kept as reference files. Upstream documentation references to `.github/workflows` refer to the corresponding files in this archive.

The active [TestingPlatform checks](../.github/workflows/testing-platform-ci.yml) workflow runs on manual request and uses a standard Ubuntu runner. It installs the pinned dependency graph, builds the harness, checks plugin types, runs offline plugin regressions, and checks the combined application. It does not call model providers. The [source import](../.github/workflows/import-sources.yml) workflow performs the initial import only. Once `source-import.json` exists with `completed: true`, rerunning the importer makes no changes.

## Import verification

The one-time importer checks out each pinned public source commit into a temporary directory, exports its tracked files with executable modes and symlinks preserved, relocates the original workflows, and applies reviewed integration files. It compares the entire resulting Git tree with the exact tree validated locally. This verifies the complete set of paths, file contents, and file modes, including large binaries and files tracked upstream despite ignore rules.

Only a clean bootstrap checkout containing the initial README, import tooling, active workflows, and temporary import payload is replaceable. Existing project files, a moved remote branch, a missing or altered overlay, a changed workflow, or an unexpected final tree stop the import. Publication uses an ordinary fast-forward push to `main`; it never force-pushes or rebases. Both original repositories remain unchanged.

### Bootstrap payload format

The temporary `.testingplatform-import/manifest.json` uses format version 1 with `target_repository`, `target_branch`, `expected_tree_sha`, `expected_file_count`, `overlays`, and `deletions`. Every overlay entry contains a repository-relative `path`, a Git `mode` (`100644`, `100755`, or `120000`), and the expected `blob_sha`. Its raw bytes are stored as a regular file at `.testingplatform-import/overlay/<path>`. For a symlink, those bytes are its link target. Deletions name source files after workflow relocation.

All final files absent from the pinned source snapshots must be overlay entries, including the two active workflows, importer, and completed-import marker. The active workflows must already be present in the bootstrap commit with identical bytes. Creating `.testingplatform-import/ready.json` in the same commit as the completed payload triggers the initial import. The payload is removed from the resulting working tree; the bootstrap commit retains the reviewed inputs.

A local rehearsal runs the same composition and exact-tree validation without changing the bootstrap checkout:

```sh
python3 testing-platform/import-sources.py \
  --worktree /path/to/clean-bootstrap-checkout \
  --local-harness /path/to/source-harness \
  --local-plugin /path/to/source-plugin \
  --verify-only
```
