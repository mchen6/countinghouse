# We built MCP's tool architecture in 2015 — by accident

*[countinghouse](https://github.com/mchen6/countinghouse) — a runtime where MCP tools call other MCP tools. Apache-2.0, [on npm](https://www.npmjs.com/package/countinghouse).*

In 2015 I wrote a Node.js framework for a problem nobody framed this way back then: let a client that has never seen your service discover it, understand it, and call it — without integrating an SDK. It was called CDIF, the setting was the early IoT wave, and everything in it was a *device* exposing *services* containing *actions*. A client's whole lifecycle was four HTTP calls: list what's here, fetch a thing's description, fetch its JSON Schema, invoke an action with a JSON payload. The server validated every call before implementation code saw it.

In 2024, Anthropic shipped the Model Context Protocol, and I had a strange afternoon. `get-spec` is `tools/list`. `invoke-action` is `tools/call`. The schema endpoint is `inputSchema`. Server-side validation is server-side validation. Piece for piece, it was what I had been running in production for a decade.

That is the accident the title refers to, and it is the less interesting one. The accident worth writing about happened five years later, and it produced something MCP still doesn't have: **tools that can call other tools.**

## The gap

MCP's shape is client-calls-tool, and that is the whole of it. When one tool needs another, the orchestrating model is the only thing that can join them — tool A returns to the model, the model reads the result, the model passes it to tool B. Every intermediate byte is serialized, billed, attended to, and retained.

I did not set out to fix this. Node had no real threads in 2015; `worker_threads` stabilized in 12.11, and I rebuilt CDIF on it around 2020 for two entirely local reasons. One module's CPU-bound handler could stall every other module in the process, and modules had started needing to call each other. Once each module lives in its own thread, "call another module" becomes a message across a channel — so I built one. That December I added a distributed task engine so a module could start long work without holding a request open. (The 2026-07-28 spec's Tasks extension mapped onto it almost embarrassingly directly.)

Two things follow from that channel. One you can measure. One you can't get any other way.

## The one you can't get any other way

Point an agent at a repository and ask it to find hardcoded credentials. The scan tool returns three megabytes of source into the context window, the model reads all of it, then hands it to the secret detector. Look at what just happened: **to find out whether you had leaked a credential, you sent the credential to a third party.** The detector is theater.

`examples/repo-review` is that chain written as one composite tool — scan, detect secrets, audit dependencies. The source moves between worker threads and never leaves the process; a few kilobytes of findings come back. The tool reports both byte counts, so you can do the arithmetic on your own repository rather than take mine.

But the number is only the demonstration. The guarantee is the output schema: open the spec and look at what the tool can return — findings, counts, a bill. There is no field that can hold source code. Not "the model didn't send it this time." There is no shape for it to travel in.

## Code execution deserves a fair hearing

The model writing a script for a sandbox to run keeps intermediate data out of the context window too, and the strawman version of this comparison is not worth anyone's time. The real differences are narrower and more interesting than speed.

Its glue is a script written fresh each run, so its guarantee is behavioral where a published tool's is structural. Its tool calls still cross process boundaries even when the model doesn't. And it needs the client to have a sandbox at all, while a composite tool is just a tool any MCP client can call.

Tool-to-tool is where it gets concrete. Nothing in code execution forbids one tool from calling another — an MCP server can be an MCP client, and some are. But nothing provides it either. The second server's transport, connection lifecycle, credentials and retry policy are yours to build and yours to keep working, and when the call finally happens it crosses a process boundary anyway. The hop gets rebuilt, not removed.

The sharper cost isn't latency, it's the abstraction leak. If tool A needs B halfway through its own execution, A has to split into `A_part1` and `A_part2` — and A's private intermediate state becomes a public interface the orchestrating script must receive and hand back unchanged. Cohesive logic that belonged inside one tool becomes three calls and a piece of glue the model regenerates on every run. Such a composite cannot be published as a tool. It can only exist as a script.

The interesting question isn't which approach wins. It's when a chain should stop being improvised and graduate into a published module with a contract someone reviewed once. The version I find hardest to argue with: it's 3am, and last night's failed charges need retrying against a refund policy that must be applied identically every night. There is no model turn at 3am. Whatever runs was decided in advance — the only question is whether it was decided in something with a schema and a version number, or in a script nobody read.

## The measurable one, with its own caveat

An MCP server is a separate process, whether a local child over stdio or a service over a socket, so every tool-to-tool hop costs a serialize, a pipe write, a deserialize and a scheduler round trip. Modules on one runtime hand each other a structured clone in shared process memory instead.

