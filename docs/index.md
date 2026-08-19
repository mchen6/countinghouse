# We built MCP's tool architecture in 2015 — by accident

*[countinghouse](https://github.com/mchen6/countinghouse) — a multi-tenant MCP runtime. Apache-2.0, [on npm](https://www.npmjs.com/package/countinghouse).*

In 2015 I wrote a Node.js framework for a problem nobody framed this way back then: let a client that has never seen your service discover it, understand it, and call it — without integrating an SDK.

In 2024, Anthropic shipped the Model Context Protocol. When I read the spec carefully, I had a strange afternoon: the tool architecture — a discovery endpoint returning machine-readable descriptions, a uniform invocation endpoint, every tool taking exactly one schema-defined JSON object in and returning one out, validated on the server — was, piece for piece, what I had been running in production for a decade.

This is not a priority claim. MCP's designers solved their problem correctly, and so did gRPC's, and — mostly by luck — so did I. What makes it worth writing up is the second accident, five years later, which turned out to matter more.

## The first accident

The framework was called CDIF. The setting was the early IoT wave: heterogeneous devices speaking Z-Wave, ZigBee and UPnP dialects, plus ordinary web services, and clients that had to talk to all of them. Everything is a *device* exposing *services* containing *actions*, and a client's entire lifecycle is four HTTP calls: list what's here, fetch a thing's JSON description, fetch the dereferenced JSON Schema for its arguments, invoke an action with a JSON payload. The server validates every call against the schema before implementation code sees it. Implementations are plain npm packages loaded into the runtime.

If you know MCP you've already done the mapping: `get-spec` is `tools/list`, `invoke-action` is `tools/call`, the schema endpoint is `inputSchema`, server-side validation is server-side validation.

The deepest correspondence came from the least visionary decision. Around 2016 I added a flag called `allowSimpleType`. Unless you set it, the framework enforced a rule: **every action takes exactly one argument, of type `object`, and returns exactly one output, of type `object`** — both schema-defined. The motivation was mundane. UPnP's argument lists carried primitive types, the right shape for a temperature sensor. Web service inputs are documents: nested, optional-field-heavy, list-carrying. Squeezing documents into scalar argument lists was ugly, so I split the type system.

That is precisely MCP's tool shape. It is also gRPC's. Three designs, three unrelated pressures: gRPC wanted evolvability (add a field without breaking a signature); CDIF wanted type hygiene; MCP wants generation reliability, because a model filling one named, schema-constrained object fails far less often than one emitting positional arguments. Different reasons, same shape. Positional parameters are an artifact of same-process function calls; across a boundary between parties that don't share code, single-object-in/single-object-out looks less like a convention than a finding.

## Why it went nowhere in 2015

CDIF's README promised that clients needn't integrate any SDK to reach any device or service. Technically true; commercially, it answered a question nobody was asking. The promise only pays off if a *universal consumer* exists — a client that talks to arbitrary services it has never seen. In 2015 those were schema-driven form generators and visual flow editors. Useful, niche. Human developers, given the choice, just integrated the SDK.

Then LLMs arrived — among other things, the best schema-driven form fillers ever built. One reads a description, fills the object, handles the response, for any tool it has never seen before. Self-describing interfaces stopped being a nicety and became load-bearing. The design didn't get better; the world grew into it. If you built service infrastructure before 2023 — integration platforms, ESB-ish things, device abstraction layers — your old code may be closer to MCP-ready than most greenfield projects. The hard part was never the transport. It was the discipline of machine-readable contracts, which some of us adopted for reasons that had nothing to do with AI.

## What ten years of production actually buys you

The revived project is called **countinghouse** — the room where a trading firm recorded and settled its accounts. Reviving it wasn't free, and specifics matter, because "we were doing MCP before MCP" earns zero credibility without them: JSON Schema draft-04 → 2020-12 with a migration for every module spec; MCP's stateless Streamable HTTP transport; a decade of ES5 rewritten; production `npm audit` from 31 high/critical findings to zero, with four moderate left and a dev toolchain that carries its own, which I won't pretend otherwise about.

One change closes the loop on the 2016 accident. Back then, single-object-in/out was a *flag* you could turn off, sitting next to a pile of UPnP scaffolding: a state table that arguments pointed into by name, a `direction` field marking each one in or out, a `retval` boolean nobody used. All of it is gone; an action carries its `input`, `output` and `fault` schemas directly, and the optional rule became the only rule. Authoring a tool shrank the same way — from a discovery event-emitter plus a registration file repeating every name in full, to a single async function. The reason to bother is this post's thesis: the consumer is a model now, so the format has to be something a model can read *and write*.

What carried over intact: the multi-tenant runtime — each third-party module in its own worker thread with an isolated V8 heap (the honest threat model, including what worker threads do *not* protect against, is in [`docs/security-model.md`](https://github.com/mchen6/countinghouse/blob/master/docs/security-model.md)) — plus per-API-key metering, rate limiting, and a verify/publish pipeline. Everyone in the current MCP hosting wave hosts tools; almost nobody meters and settles them for third-party developers.

## The second accident

The worker-thread runtime isn't from 2015, and the difference matters, because it's where the story repeats.

Node had no real threads in 2015. `worker_threads` arrived experimentally in Node 10.5 (2018) and stabilized in 12.11 (late 2019). I rebuilt CDIF on it around 2020 for two local reasons: one module's CPU-bound handler could stall every other module in the process, and modules had started needing to call each other. Once each module lives in its own thread, "call another module" becomes a message across a channel — so I built one. That December I added a distributed task engine, so a module could start long work without holding a request open. (The 2026-07-28 spec's Tasks extension mapped onto it almost embarrassingly directly.)

That channel is the part I'd argue about. Two things follow from it — one you can measure, one you can't get any other way.

**The measurable one.** An MCP server is a separate process, whether a local child over stdio or a service over a socket. Every tool-to-tool hop therefore costs a serialize, a pipe or socket write, a deserialize, and a scheduler round trip. Modules on one runtime hand each other a structured clone in shared process memory instead — no framing, no transport, no second process to wake up.

Measured against a stdio subprocess and localhost HTTP, at 1KB the gap nearly closes: 0.34ms versus 0.36ms versus 0.73ms per hop. At 1MB it does not. One hop costs 9.1ms in-process, 86.1ms over stdio, 38.8ms over HTTP; a hundred hops cost 0.9 seconds, 8.3 seconds, and 3.7 seconds respectively, and 21s, 173s and 76s of CPU. The stdio condition is a bare JSON-RPC echo with no handshake and no `tools/list` — the best case for stdio, not a typical one. [Full tables, methodology and caveats.](https://github.com/mchen6/countinghouse/blob/master/docs/direct-peer-channels.md#benchmark-transport-overhead-vs-other-tool-to-tool-mechanisms)

Now the honest part, which the benchmark script computes rather than asserts: the largest per-hop saving it measured is 31ms, so a tool whose own execution takes more than about 310ms would see even that as under 10% of the call. Anything hitting a database, an API or a model is far past that line. Per call, the transport rounds to nothing.

Per session it doesn't. Agent runs are not one call; they are hundreds, over hours, and the arithmetic is simply multiplication. That 8.3-versus-0.9-second row is one chain. The workload where this shows up at all is composition-heavy, large-payload and fast-tooled — parse, chunk, embed, retrieve, rerank — and the CPU column matters as much as the clock: 173 seconds versus 21 is not latency you wait out, it is capacity you buy.

**The one you can't get any other way.** Point an agent at a repository and ask it to find hardcoded credentials. The scan tool returns three megabytes of source into the context window, the model reads all of it, then hands it to the secret detector. Look at what just happened: **to find out whether you had leaked a credential, you sent the credential to a third party.** The detector is theater.

`examples/repo-review` is that chain written as one composite tool — scan, detect secrets, audit dependencies. Your source moves between worker threads and never leaves the process; a few kilobytes of findings come back. The tool reports both numbers, so you can do the token arithmetic on your own repository rather than take mine. But the number is only the demonstration. The guarantee is the output schema: open the spec and look at what the tool can return — findings, counts, a bill. There is no field that can hold source code. Not "the model didn't send it this time." There is no shape for it to travel in.

Code execution — the model writing a script for a sandbox to run — deserves a fair hearing rather than a strawman; it keeps intermediate data out of the context window too. The real differences are narrower and more interesting than speed: its glue is a script written fresh each run, so its guarantee is behavioral where a published tool's is structural; its tool calls still cross process boundaries even when the model doesn't; and it needs the client to have a sandbox at all, while a composite tool is just a tool that any MCP client can call.

Tool-to-tool is where that gets concrete. Nothing in code execution forbids one tool from calling another — an MCP server can be an MCP client, and some are. But nothing provides it either. The second server's transport, connection lifecycle, credentials and retry policy are yours to build and yours to keep working, and when the call finally happens it crosses a process boundary anyway. The hop gets rebuilt, not removed.

The sharper cost isn't latency, it's the abstraction leak. If tool A needs B halfway through its own execution, A has to split into `A_part1` and `A_part2` — and A's private intermediate state becomes a public interface the orchestrating script must receive and hand back unchanged. Cohesive logic that belonged inside one tool becomes three calls and a piece of glue the model regenerates on every run. That is the mechanism behind the earlier claim: such a composite cannot be published as a tool. It can only exist as a script.

The interesting question isn't which approach wins. It's when a chain should stop being improvised and graduate into a published module with a contract someone reviewed once. The version I find hardest to argue with: it's 3am, and last night's failed charges need retrying against a refund policy that must be applied identically every night. There is no model turn at 3am. Whatever runs was decided in advance — the only question is whether it was decided in something with a schema and a version number, or in a script nobody read.

That's the next post, along with the benchmarks and the two bugs I hit building this. One limit worth stating up front: in-process composition works only between modules on the same runtime.

## Try it

Needs Node 20+ and a running Redis. Metering is not optional here — without a
reachable Redis the server does not start at all, let alone bill anything.

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

The script loads all four modules and reads `examples/repo-review/auth.json`, a
file committed on purpose. It grants `demo-key` the composite tool and nothing
else: the three inner tools are not in that key's `tools/list`, and calling one
of them directly is refused — which is exactly the encapsulation the composite
exists to demonstrate, since the same call *through* `repo-review` works and
bills `demo-key` for all three hops. That key is a demo credential, usable only
against a server you started yourself on `127.0.0.1`; replace it, or set
`COUNTINGHOUSE_API_KEY`, before this is reachable from anywhere else.

Balances live in Redis and survive a restart, so only your first run bills
`demo-key` from `0` down to `-3` — after that the meter keeps counting where it
left off.

Then point `examples/repo-review` at a repository you wouldn't paste into a chat window, and watch what does and doesn't come back.

Repo: [github.com/mchen6/countinghouse](https://github.com/mchen6/countinghouse) (Apache-2.0). The original 2015 repo is archived [here](https://github.com/mchen6/cdif) with history intact — the `allowSimpleType` commit included, for anyone who wants to check the receipts.

I'm one person, this codebase is ten years old in the best and worst senses, and the security model document says plainly what the isolation boundary is and is not. If you're building agent infrastructure and this is your missing layer too — issues and email are open.
