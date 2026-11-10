# Brainstorm: modules in other languages, containers, Kubernetes

Status: notes from a conversation between the user and the reviewer (countinghouse-a5),
2026-11-10. Not a spec, nothing decided. Written for a later brainstorm → spec, probably
together with the network-broker design (sandbox parts 3–4), because the two interact.

## The question

How should countinghouse support modules written in Python, Rust and other languages?
Must they run in their own container? How is the whole system (countinghouse, Redis, the
auth store, JS modules, foreign-language modules) deployed to Kubernetes? What replaces the
management we built for JS modules (validate, load/reload/unload/restart, supervisor,
identity, metering, declared calls, audit)?

## 1. The module contract for every language is MCP plus a manifest

Today a module is an npm package: `api.json` + `schema.json` describe the tools, JS
handlers implement them, the runtime adds the multi-tenant layer (contract validation,
per-key access, identity, metering, declared calls, lifecycle, sandbox, audit).

A foreign-language handler cannot live in a Node worker thread, so the module boundary
becomes a process boundary and needs a protocol. MCP already is that protocol:
- `tools/list` → the tool surface and schemas (what `api.json`/`schema.json` give today);
- `tools/call` → run a tool; MCP tasks → long jobs and progress; MCP logging
  notifications → the module's log lines (`ctx.log`).
A Python module = an MCP server written with the official Python SDK + a countinghouse
**manifest**: name, version, permissions (egress hosts, storage quota), declared calls,
pricing, image reference, health. Same for Rust.

This unifies the model: a JS module is "an MCP server that runs in-process". Two hosts,
one contract:
- **in-process host** (today's worker threads): JS only, fast, brokered file I/O, our sandbox;
- **container host**: any language, one container per module version, kernel isolation.
`api.json` stays the convenient authoring format for the in-process kind.

## 2. Containers: one per module version, never per tenant

Foreign modules must run in their own container: our sandbox is JS-level and does not
apply to native code; the kernel boundary is the only isolation available, and it is the
stronger one. One long-lived container per module version serves all tenants; identity is
carried per call (as with workers today).

Per call, across the boundary (`_meta` on the MCP call or headers):
- the caller's opaque id + admin flag (R2-1's `ctx.caller`), never a key;
- a per-call token (R2-1's design) for callbacks: a composing module calls back into
  countinghouse's MCP endpoint with the token; main authorizes as the module's binding,
  enforces its declared calls, bills the original caller.

Mutual trust: countinghouse must prove itself when it sends a caller id (or the module
cannot trust `_meta`); the module must prove it is module X when it calls back. On k8s:
mTLS between pods (mesh or SPIFFE), or to start a per-module secret issued at deployment,
plus the per-call tokens.

## 3. Kubernetes deployment

- **countinghouse main**: a Deployment behind an ingress (MCP gateway). Auth config as a
  Secret (file provider), or sqlite on a volume, or CouchDB as a service. JS modules baked
  into the image or on a volume under `--modulePath`; operator review happens at image
  build, which keeps "countinghouse never fetches code over the network".
- **Redis**: a dependency (managed or StatefulSet), reachable from countinghouse only
  (NetworkPolicy), never from module pods: R2-1's Redis denial at the network layer.
- **Each foreign module**: Deployment + ClusterIP Service, MCP over stateless Streamable
  HTTP. NetworkPolicy: ingress from countinghouse only; egress to countinghouse (callbacks)
  and the hosts its manifest declares. No module-to-module traffic: composition goes through
  main, where declared calls and metering live. No direct-peer-channel equivalent at first;
  a sidecar-brokered fast path only if measurements demand it.
- **Module storage**: a PVC per module with a quota (the `/data` equivalent).
- **Packaging**: a Helm chart (countinghouse + Redis + module Deployments generated from
  manifests). Later a small operator with a `CountinghouseModule` CRD generating Deployment,
  Service, NetworkPolicy, PVC from the manifest.
- **Scaling caveat**: main holds in-memory state (per-call tokens, identity index,
  ended-device records, peer channels). Several main replicas need shared state or sticky
  routing. Jobs already go through Redis, so job processing scales; the gateway is a single
  replica until designed otherwise.

## 4. The management mechanism, mapped

| Today (in-process JS) | Container modules |
|---|---|
| `countinghouse-validate` checks the package against the contract | same tool runs the image in a throwaway container, calls `tools/list`, validates schemas (2020-12, naming, output schemas) and the manifest, records a golden `tools/list` |
| npm is the marketplace; the operator installs | an OCI registry is the marketplace; the operator deploys; countinghouse registers what runs |
| load / reload / unload / restart, with the ordering rules (B1+B2) | load = register the Service endpoint + fetch `tools/list`; reload = re-fetch after the operator rolls the Deployment (schema-hash change detection exists for tasks); unload = deregister |
| supervisor (backoff, suspend after repeated crashes) | k8s restart policy + readiness probes; countinghouse keeps endpoint health and the unavailable codes (`MODULE_RESTARTING` etc.) |
| identity, metering, declared calls, access control on main | unchanged: main is the gateway in front of every module |
| file broker + per-operation audit | kernel + NetworkPolicy isolate; per-operation I/O audit of a container is a gap (an egress sidecar proxy could fill it) |
| `ctx.log` → main as single writer | MCP logging notifications → main attributes by connection |

## 5. Avoid

- Per-language in-process runtimes (embedding Python, Rust via N-API): native code back
  inside the one process we protect.
- A new module RPC: MCP is the contract clients speak and every language has an SDK.
- WebAssembly as the general answer now: attractive for Rust (in-process, capability-based),
  a possible third host later; its I/O model differs from the broker, and Python is poorly
  served.

## 6. Decisions a spec would need (in order)

1. The module contract for all languages is MCP + a manifest (yes/no).
2. Foreign modules: one container per module version; composition through main only.
3. k8s owns supervision and packaging; countinghouse owns registration, contract validation,
   identity, metering, audit.
4. Trust between countinghouse and module pods: mesh mTLS vs per-module secret + per-call tokens.
5. Whether JS modules may also run in the container host (defense in depth) via a
   "JS module host" image.
6. Timing: spec together with parts 3–4 (for container modules the network broker IS the
   NetworkPolicy, which changes what parts 3–4 must build for the in-process host).