At 1KB the gap nearly closes: 0.34ms in-process versus 0.36ms over stdio and 0.73ms over HTTP. At 1MB it does not — one hop costs 9.1ms, 86.1ms and 38.8ms respectively; a hundred hops cost 0.9s, 8.3s and 3.7s, and 21s, 173s and 76s of CPU. The stdio condition is a bare JSON-RPC echo with no handshake and no `tools/list`: the best case for stdio, not a typical one.

Now the honest part, which the benchmark script computes rather than asserts. The largest per-hop saving it measured is 31ms, so a tool whose own execution takes more than about 310ms would see even that as under 10% of the call. Anything hitting a database, an API or a model is far past that line. **Per call, the transport rounds to nothing.**

Per session it doesn't, and the arithmetic is just multiplication. Agent runs are hundreds of calls over hours; that 8.3-versus-0.9-second row is one chain. The workload where this shows up is composition-heavy, large-payload and fast-tooled — parse, chunk, embed, retrieve, rerank — and the CPU column matters more than the clock. 173 seconds against 21 is not latency you wait out. It is capacity you buy. [Full tables, methodology and caveats.](https://github.com/mchen6/countinghouse/blob/master/docs/direct-peer-channels.md#benchmark-transport-overhead-vs-other-tool-to-tool-mechanisms)

## Why the 2015 part matters at all

One decision from back then turned out to be load-bearing, and it was the least visionary one I made. Around 2016 I added a flag called `allowSimpleType`. Unless you set it, the framework enforced a rule: **every action takes exactly one argument, of type `object`, and returns exactly one output, of type `object`** — both schema-defined. The motivation was mundane: UPnP's argument lists carried primitive types, web service inputs are documents, and squeezing documents into scalar argument lists was ugly.

That is precisely MCP's tool shape. It is also gRPC's. Three designs, three unrelated pressures — gRPC wanted evolvability, CDIF wanted type hygiene, MCP wants generation reliability, because a model filling one named, schema-constrained object fails far less often than one emitting positional arguments. Positional parameters are an artifact of same-process function calls; across a boundary between parties that don't share code, single-object-in/single-object-out looks less like a convention than a finding.

CDIF went nowhere in 2015 because its promise — reach any service without integrating an SDK — only pays off if a *universal consumer* exists. In 2015 those were schema-driven form generators and visual flow editors. Useful, niche. Then LLMs arrived, among other things the best schema-driven form fillers ever built. The design didn't get better; the world grew into it. If you built service infrastructure before 2023, your old code may be closer to MCP-ready than most greenfield projects. The hard part was never the transport. It was the discipline of machine-readable contracts.

Reviving it wasn't free, and specifics matter, because "we were doing MCP before MCP" earns zero credibility without them: JSON Schema draft-04 → 2020-12 with a migration for every module spec; MCP's stateless Streamable HTTP transport; a decade of ES5 rewritten; production `npm audit` from 31 high/critical findings to zero, with four moderate left and a dev toolchain that carries its own, which I won't pretend otherwise about. And `allowSimpleType` is gone — the optional rule became the only rule, because the consumer is a model now, so the format has to be something a model can read *and write*.

## Try it

Needs Node 20+ and a running Redis.

```bash
git clone https://github.com/mchen6/countinghouse.git
cd countinghouse && npm install

npm run demo:repo-review
```

Then point an MCP client at it:

```bash
claude mcp add --transport http countinghouse http://127.0.0.1:9527/mcp \
  --header "X-CH-Key: demo-key"
```

The script loads four modules and reads `examples/repo-review/auth.json`, a file committed on purpose. It grants `demo-key` the composite tool and nothing else: the three inner tools are not in that key's `tools/list`, and calling one directly is refused — which is exactly the encapsulation the composite exists to demonstrate, since the same call *through* `repo-review` works. That key is a demo credential, usable only against a server you started yourself on `127.0.0.1`; replace it before this is reachable from anywhere else.

Then point it at a repository you wouldn't paste into a chat window, and watch what does and doesn't come back.

Repo: [github.com/mchen6/countinghouse](https://github.com/mchen6/countinghouse) (Apache-2.0). The original 2015 repo is archived [here](https://github.com/mchen6/cdif) with history intact — the `allowSimpleType` commit included, for anyone who wants to check the receipts.

Two limits worth stating plainly. In-process composition works only between modules on the same runtime. And module isolation is `worker_threads` — separate V8 heap, shared process, filesystem and network — which is a reasonable boundary for modules from developers you have a relationship with, and is not comparable to containers or micro-VMs; [`docs/security-model.md`](https://github.com/mchen6/countinghouse/blob/master/docs/security-model.md) says so at length. I'm one person and this codebase is ten years old in the best and worst senses. If you're building agent infrastructure and this is your missing layer too — issues and email are open.
