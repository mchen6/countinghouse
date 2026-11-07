# What log-triage costs in model tokens, four ways

Measured 2026-11-05/06 at `622438f` with `claude -p` (Claude Code 2.1.318,
`--model sonnet`, which resolved to `claude-sonnet-5-5` in every run), on the
maintainer's 2-vCPU VM. 46 runs, all of them with stream-json transcripts,
plus the generated report, in
[`perf/results/2026-11-05/token/`](../../perf/results/2026-11-05/token/report.md).
Scripts: `perf/token-cost-compare.js` (run, report, scrub) and
`perf/gen-code-mode-wrappers.js` (the code-mode library). Total spend: $10.57.

The question: what does the same triage task cost in tokens when the model
chains the leaf tools itself, when it calls the composite once, and when it
scripts the leaf tools as code?

## The four ways, and two controls

All groups use the same user prompt:

> Triage the logs in `<dir>`: give the number of warnings and errors, and the
> top clusters of similar messages. Secrets in the logs must be redacted
> before clustering.

| group | what the model has |
|---|---|
| **A** | The four leaf tools (`list`, `read`, `redact`, `cluster`) as MCP tools; it chains them itself. |
| **B** | Only the composite `log_triage_triageservice_triage`. |
| **C** | B's configuration with the prompt "Reply with OK.": the fixed cost of one turn. |
| **D1** | Code mode: no MCP tools, but a generated Node library in `./servers/log-triage/` (one function per leaf tool, calling `tools/call` over HTTP) with `.d.ts` types for inputs **and outputs**; Bash restricted to `node`, plus Read/Glob in the working directory. |
| **D2** | D1 without the output types: `@returns {Promise<unknown>}` plus the tool's description, like an MCP server with no `outputSchema`. |
| **CD** | D's configuration with "Reply with OK.". |

Matrix: A, B and D1 at 2 files × 100 lines, 8 × 100 and 8 × 400, three reps
each, interleaved, with the group order rotating per rep; C and CD three times;
D2 at all three sizes (8 × 100 in the matrix, the others in a later batch, see
below). Every run went through a logging proxy that recorded, per call, derived
facts only: tool, file, line counts, hashes, and whether a planted value reached
`cluster`. It never recorded log lines or request headers.

**Isolation.** countinghouse, Redis and the log fixtures ran in a container.
The fixtures were generated inside the image with a random seed that was never
printed or stored, so the host user running `claude` could neither read them
(`ENOENT`; `/var/lib/docker` is `EACCES`) nor regenerate them from the repo's
seeded generator. The port was published on `127.0.0.1` only, and the only
mount was a read-only auth file. Every transcript was scanned for tool calls
reaching outside the working directory; none that ran did.

**The D hint.** With the user prompt alone, D never found `./servers/`.
D groups therefore get an appended system prompt, the code-mode counterpart of
A/B's tool definitions. It was iterated three times on 2 × 100 checks;
A/B's prompt was never tuned. Read the D numbers as "D with a tuned
environment hint":

1. "The MCP tools available to you are provided as a Node.js library in
   ./servers/ (one directory per MCP server, one .js file per tool, with a
   README.md and types.d.ts). Use them by writing and running Node.js scripts;
   the functions read their credentials from the CH_PERF_KEY environment
   variable, which is already set." — the model ran `ls /data/...` (denied),
   then Glob (denied), and gave up.
2. \+ "Files and directories named in a request are on the MCP server, not on
   this machine: reach them through these functions." — it found the library,
   but saved its script with `cat > file` (denied) and gave up.
3. \+ "Bash here runs only `node` commands (for example `node -e '...'` or
   `node <<'EOF' ... EOF`); other shell commands and redirection are refused."
   — final; D1 and D2 both completed the task.

## Results

### Privacy first

The fixtures plant 10 fake sensitive values (test card number, `example.com`
addresses, `203.0.113.0/24` addresses, `555` phone numbers, a demo bearer
token). Matrix reps, plus the later D2 batch:

| group | planted values in the model's context | in the final answer |
|---|---|---|
| A | 10 of 10, in every run (`read` returns raw lines by design) | 2 of 3 runs at 8 × 400 |
| B | 0 | 0 |
| D1 | 0, in 12 of 12 runs | 0 |
| D2 | 0/3 runs at 2 × 100, 3/3 at 8 × 100, 3/3 at 8 × 400 | 1 of 3 runs at 8 × 400 |

D2 leaked because it probed the result shape: in 9 of 9 runs it printed
`Object.keys(r)` and a slice of a `read()` result, raw lines included. D1,
which had the types, never printed a `read()` sample; it printed the `list()`
result (file names) and the `cluster()` result (already masked). One D2 run
also guessed a field that exists in no output type (`red.counts||red.matches`).

### Cost

Median cost per run in USD, with [min–max] over three reps. Ratios are of
medians; "more/less" is said only where the two ranges do not overlap, and is
otherwise "within noise". Table "all valid runs":

