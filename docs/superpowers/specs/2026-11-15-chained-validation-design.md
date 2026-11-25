# Chained validation: the validator delivers checked bytes to the worker (#224, extended to tools/call)

Status: a design for review. Nothing is built until the reviewer approves it. It is a trust-boundary change: a validator gets a port into each module worker.

## Why, against Matt's gate

Matt's gate (2026-11-15):
- at 2+ sessions, a warm shared call is no slower than separate servers;
- at 1 session, a warm shared call is at most 2 ms slower per call than a separate server;
- both are measured through the Rust shim on a quiet machine.

Measured through the real ch-shim on `--sessionSocket`, on this 2-CPU VM (master 3749f5cd, ch-local main c6404af):

| | warm call (median) | CPU per call |
|---|---|---|
| A: a separate stdio server | 1.08–1.21 ms | server 0.76–0.85 ms |
| S: through the shim | 3.76–4.40 ms | runtime 3.2–3.6 ms; shim 0.22–0.30 ms |
| S with both validator checks stubbed | 3.01–3.28 ms | runtime 2.5–2.6 ms |

So at N=1 we are +2.7–3.2 ms over A: about 1 ms over the gate.

The two validator round trips cost ~0.6–0.9 ms of wall per call. A tools/call crosses threads six times (one way):
- main → validator → main for the input;
- main → worker → main for the call itself;
- main → validator → main for the output.

This design removes two of the six, which saves **~0.35–0.45 ms of wall per call** on this host:
- the input goes validator → worker instead of validator → main → worker;
- the output goes worker → validator instead of worker → main → validator.

The other cuts measured so far are #274 and the (a) PR (usage writes off the call path, no require() on it). Together they bring the main thread from 1.78 to 1.62 ms of CPU per call (about −0.3 ms of wall), and this design is what is left. Even with both, N=1 is about +2.0–2.4 ms on this VM: borderline. On a machine with 4+ cores, the run-queue waits that 2 CPUs add (1.4–2.7 ms per call, server side) mostly go.

