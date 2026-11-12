# Running the tests

`npm test` runs every test run listed in `test/folders.json`, in order. CI
runs the same list (`node scripts/run-tests.js --ci`) on the Node versions in
`.github/workflows/ci.yml`. CI is the gate for a pull request. Locally, run
the files a change touches.

## On your machine

```sh
npx mocha --exit test/composition/02-ctx-call.js
```

The server-starting tests listen on fixed ports and use the Redis on
`127.0.0.1:6379` (job queue on db 11). Two runs at once on one machine can
take each other's ports and each other's queued jobs. To move a run aside,
set the variables `test/helpers/test-env.js` reads:

- `CH_TEST_PORT_BASE=<port>`: each port a test asks for becomes the base,
  base + 1, and so on.
- `CH_TEST_REDIS_URL=redis://127.0.0.1:<port>`: passed to every server as
  `--redisUrl`.

## In a container

`scripts/run-in-docker.js` runs test files in a throwaway container. The
container has its own Redis and its own network namespace (`--network
none`), so it cannot meet the shared Redis, another session's ports, or
another container's. Use it when several runs share one machine, or for a
clean "stranger's machine" check. The image holds the files git lists in
your working tree (tracked, and untracked but not ignored, as they are on
disk now), with the dependencies `npm ci` installs from `package-lock.json`.
Nothing `.gitignore`'d reaches it: no local `auth.json`, database or log.

```sh
node scripts/run-in-docker.js test/module-loading/15-reload-scenarios.js
node scripts/run-in-docker.js --node 22 test/composition/02-ctx-call.js
node scripts/run-in-docker.js            # CI's suite: scripts/run-tests.js --ci
```

- `--node 22` uses Node 22.16.0 (the floor), `--node 24` (the default) the
  newest 24.x.
- Each file runs with `mocha --exit`. The exit status is the run's.
- A file to run must be one git lists, since only those are in the image.
- The image (`test/docker/Dockerfile`) is built on every call, or reused from
  Docker's build cache. Only a change to `package.json` or
  `package-lock.json` reinstalls the dependencies; any other change copies
  the tree again in seconds. The first build of each Node version pulls two
  base images and compiles sqlite3, a few minutes.
- Each run builds under a tag of its own, so runs from two worktrees at once
  never test each other's tree. The container and the tag are removed when
  the run ends, however it ends, Ctrl-C included; the build cache keeps the
  layers.
- Rootless Docker works. When `DOCKER_HOST` is not set, the script uses
  `/run/user/<uid>/docker.sock` if it exists.
- Docker's build cache keeps the base images and the installed
  dependencies for both Node versions, about 6 GB. `docker builder prune`
  reclaims it; the next build then starts from the beginning.

Containers share the machine's CPUs. A test with a fixed deadline (for
example a 15 s module load) can miss it when more runs are going than there
are CPUs; run at most about as many containers at once as the machine has
CPUs.

CI does not use the container; its workflow is unchanged.
