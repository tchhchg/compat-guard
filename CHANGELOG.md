# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-08

### Added

- **Independent outcome fields** (`report.outcomes`) — nine axes reported separately instead of
  collapsing into one pass/fail:

  | field | values | means |
  | --- | --- | --- |
  | `versionConstraints` | `pass` / `blocked` / `unknown` | target release rejects a plugin's `engines.dsh` or host `peerDependencies` |
  | `buildScriptApproval` | `not-required` / `declared` | the plugin's manifest declares `preinstall`/`install`/`postinstall`/`prepare`; the host's approval state is not readable from here, so this reports the *declaration* only |
  | `nonLayerPackages` | `none` / `present` | bundles with no `dsh.bundle.patch` — they load as plain packages, not patch layers |
  | `pluginLoad` | `pass` / `fail` / `timeout` / `not-run` | isolated host boot |
  | `clientRender` | `pass` / `fail` / `not-run` | stage 2b browser probe |
  | `configSchema` | `pass` / `violation` / `unavailable` / `not-run` | composed config vs the target release's own schema |
  | `hostThrottling` | `none` / `observed` / `unknown` | rate-limit / 429 / quota evidence seen during the run |
  | `defects` | `none` / `present` | non-blocking findings (everything below BLOCKER) |
  | `timeout` | `hit: bool`, `budgetMs` | whether the run itself ran out of budget |

  These are **derived and read-only**. `overall`, the three-state exit code and the aggregation
  rules are untouched — that is what keeps every existing `--from` / `--to` result identical.

- **Profile backup and rollback** — `--backup` snapshots the four files that decide *what loads*
  (`package.json` with `dsh.profile.bundles`, `cordis.yml`, `cordis.patch.yml`,
  `compatibility.json`) under `state/backups/<timestamp>/`, together with the bundle order and
  each plugin's resolved version. `--rollback [id]` restores a snapshot (newest when `id` is
  omitted) and always writes a `pre-restore` safety snapshot first, so a rollback is itself
  undoable. It never touches `node_modules`: restoring rewrites configuration, it does not
  install, remove or downgrade a package.

- A 「逐项结果（独立字段）」 section in `report.md` listing all nine axes for the run.

### Changed

- Version `0.1.0` → `0.2.0`.

### Unchanged (re-verified after the change)

- `--from` / `--to` single-upgrade verdicts and three-state exit codes (`0` pass / `1` block / `2` warn).
- `--to` mode stays fully offline; only `--auto` contacts a registry.
- Isolated `DSH_HOME` + junction dependencies + random port + headless browser.
- Client render probe, config-schema validation, `--fail-open`, W1 postflight, W3 retry-loop detection.
