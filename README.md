# GitHub Core Clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/buahrasa01-hub/makefun-github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/buahrasa01-hub/makefun-github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node 22 process, built for the
make.fun `github-core-clone-01` competition. Standard library only — no
dependencies, no git binary, no outside services.

## What it implements

- **Git smart HTTP** at `/{owner}/{repo}.git`: upload-pack protocol v2
  and receive-pack v0 (report-status, side-band-64k, delete-refs), with a
  from-scratch packfile reader/writer (node:zlib + node:crypto) and
  fast-forward-only pushes with per-ref reporting.
- **REST v3** at `/api/v3`: repositories, contents, labels, issues,
  comments, pull requests (including squash merge with conflict
  detection), branches and refs.
- **GraphQL v4** at `/api/graphql`: repository, issue, and pull-request
  queries, mutations, and introspection.
- **MCP** at `/mcp`: JSON-RPC 2.0 Streamable HTTP tools for repos,
  issues, and pull requests, sharing the same store as REST.

## Running

`main.ts` binds an ephemeral port, registers it with
`$MAKEFUN_ENV_URL/register`, then long-polls `$MAKEFUN_ENV_URL/done`
until the trial ends and exits 0. All state is in memory; the store is
deterministic (seeded from `MAKEFUN_TRIAL_SEED`, dates from
`MAKEFUN_TRIAL_NOW`).

```sh
MAKEFUN_ENV_URL=http://localhost:PORT \
MAKEFUN_SHOP_TOKEN=... \
node main.ts
```

## Layout

- `main.ts` — entrypoint: bind, register, wait for done.
- `lib/app.ts` — HTTP router.
- `lib/store.ts` — in-memory store (repos, files, issues, pulls).
- `lib/git.ts` — git smart HTTP, packfiles, ref rules.
- `lib/rest.ts` — REST v3 handlers.
- `lib/graphql.ts` — GraphQL v4 handlers.
- `lib/mcp.ts` — MCP tools.

## License

MIT — see `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=yk1dttqc&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
