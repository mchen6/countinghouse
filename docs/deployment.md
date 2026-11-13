# Deployment posture

countinghouse's module sandbox isolates **modules from each other, and from
tenants' data,** inside one Node process. It does **not** isolate
countinghouse from the host. The two are layers: run countinghouse as an
unprivileged user, in a container with memory and CPU limits and the
default seccomp profile, and let the sandbox do the part only it can do.
"Sandboxed" never means "no container needed".

This page says why, gives a reference setup (Docker Compose and Kubernetes),
and lists what the in-process sandbox does not give. The sandbox itself is
described in [security-model.md](security-model.md); this page is about where
to put the process.

## What the sandbox does, and what it doesn't

In worker mode (the default) with `--moduleSandbox enforce`, each module runs
in its own worker thread. Its file access goes through a broker on the main
thread, it sees only its own `/app`, `/data` and `/tmp`, and refused
built-ins and native code are blocked. Every decision that protects one
tenant from another (who may call what, billing, the file namespace, the
quota) is made on the main thread. That is what keeps a module away from
another module's files and from other tenants' keys and balances.

It doesn't keep **countinghouse itself** away from the host: the process,
its user, its kernel. For that, use what the host gives you: a separate
user, a container, cgroup limits, a seccomp filter. In a container, an escape
from the in-process sandbox still faces the kernel boundary.

## What the in-process sandbox does not give

In order of weight:

1. **One process, one address space.** Every module and the main thread
   share one Node process: the descriptor table, the environment, the working
   directory, the user id, memory and CPU. Each worker has its own JavaScript
   heap, but a bug in V8 or Node, or one escape from the JavaScript-level
   lockdown, lands in the main thread, which holds every tenant's keys and
   the balance ledger. In a container the same escape still faces the
   kernel. Native code is denied (`process.dlopen`, `.node` files,
   `process.binding`, `node:ffi`), which removes the easiest route but not
   the shared process.
2. **The boundary depends on enumerating Node's surface.** The file broker on
   the main thread is a real boundary, but the patch that routes a module's
   calls to it runs inside the worker and covers a list of entry points.
   Every Node release can add one: Node 26 added `fs.openAsBlobSync`, which a
   completeness test caught. The coming network broker will have the same
   shape over a larger surface (`fetch`'s own sockets, `dns`, `dgram`,
   `http2`, WebSocket). A kernel never has to say "we found them all".
3. **Checks inside the worker are only as strong as the worker.** Module code
   shares its worker's runtime and can reach its state (through
   `require.cache`, for instance). Everything that protects other tenants is
   decided on the main thread, so a module tampering with its own worker
   hurts only itself. But nothing like a container's kernel boundary sits
   between a module and the code that guards it.
4. **No kernel-level resource isolation.** Containers have cgroups;
   countinghouse has per-worker heap limits, message-rate caps, disk quotas,
   job bounds and broker deadlines. A module can still keep a CPU core busy,
   and the descriptor table and libuv's thread pool are shared by the whole
   process. Resource isolation is bounded by policy, not enforced by the
   kernel: a hostile module is likelier to degrade the server than to escape
   it.
5. **The process's privileges are the module's privileges.** Everything a
   module does, the kernel sees as the countinghouse process: the same uid,
   no seccomp filter of its own, no capability drop.
