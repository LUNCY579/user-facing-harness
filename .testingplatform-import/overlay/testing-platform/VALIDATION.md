# Integration validation

Validation date: 2026-10-25. Environment: Linux, Node.js 24.22.1, pnpm 11.28.5. The exact source revisions are recorded in [source-import.json](source-import.json).

| Check | Result |
|---|---|
| Frozen dependency installation | Passed for 388 workspace projects. |
| Harness artifact build | All 8 stages passed; 358 client artifacts produced. |
| Host and client aggregate TypeScript checks | Both passed. The host check was rerun alone after a memory limit interrupted a concurrent run. |
| Local profile integration tests | 6 passed. |
| Actual combined Web startup | Passed: one host plugin, one browser plugin, served client JavaScript, normal browser authentication, authenticated plugin settings API, managed update/feed configuration, and orderly shutdown. |
| Plugin adapter type checking | Passed. |
| Plugin contributor regression suites | All 94 have passing evidence. The initial sweep passed 91; reload passed after host artifacts were built, forwarding passed after removing a public-DNS dependency from its fixture, and source-channel passed after adapting its test to the current public host API. Those three suites were rerun individually. |
| Subscription checks | 39 passed. |
| OAuth transport checks | 6 passed against local substitutes. |
| Generated standalone channel freshness | Passed. |
| Documentation for the integration and OAuth change | Bilingual pairing, upgrade-guide validation, and relevant links passed. |
| Relocated workflow references | All 76 links in the 28 affected Markdown files passed; 14 bilingual pairing records were updated and checked. |

The test run did not submit model completions or validate live provider accounts. Linux build and service startup are covered; native Windows/macOS execution and interactive visual browser testing are not covered by these checks.

## Preserved native asset

The original `plugins/dsh-our-free-model/vendor/magpie/bin/magpie-win32-x64.exe` is retained byte for byte. Its SHA-256 is `6490f7ed2c5f001adc97284276af453f2a2b1711712e175e6fc780e09046fa3b`.

## Reproduce the integration checks

After the [setup procedure](README.md#set-up-and-launch):

```sh
pnpm run test:integration
pnpm --dir plugins/dsh-our-free-model run typecheck
pnpm run test:plugin
pnpm run smoke:platform
```

The manual [TestingPlatform checks](../.github/workflows/testing-platform-ci.yml) workflow runs these checks after installation and setup. The initial source importer independently checks the complete composed Git tree, including every path, file mode, symlink, and binary asset, before publishing it.