For hop-heavy composites (#224's measurement: pack 1, 11 hops, 30 validator requests per call), the saving is larger: two fewer crossings of main per hop.

## Why validation stays in a validator pool, not on the main thread

This is the decision of #152 (the reviewer, 2026-11-13), kept here: validation of a module-authored schema cannot be bounded by any check made beforehand. #152's measurements:
- `^(\w|a)+$` takes 62 s;
- a 1.2 KB `anyOf` compiles in 5.9 s;
- `uniqueItems` over 20000 items takes 24 s.

Synchronous JavaScript cannot be preempted. So such a schema on the main thread stalls every session and module. In the module's own worker, the module can switch its validation off (test/sandbox/41).

A validator runs no module code, has resource limits, and can be replaced when it stalls, with fairness and quarantine accounted on main. Its cost is round trips, which this design halves without moving validation anywhere.

#224's "(B)", skipping the round trip for an unconstrained schema, stays decided against: module bytes are deserialized only in a validator.

## Invariants kept

1. **Module bytes are deserialized only in a validator** (#185). Every module output, and every hop input from a module, is decoded first in a validator.
2. **A module's worker never sees an unvalidated input, and never runs a call main refused.**
3. **Main alone decides each call's answer**, its billing, its per-call token, the declared-call checks and the size caps. A validator decides only "this value passes this schema"; a worker decides only its handler's result. Main answers each call once.
4. **A validator never receives the call token, the caller's ctx or the usage id** (F5, #274).
   - Hop inputs already cross as bytes alone: main sends ctx and token to the worker beside them, never to the validator.
   - So the pair messages below are tagged with a fresh per-call nonce, not the call token. The token stays a credential only main and the worker hold.
5. **The pool's guarantees:** fairness across modules; deadlines from queueing; strikes, quarantine and replacement on a stall, all on main.

## Design

### Ports

- **A pair:** a MessageChannel per (validator slot, module worker). Main makes it on first use and transfers one end to each side (`{type: 'pair', worker}` and `{type: 'pair', validator: slot}`).
- **When a pair ends:** when either side is replaced or ends, main closes both ends. The calls in flight on it are answered by the paths in "Failure modes".
- **The tag:** each call that uses a pair carries `tag`, 16 random bytes from main. It means nothing outside its pair and its call.

### The input: main → validator → worker

1. Main posts two messages, back to back:
   - to the worker, the call's announcement: today's invoke-action message without `args.input`, plus `tag`, `via: <slot>` and `forwardBy`. It keeps everything else, ctx and token included.
   - to the validator, the check: `{type: 'check', id, key, serviceID, actionName, which: 'input', value | buffer, tag, forward: <worker>, forwardBy, outputCap}`. The value is F5's view; a hop's is its bytes.

   `forwardBy` is the request's validation deadline, on `process.hrtime`, which every thread of the process shares.
2. The validator checks as today. On a pass, with `now < forwardBy`, it posts in this order:
   - its verdict to main: `{type: 'answer', id, refused: null, at: now, forwarded: true}`;
   - then the value to the worker's pair: `{tag, input}`. A hop's bytes are transferred: they are the validated bytes, never re-encoded.

   On a refusal, or past `forwardBy`, it posts only its verdict.
3. The worker runs the handler only when it holds both:
   - main's announcement;
   - a pair message with that tag, arriving on the pair of the announcement's `via` before `forwardBy` (checked on arrival).

   Anything else on the pair is dropped and counted, never answered:
   - an unknown, used or late tag;
   - another slot's pair;
   - a second message for a tag.
4. Main honours a pass only if its `at` is before `forwardBy`.
   - **A stamped pass arriving late:** it counts if it arrives by `forwardBy` + 50 ms.
   - **No stamped pass by then:** main refuses `VALIDATION_TIMEOUT` (today's code and text) and posts `{command: 'cancel', tag}` to the worker.
   - **Why a refused call never runs:** the validator forwards only before `forwardBy`, and the worker accepts only before it. So a refused call has never run, and a call that runs was never refused.

### The output: worker → validator → main

1. **The output's validator is the input's, `via`.** Homes and compiled actions stay where they are. Output load follows the input dispatch, which main made fair.
2. **The worker:**
   - It serializes the handler's result, as today (lean step 2).
   - It posts the bytes, transferred, on the pair as `{tag, bytes}`.
   - It posts main a small `{command: 'output-sent', id, byteLength}`. This is in parallel, off the critical path. Main starts the output check's deadline from it, and counts the check against `via` for fairness and strikes, as for a request it dispatched.
3. **The validator:**
   - It refuses before decoding when `byteLength > outputCap`. The cap is main's, from main's own check message, never from the worker.
   - Otherwise it decodes and validates, and posts `{type: 'answer', id, refused, buffer}` with the bytes transferred on a pass.
4. **Main** re-checks the length (defence in depth), bills, and answers.
5. **A handler's error** is not a value to validate. It goes worker → main, as today.

### Hops (#224)

Hop inputs and outputs take the same two paths, with the callee's or the caller's worker on the pair.

Main still does exactly what it does now:
- authorizes the match;
- mints and checks the per-call token;
- bills each hop;
- checks the declared calls.

Only the bytes' route changes:
- the callee gets its checked input from the validator;
- the caller gets the checked output from the validator, not from main.

### What may cross a pair, and nothing else

| From | To | What | When |
|---|---|---|---|
| validator | worker | `{tag, input}` | once per tag, after a pass, before `forwardBy` |
| worker | validator | `{tag, bytes}` | once per tag, for a tag that validator forwarded, within the cap |

Each side drops and counts anything else.
- **A worker flooding its pair** gets nothing. The validator keeps at most as many pending tags as main announced on that pair, and reads nothing beyond them.
- **A validator** holds no state for a tag it did not forward.

## Failure modes: one answer, always from main

| Event | What happens |
|---|---|
| The validator ends before its verdict | Main's "its end" path refuses as today and posts `cancel`. The worker never got the input: nothing is forwarded before the verdict is posted. |
| The validator ends after its verdict, before the forward | Main has a pass. The worker never runs; main answers at the call's own timeout. |
| The forward arrived, then the validator ended | The handler runs. Its output finds the pair closed: the worker sends the bytes to main as today, and main validates through the pool. |
| The validator ends during the output check | Main's deadline from `output-sent` refuses as today, with a strike, as now. |
| The worker ends | `endWith` answers every pending call, as now; the validator's tags for that worker go with the pair. |
| A validator stalled near `forwardBy` | It either forwards before `forwardBy` (stamped; main honours it) or not at all. The case `forwardBy − 1 ms` is a test. |
| A late, duplicate or forged pair message | Dropped and counted. Main answers by `id`, once. |

## Tests the build must carry, each written to fail first

- One per row of the failure table.
- A worker that posts to its pair with a tag it was never given, or twice, or after `forwardBy`.
- A worker posting output bytes over `outputCap`: refused before the validator decodes them.
- A refused input whose handler never runs, including the stalled-validator race.
- tools/call and a hop each give the same answers as today across the existing suites (validation, sandbox, composition, direct-peer-channels).
- `--chainedValidation` off (the default until measured) is today's path.

## Measured saving and how it is checked

- **Expected:** −0.35 to −0.45 ms of wall per tools/call on this VM, from two fewer one-way hops plus main's re-dispatch; a few hundred µs at most on a quiet 4+ core machine. Hops save two crossings of main each.
- **Checked:** with the through-shim harness (`--sessionSocket`, ch-shim, A against S), before and after, in alternating runs. Then pack 1 for hops.

## Cost and risk

- **Size:** about 400 lines across validator-pool, validator-worker, lean-worker and device-manager, plus the tests.
- **Risk:** medium-high, concentrated in the deadline race, which the stamped `forwardBy` closes.
- **Flag:** off by default (`--chainedValidation`) until the measurement is in and the reviewer turns it on.