6. **Fragility across Node versions.** `--hardened` rests on Node's
   permission model, which is partly experimental (`--allow-net` on Node 26;
   [nodejs/node#66812](https://github.com/nodejs/node/issues/66812)), and the
   sandbox rests on patching `fs` and on require hooks. Kernel interfaces
   don't move like that.

The network is also not yet a boundary: until sandbox parts 3 and 4, a module
can open outbound connections, so network policy belongs to the container or
host (below). See security-model.md's
[accepted gaps](security-model.md#what-this-explicitly-does-not-provide-accepted-gaps-and-limits)
for the full list.

## The posture

- **An unprivileged user.** Never root. In the official Node images, the
  `node` user (uid 1000).
- **A container,** with:
  - memory and CPU limits;
  - the runtime's default seccomp profile (Docker applies it unless told
    otherwise; in Kubernetes set `seccompProfile: RuntimeDefault`);
  - all capabilities dropped and no privilege escalation;
  - a read-only root file system, with volumes only for the module directory
    and module data.
- **countinghouse's own layer on top:** `--moduleSandbox enforce` (the
  default mode is `audit`, which only logs), and
  optionally `--hardened`, Node's permission model, as a second in-process
  layer. Never `--debug` in production.
- **Redis reachable from countinghouse only.** Redis holds the balance
  ledger, job data and sessions; a module must never reach it. The
  in-process denial of the Redis endpoint is not a network boundary (item 2
  above), so enforce it in the network: a separate network in Compose, a
  NetworkPolicy in Kubernetes.
- **The auth config as a secret,** mounted read-only. With the file provider
  (the default), the file must exist: if it's missing, the provider tries to
  write a demo key to that path, which fails on a read-only mount and logs an
  error.
- **Behind an ingress.** countinghouse binds `127.0.0.1` unless `--bindAddr`
  is given. A loopback bind inside a container is reachable only from the
  same network namespace (a proxy sidecar in the same Kubernetes pod). With
  an ingress in another container, bind `0.0.0.0` inside the container and
  publish the port to nothing but the ingress's network, so the exposure is
  the same.

## Reference: Docker Compose

A sketch to adapt, not a supported image. It assumes the repository checked
out next to it, and your reviewed modules in `./modules`.

```dockerfile
# Dockerfile
FROM node:24-slim
WORKDIR /opt/countinghouse
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY framework.js ./
COPY bin ./bin
COPY lib ./lib
COPY spec ./spec
USER node
EXPOSE 9527
ENTRYPOINT ["node", "/opt/countinghouse/framework.js"]
```

```yaml
# compose.yaml
services:
  countinghouse:
    build: .
    command:
      - --bindAddr=0.0.0.0
      - --moduleSandbox=enforce
      - --redisUrl=redis://redis:6379
      - --authConfigPath=/run/secrets/auth.json
      - --modulePath=/var/lib/countinghouse/modules
      - --moduleDataPath=/var/lib/countinghouse/module_data
      - --loadModule=/var/lib/countinghouse/modules/my-module
    secrets: [auth.json]
    volumes:
      - ./modules:/var/lib/countinghouse/modules:ro
      - module_data:/var/lib/countinghouse/module_data
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    mem_limit: 2g
    cpus: 2
    networks: [front, back]
    # no `ports:`: only the ingress, on `front`, reaches it
  redis:
    image: redis:7
    networks: [back]          # countinghouse only
  ingress:
    image: caddy:2             # TLS, then reverse_proxy countinghouse:9527
    ports: ["443:443"]
    networks: [front]
secrets:
  auth.json:
    file: ./secrets/auth.json
volumes:
  module_data:
networks:
  front:
  back:
    internal: true
```

Notes:
- `back` holds only countinghouse and Redis, and is `internal`, so it has no
  route out.
- Each module's `data` and `tmp` under `--moduleDataPath` are made 0700 at
  every start of the module, group and setgid bits included: they are the
  module's private directories by design. A backup that needs them runs as
  the runtime's user, or backs up `--moduleDataPath` as a whole.
- `--modulePath` and `--moduleDataPath` are distinct names: under
  `--hardened`, a granted directory whose name another grant extends is
  refused (`X` beside `X_data`; see
  [cli-and-api-reference.md](cli-and-api-reference.md)).
- Check the base image's glibc (`ldd --version` in the image) if you use the
  SQLite auth provider: its prebuilt `sqlite3` binding needs glibc ≥ 2.38, or
  a rebuild from source ([authentication.md](authentication.md)). The default
  file provider needs no native module.

## Reference: Kubernetes

The same posture, in outline:

- **A Deployment** of one replica: the gateway keeps in-memory state, so
  scaling out needs more design first. Its pod spec has:
  - `securityContext`: `runAsNonRoot: true`, `runAsUser: 1000`,
    `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`,
    `capabilities: {drop: [ALL]}`, `seccompProfile: {type: RuntimeDefault}`;
  - `resources.limits` for memory and CPU;
  - the auth config from a **Secret**, mounted read-only at
    `/run/secrets/auth.json`;
  - module data on a **PersistentVolumeClaim**, and modules baked into the
    image or on a read-only volume. Operator review happens when the image
    is built, which keeps "countinghouse never fetches code over the
    network".
- **A ClusterIP Service** and an **Ingress** in front. Bind `0.0.0.0` in the
  container, or bind loopback and run the proxy as a sidecar in the same
  pod.
- **NetworkPolicies:**
  - Redis accepts ingress only from the countinghouse pods;
  - countinghouse's egress is limited to Redis, DNS, and the hosts your
    module policy approves. Until the network broker, this is the network
    boundary for modules.
- **Restart policy:** the Deployment default (`Always`).

## Local mode: `--store local`, no Redis

For a client machine (the client-pack launcher), `--store local` keeps
what the runtime held in Redis in files under `--storePath` (default
`<moduleDataPath>/../store`) and in memory, and opens no socket of its own:
metering (`metering.json` with `--meter`; without it calls are counted in
memory and none is refused), a module's `ctx.redis` data (`kv.json`), and
jobs and MCP tasks in an in-process runner. `--redisUrl` with
`--store local` is refused ("choose one"). Several runtime processes may
share one store directory: every write is locked and merged by key.

What local mode does not keep: jobs and tasks live in memory only, so a
restart forgets them (`tasks/get` for a task from an earlier process
answers "not found"), and a finished job is kept for `--jobResultTtl`
seconds. The device log is kept in memory only, the last 1000 entries per
device. The API monitor's log (`--apiMonitor`) is absent. Over `--stdio`
without `--authConfigPath` the server runs as one user, its key made at
start and written nowhere ([security model](security-model.md)).

Writes reach the store's files on a schedule (metering within about half
a second, a module's `ctx.redis` data within five seconds), and at once
when the process stops cleanly: stdin closing (how a `--stdio` client ends
it), SIGINT (Ctrl-C), or SIGTERM on Linux and macOS. On Windows a kill
(`taskkill /F`, a terminated job) ends the process with no handler run, so
the writes since the last scheduled one are lost there: up to about half a
second of metering and five seconds of `ctx.redis` data.

## Without a container

The same layers on a plain host: a dedicated user, systemd's sandboxing and
limits, and an address filter. security-model.md has a
[systemd unit](security-model.md#hardening-with-systemd) along those lines.