| | 2 × 100 | 8 × 100 | 8 × 400 |
|---|---|---|---|
| A (leaf chain) | 0.140 [0.140–0.151] | 0.523 [0.519–0.532] | 2.124 [0.649–2.132] |
| B (composite) | 0.024 [0.023–0.024] | 0.026 [0.026–0.027] | 0.026 [0.026–0.027] |
| D1 (code, typed) | 0.042 [0.040–0.045] | 0.041 [0.040–0.042] | 0.039 [0.038–0.041] |
| D2 (code, untyped) | 0.046 [0.037–0.056] | 0.044 [0.038–0.046] | 0.045 [0.044–0.092] |
| A/B | ×5.95, A costs more | ×19.77, A costs more | ×81.06, A costs more |
| D1/B | ×1.77, D1 costs more | ×1.54, D1 costs more | ×1.47, D1 costs more |
| D2/D1 | ×1.09, within noise | ×1.09, within noise | ×1.18, D2 costs more |

The table "complete runs only" leaves out A-f8x400-r1 (see below): A at
8 × 400 becomes $2.128 [2.124–2.132], and A/B becomes ×81.23. No verdict
changes between the two tables, and every A/B and D1/B verdict holds on
every token metric (input, output, cache write, cache read, total) as well
as on cost.

Fixed overhead: C's first-turn prompt is 3,940 tokens ($0.009 per run), CD's
5,882 ($0.011). As an approximation (a later turn's prompt is not the
control's one-turn prompt), A's total minus API responses × C's prompt
leaves 74% / 92% / 98% of A's tokens at the three sizes: A's cost is almost
all the data it moves.

### Where A's cost goes

Per-token prices **inferred** from the runs' `total_cost_usd` by an exact
least-squares fit (residual 3 × 10⁻¹⁵): $2/M input, $10/M output, $2.5/M
5-minute cache write, $4/M 1-hour cache write, $0.1/M cache read. With them,
the median run of A at 8 × 400 (A-f8x400-r2, $2.12) splits into output
$1.13, cache write $0.77, cache read $0.22, input ≈ $0. B's is $0.026 in all. So what the composite
saves is mostly output and cache writes. 97% of A's output tokens at 8 × 400
(93–94% at 8 × 100, 81–82% at 2 × 100) are in the responses that call
`redact` or `cluster`: the model writing log lines back out as tool
arguments, 217 KB of them per run at 8 × 400.

## Data quality: what to weigh

- **A-f8x400-r1 stopped after one file.** It wrote that it stopped "to stay
  inside the $5 budget": `--max-budget-usd 5`, which the harness set as a
  safety cap, is visible to the model. That was a configuration choice, not
  part of the task's specification. The run is valid but incomplete. It sets
  A's 8 × 400 lower range and is shown separately in the "complete runs
  only" table.
- **"Bash runs only node" is a simplification.** Read-only shell commands
  (`ls`, `cat`, `head`) inside the working directory were also auto-allowed,
  and `node -e` can read any file the OS lets it. The container was what
  isolated the fixtures.
- **A later batch.** D2 at 2 × 100 and 8 × 400 ran after the matrix, so its
  prompt-cache conditions differ from the matrix's rotated order. One fresh D1
  run per size in the same batch is the same-conditions check: 41,440 /
  40,575 / 40,610 total tokens, against matrix D1 medians of 40,653 / 40,878 /
  40,268.
- **An outlier.** D2-f8x400-r2 ($0.092, 21k cache write) is over 1.5 × its
  cell's median total. It sets that cell's upper range, not its median.
- The budget-gate run (A, 8 × 400, before the matrix) is excluded from the
  cells: it predates per-turn usage recording.

## At 622438f, before the MCP conformance fix

At the measured commit, MCP results carried the handler's wrapper:
`structuredContent` and the text block were `{"output": <result>}`, one level
above the advertised `outputSchema`. The D wrappers unwrapped
`structuredContent.output`, so D's types described what its functions really
returned. A follow-up investigation (not in the repo) checked whether the
wrapper affected the conclusions above:

- It is 11 bytes per tool result. Counted from the transcripts, it costs A
  about 0.02–0.07% of its tokens and B about 0.03–0.04% (≈ 4 tokens per
  result, an estimate). D sees none of it, because the wrappers strip it and
  no D script reads `.output`.
- The official MCP TypeScript SDK client (1.32.2) rejects every module tool's
  result at that commit with `-32602 Structured content does not match the
  tool's output schema`. Claude Code did not validate the result, which is
  why A and B worked.
- All three conclusions hold:
  1. Leaf chaining costs more than both, by a factor that grows with the
     data: A is ×5.95 / ×19.77 / ×81.06 the composite's cost and ×3.3 /
     ×12.8 / ×54.5 typed code mode's at the three sizes (medians, table
     "all valid runs").
  2. B is about 1.5–1.8 × cheaper than D1.
  3. Typed D1 did not need to probe and leaked nothing; untyped D2 probed
     and leaked.

  The third rests on the unwrapping rule. A wrapper returning the wrapped
  object would have handed D1 types that were off by one level, and that
  case was not measured.
