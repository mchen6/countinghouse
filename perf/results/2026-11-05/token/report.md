Runs: 46, valid: 45. Models seen: claude-sonnet-5-5.
- A-f8x400-rgate:  INVALID per-turn output tokens unknown (no message_delta events)

| group | fixture | n | input | output | cacheWrite | cacheRead | total | costUsd | turns | toolCalls | wallS |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A | f2x100 | 3 | 10 [10–10] | 7696 [7631–8451] | 22163 [22038–23380] | 45207 [45100–46249] | 74951 [74904–78090] | 0.140 [0.140–0.151] | 6 [6–6] | 5 [5–5] | 44.1 [43.9–48.0] |
| A | f8x100 | 3 | 10 [10–10] | 30277 [29973–30975] | 81858 [81686–82829] | 120407 [120299–121451] | 232552 [231968–235265] | 0.523 [0.519–0.532] | 12 [12–12] | 11 [11–11] | 143.2 [142.5–146.2] |
| A | f8x400 | 3 | 26 [10–26] | 113131 [20132–113279] | 307077 [165181–313283] | 2129911 [309671–2211104] | 2556499 [494994–2631338] | 2.124 [0.649–2.132] | 20 [12–26] | 19 [11–25] | 553.0 [119.0–566.2] |
| B | f2x100 | 3 | 4 [4–4] | 890 [864–922] | 4274 [4270–4275] | 5740 [5738–5742] | 10909 [10876–10942] | 0.024 [0.023–0.024] | 2 [2–2] | 1 [1–1] | 9.8 [9.1–10.4] |
| B | f8x100 | 3 | 4 [4–4] | 933 [900–938] | 5279 [5274–5279] | 5740 [5738–5740] | 11949 [11923–11961] | 0.026 [0.026–0.027] | 2 [2–2] | 1 [1–1] | 10.2 [9.8–10.4] |
| B | f8x400 | 3 | 4 [4–4] | 907 [849–963] | 5284 [5279–5284] | 5740 [5738–5740] | 11928 [11877–11991] | 0.026 [0.026–0.027] | 2 [2–2] | 1 [1–1] | 11.4 [9.9–13.6] |
| CD | none | 3 | 2 [2–2] | 4 [4–4] | 2583 [2583–2583] | 3297 [3297–3297] | 5886 [5886–5886] | 0.011 [0.011–0.011] | 1 [1–1] | 0 [0–0] | 3.7 [3.1–5.2] |
| C | none | 3 | 2 [2–2] | 4 [4–4] | 2185 [2183–2185] | 1753 [1753–1753] | 3944 [3942–3944] | 0.009 [0.009–0.009] | 1 [1–1] | 0 [0–0] | 3.2 [3.0–3.7] |
| D1 | f2x100 | 3 | 10 [10–10] | 1434 [1407–1643] | 7271 [7248–9303] | 31794 [31752–35804] | 40653 [40509–46524] | 0.042 [0.040–0.045] | 5 [5–5] | 4 [4–4] | 17.6 [16.7–19.8] |
| D1 | f8x100 | 3 | 10 [10–10] | 1576 [1478–1581] | 7357 [7111–7438] | 31875 [31875–32181] | 40878 [40720–40904] | 0.041 [0.040–0.042] | 5 [5–5] | 4 [4–4] | 17.5 [16.7–18.5] |
| D1 | f8x400 | 3 | 10 [10–10] | 1391 [1381–1509] | 7007 [6981–7498] | 31875 [31860–31885] | 40268 [40247–40902] | 0.039 [0.038–0.041] | 5 [5–5] | 4 [4–4] | 15.9 [15.9–17.4] |
| D2 | f2x100 | 3 | 10 [10–12] | 1668 [1459–1978] | 7140 [6259–10903] | 29705 [29415–39322] | 41996 [37433–48452] | 0.046 [0.037–0.056] | 5 [5–6] | 4 [4–5] | 20.7 [17.9–22.5] |
| D2 | f8x100 | 3 | 12 [10–12] | 1791 [1576–1980] | 7458 [6314–7479] | 38315 [29670–39569] | 47576 [37570–49040] | 0.044 [0.038–0.046] | 6 [5–6] | 5 [4–5] | 20.8 [19.7–23.3] |
| D2 | f8x400 | 3 | 12 [12–14] | 1985 [1955–2479] | 7080 [6687–21058] | 39766 [39117–56939] | 48843 [47771–80490] | 0.045 [0.044–0.092] | 6 [6–7] | 5 [5–6] | 25.2 [22.2–27.4] |

Later batch, run after the matrix's last run (2026-11-06T03:29:42.104Z), so its prompt-cache conditions differ from the matrix's rotated order: D2-f2x100-r1, D2-f2x100-r2, D2-f2x100-r3, D2-f8x400-r1, D2-f8x400-r2, D2-f8x400-r3. D1 runs with a named rep in the same batch are the same-conditions check ("outside the cells" table).

Outlier: D2-f8x400-r2 total 80490 (cost 0.0920 USD, cacheWrite 21058) is over 1.5× its cell's median total 48843; it sets the cell's upper range, not its median.

| ratio | fixture | metric | median ratio | verdict |
|---|---|---|---|---|
| A/B | f2x100 | input | 2.50 | A costs more |
| A/B | f2x100 | output | 8.65 | A costs more |
| A/B | f2x100 | cacheWrite | 5.19 | A costs more |
| A/B | f2x100 | cacheRead | 7.88 | A costs more |
| A/B | f2x100 | total | 6.87 | A costs more |
| A/B | f2x100 | costUsd | 5.95 | A costs more |
| A/B | f8x100 | input | 2.50 | A costs more |
| A/B | f8x100 | output | 32.45 | A costs more |
| A/B | f8x100 | cacheWrite | 15.51 | A costs more |
| A/B | f8x100 | cacheRead | 20.98 | A costs more |
| A/B | f8x100 | total | 19.46 | A costs more |
| A/B | f8x100 | costUsd | 19.77 | A costs more |
| A/B | f8x400 | input | 6.50 | A costs more |
| A/B | f8x400 | output | 124.73 | A costs more |
| A/B | f8x400 | cacheWrite | 58.11 | A costs more |
| A/B | f8x400 | cacheRead | 371.06 | A costs more |
| A/B | f8x400 | total | 214.33 | A costs more |
| A/B | f8x400 | costUsd | 81.06 | A costs more |
| D1/B | f2x100 | input | 2.50 | D1 costs more |
| D1/B | f2x100 | output | 1.61 | D1 costs more |
| D1/B | f2x100 | cacheWrite | 1.70 | D1 costs more |
| D1/B | f2x100 | cacheRead | 5.54 | D1 costs more |
| D1/B | f2x100 | total | 3.73 | D1 costs more |
| D1/B | f2x100 | costUsd | 1.77 | D1 costs more |
| D1/B | f8x100 | input | 2.50 | D1 costs more |
| D1/B | f8x100 | output | 1.69 | D1 costs more |
| D1/B | f8x100 | cacheWrite | 1.39 | D1 costs more |
| D1/B | f8x100 | cacheRead | 5.55 | D1 costs more |
| D1/B | f8x100 | total | 3.42 | D1 costs more |
| D1/B | f8x100 | costUsd | 1.54 | D1 costs more |
| D1/B | f8x400 | input | 2.50 | D1 costs more |
| D1/B | f8x400 | output | 1.53 | D1 costs more |
| D1/B | f8x400 | cacheWrite | 1.33 | D1 costs more |
| D1/B | f8x400 | cacheRead | 5.55 | D1 costs more |
| D1/B | f8x400 | total | 3.38 | D1 costs more |
| D1/B | f8x400 | costUsd | 1.47 | D1 costs more |
| D2/D1 | f2x100 | input | 1.00 | within noise |
| D2/D1 | f2x100 | output | 1.16 | within noise |
| D2/D1 | f2x100 | cacheWrite | 0.98 | within noise |
| D2/D1 | f2x100 | cacheRead | 0.93 | within noise |
| D2/D1 | f2x100 | total | 1.03 | within noise |
| D2/D1 | f2x100 | costUsd | 1.09 | within noise |
| D2/D1 | f8x100 | input | 1.20 | within noise |
| D2/D1 | f8x100 | output | 1.14 | within noise |
| D2/D1 | f8x100 | cacheWrite | 1.01 | within noise |
| D2/D1 | f8x100 | cacheRead | 1.20 | within noise |
| D2/D1 | f8x100 | total | 1.16 | within noise |
| D2/D1 | f8x100 | costUsd | 1.09 | within noise |
| D2/D1 | f8x400 | input | 1.20 | D2 costs more |
| D2/D1 | f8x400 | output | 1.43 | D2 costs more |
| D2/D1 | f8x400 | cacheWrite | 1.01 | within noise |
| D2/D1 | f8x400 | cacheRead | 1.25 | D2 costs more |
| D2/D1 | f8x400 | total | 1.21 | D2 costs more |
| D2/D1 | f8x400 | costUsd | 1.18 | D2 costs more |

Valid runs that did not complete the task: A-f8x400-r1. Tables without them:

| group | fixture | n | input | output | cacheWrite | cacheRead | total | costUsd | turns | toolCalls | wallS |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A | f2x100 | 3 | 10 [10–10] | 7696 [7631–8451] | 22163 [22038–23380] | 45207 [45100–46249] | 74951 [74904–78090] | 0.140 [0.140–0.151] | 6 [6–6] | 5 [5–5] | 44.1 [43.9–48.0] |
| A | f8x100 | 3 | 10 [10–10] | 30277 [29973–30975] | 81858 [81686–82829] | 120407 [120299–121451] | 232552 [231968–235265] | 0.523 [0.519–0.532] | 12 [12–12] | 11 [11–11] | 143.2 [142.5–146.2] |
| A | f8x400 | 2 | 26 [26–26] | 113205 [113131–113279] | 310180 [307077–313283] | 2170508 [2129911–2211104] | 2593919 [2556499–2631338] | 2.128 [2.124–2.132] | 23 [20–26] | 22 [19–25] | 559.6 [553.0–566.2] |
| B | f2x100 | 3 | 4 [4–4] | 890 [864–922] | 4274 [4270–4275] | 5740 [5738–5742] | 10909 [10876–10942] | 0.024 [0.023–0.024] | 2 [2–2] | 1 [1–1] | 9.8 [9.1–10.4] |
| B | f8x100 | 3 | 4 [4–4] | 933 [900–938] | 5279 [5274–5279] | 5740 [5738–5740] | 11949 [11923–11961] | 0.026 [0.026–0.027] | 2 [2–2] | 1 [1–1] | 10.2 [9.8–10.4] |
| B | f8x400 | 3 | 4 [4–4] | 907 [849–963] | 5284 [5279–5284] | 5740 [5738–5740] | 11928 [11877–11991] | 0.026 [0.026–0.027] | 2 [2–2] | 1 [1–1] | 11.4 [9.9–13.6] |
| CD | none | 3 | 2 [2–2] | 4 [4–4] | 2583 [2583–2583] | 3297 [3297–3297] | 5886 [5886–5886] | 0.011 [0.011–0.011] | 1 [1–1] | 0 [0–0] | 3.7 [3.1–5.2] |
| C | none | 3 | 2 [2–2] | 4 [4–4] | 2185 [2183–2185] | 1753 [1753–1753] | 3944 [3942–3944] | 0.009 [0.009–0.009] | 1 [1–1] | 0 [0–0] | 3.2 [3.0–3.7] |
| D1 | f2x100 | 3 | 10 [10–10] | 1434 [1407–1643] | 7271 [7248–9303] | 31794 [31752–35804] | 40653 [40509–46524] | 0.042 [0.040–0.045] | 5 [5–5] | 4 [4–4] | 17.6 [16.7–19.8] |
| D1 | f8x100 | 3 | 10 [10–10] | 1576 [1478–1581] | 7357 [7111–7438] | 31875 [31875–32181] | 40878 [40720–40904] | 0.041 [0.040–0.042] | 5 [5–5] | 4 [4–4] | 17.5 [16.7–18.5] |
| D1 | f8x400 | 3 | 10 [10–10] | 1391 [1381–1509] | 7007 [6981–7498] | 31875 [31860–31885] | 40268 [40247–40902] | 0.039 [0.038–0.041] | 5 [5–5] | 4 [4–4] | 15.9 [15.9–17.4] |
| D2 | f2x100 | 3 | 10 [10–12] | 1668 [1459–1978] | 7140 [6259–10903] | 29705 [29415–39322] | 41996 [37433–48452] | 0.046 [0.037–0.056] | 5 [5–6] | 4 [4–5] | 20.7 [17.9–22.5] |
| D2 | f8x100 | 3 | 12 [10–12] | 1791 [1576–1980] | 7458 [6314–7479] | 38315 [29670–39569] | 47576 [37570–49040] | 0.044 [0.038–0.046] | 6 [5–6] | 5 [4–5] | 20.8 [19.7–23.3] |
| D2 | f8x400 | 3 | 12 [12–14] | 1985 [1955–2479] | 7080 [6687–21058] | 39766 [39117–56939] | 48843 [47771–80490] | 0.045 [0.044–0.092] | 6 [6–7] | 5 [5–6] | 25.2 [22.2–27.4] |

Later batch, run after the matrix's last run (2026-11-06T03:29:42.104Z), so its prompt-cache conditions differ from the matrix's rotated order: D2-f2x100-r1, D2-f2x100-r2, D2-f2x100-r3, D2-f8x400-r1, D2-f8x400-r2, D2-f8x400-r3. D1 runs with a named rep in the same batch are the same-conditions check ("outside the cells" table).

Outlier: D2-f8x400-r2 total 80490 (cost 0.0920 USD, cacheWrite 21058) is over 1.5× its cell's median total 48843; it sets the cell's upper range, not its median.

| ratio | fixture | metric | median ratio | verdict |
|---|---|---|---|---|
| A/B | f2x100 | input | 2.50 | A costs more |
| A/B | f2x100 | output | 8.65 | A costs more |
| A/B | f2x100 | cacheWrite | 5.19 | A costs more |
| A/B | f2x100 | cacheRead | 7.88 | A costs more |
| A/B | f2x100 | total | 6.87 | A costs more |
| A/B | f2x100 | costUsd | 5.95 | A costs more |
| A/B | f8x100 | input | 2.50 | A costs more |
| A/B | f8x100 | output | 32.45 | A costs more |
| A/B | f8x100 | cacheWrite | 15.51 | A costs more |
| A/B | f8x100 | cacheRead | 20.98 | A costs more |
| A/B | f8x100 | total | 19.46 | A costs more |
| A/B | f8x100 | costUsd | 19.77 | A costs more |
| A/B | f8x400 | input | 6.50 | A costs more |
| A/B | f8x400 | output | 124.81 | A costs more |
| A/B | f8x400 | cacheWrite | 58.70 | A costs more |
| A/B | f8x400 | cacheRead | 378.14 | A costs more |
| A/B | f8x400 | total | 217.46 | A costs more |
| A/B | f8x400 | costUsd | 81.23 | A costs more |
| D1/B | f2x100 | input | 2.50 | D1 costs more |
| D1/B | f2x100 | output | 1.61 | D1 costs more |
| D1/B | f2x100 | cacheWrite | 1.70 | D1 costs more |
| D1/B | f2x100 | cacheRead | 5.54 | D1 costs more |
| D1/B | f2x100 | total | 3.73 | D1 costs more |
| D1/B | f2x100 | costUsd | 1.77 | D1 costs more |
| D1/B | f8x100 | input | 2.50 | D1 costs more |
| D1/B | f8x100 | output | 1.69 | D1 costs more |
| D1/B | f8x100 | cacheWrite | 1.39 | D1 costs more |
| D1/B | f8x100 | cacheRead | 5.55 | D1 costs more |
| D1/B | f8x100 | total | 3.42 | D1 costs more |
| D1/B | f8x100 | costUsd | 1.54 | D1 costs more |
| D1/B | f8x400 | input | 2.50 | D1 costs more |
| D1/B | f8x400 | output | 1.53 | D1 costs more |
| D1/B | f8x400 | cacheWrite | 1.33 | D1 costs more |
| D1/B | f8x400 | cacheRead | 5.55 | D1 costs more |
| D1/B | f8x400 | total | 3.38 | D1 costs more |
| D1/B | f8x400 | costUsd | 1.47 | D1 costs more |
| D2/D1 | f2x100 | input | 1.00 | within noise |
| D2/D1 | f2x100 | output | 1.16 | within noise |
| D2/D1 | f2x100 | cacheWrite | 0.98 | within noise |
| D2/D1 | f2x100 | cacheRead | 0.93 | within noise |
| D2/D1 | f2x100 | total | 1.03 | within noise |
| D2/D1 | f2x100 | costUsd | 1.09 | within noise |
| D2/D1 | f8x100 | input | 1.20 | within noise |
| D2/D1 | f8x100 | output | 1.14 | within noise |
| D2/D1 | f8x100 | cacheWrite | 1.01 | within noise |
| D2/D1 | f8x100 | cacheRead | 1.20 | within noise |
| D2/D1 | f8x100 | total | 1.16 | within noise |
| D2/D1 | f8x100 | costUsd | 1.09 | within noise |
| D2/D1 | f8x400 | input | 1.20 | D2 costs more |
| D2/D1 | f8x400 | output | 1.43 | D2 costs more |
| D2/D1 | f8x400 | cacheWrite | 1.01 | within noise |
| D2/D1 | f8x400 | cacheRead | 1.25 | D2 costs more |
| D2/D1 | f8x400 | total | 1.21 | D2 costs more |
| D2/D1 | f8x400 | costUsd | 1.18 | D2 costs more |

C fixed overhead per turn (first-turn prompt tokens): 3940 [3938–3940]; C cost: 0.009 [0.009–0.009] USD; output: 4 [4–4]; cacheRead: 1753 [1753–1753].
CD fixed overhead per turn (first-turn prompt tokens): 5882 [5882–5882]; CD cost: 0.011 [0.011–0.011] USD; output: 4 [4–4]; cacheRead: 3297 [3297–3297].

API responses = distinct assistant message ids: one model request each, so parallel tool calls in one response count once (`turns` above is Claude Code's num_turns, which counts differently).

| group | fixture | control | API responses (median) | total (median) | responses × control prompt | total − responses × control prompt (approx.) | share |
|---|---|---|---|---|---|---|---|
| A | f2x100 | C | 5 | 74951 | 19700 | 55251 | 74% |
| A | f8x100 | C | 5 | 232552 | 19700 | 212852 | 92% |
| A | f8x400 | C | 13 | 2556499 | 51220 | 2505279 | 98% |
| B | f2x100 | C | 2 | 10909 | 7880 | 3029 | 28% |
| B | f8x100 | C | 2 | 11949 | 7880 | 4069 | 34% |
| B | f8x400 | C | 2 | 11928 | 7880 | 4048 | 34% |
| D1 | f2x100 | CD | 5 | 40653 | 29410 | 11243 | 28% |
| D1 | f8x100 | CD | 5 | 40878 | 29410 | 11468 | 28% |
| D1 | f8x400 | CD | 5 | 40268 | 29410 | 10858 | 27% |
| D2 | f2x100 | CD | 5 | 41996 | 29410 | 12586 | 30% |
| D2 | f8x100 | CD | 6 | 47576 | 35292 | 12284 | 26% |
| D2 | f8x400 | CD | 6 | 48843 | 35292 | 13551 | 28% |

| group | first-turn prompt tokens (min–max) | init tools |
|---|---|---|
| A | 4516–4522 | mcp__ch__error_cluster_clusterservice_cluster,mcp__ch__log_read_readservice_list,mcp__ch__log_read_readservice_read,mcp__ch__pii_redact_redactservice_redact |
| B | 3987–3991 | mcp__ch__log_triage_triageservice_triage |
| C | 3938–3940 | mcp__ch__log_triage_triageservice_triage |
| D1 | 5929–5933 | Bash,Glob,Read |
| D2 | 5930–5935 | Bash,Glob,Read |
| CD | 5882–5882 | Bash,Glob,Read |

| run (outside the cells) | total | cell median total | costUsd | cell median costUsd | WARN/ERROR ok |
|---|---|---|---|---|---|
| D1-f2x100-rb1 | 41440 | 40653 | 0.0434 | 0.0417 | true |
| D1-f8x100-rb1 | 40575 | 40878 | 0.0405 | 0.0407 | true |
| D1-f8x400-rb1 | 40610 | 40268 | 0.0394 | 0.0386 | true |

| group | fixture | runs with planted values in context | planted values in context (of 10), per run | runs with planted values in the answer |
|---|---|---|---|---|
| A | f2x100 | 3/3 | 10, 10, 10 | 0/3 |
| A | f8x100 | 3/3 | 10, 10, 10 | 0/3 |
| A | f8x400 | 3/3 | 10, 10, 10 | 2/3 |
| B | f2x100 | 0/3 | 0, 0, 0 | 0/3 |
| B | f8x100 | 0/3 | 0, 0, 0 | 0/3 |
| B | f8x400 | 0/3 | 0, 0, 0 | 0/3 |
| D1 | f2x100 | 0/3 | 0, 0, 0 | 0/3 |
| D1 | f8x100 | 0/3 | 0, 0, 0 | 0/3 |
| D1 | f8x400 | 0/3 | 0, 0, 0 | 0/3 |
| D2 | f2x100 | 0/3 | 0, 0, 0 | 0/3 |
| D2 | f8x100 | 3/3 | 3, 2, 5 | 0/3 |
| D2 | f8x400 | 3/3 | 2, 3, 2 | 1/3 |

| run | WARN ok | ERROR ok | top-5 named / counts shown | files missing | files not fully redacted | cluster lines not from redact | raw planted lines to cluster | planted values in answer | compactions |
|---|---|---|---|---|---|---|---|---|---|
| A-f2x100-r1 | true | true | 5/5 | 0 | 0 | 0 | 0 | 0 | 0 |
| A-f2x100-r2 | true | true | 5/5 | 0 | 0 | 0 | 0 | 0 | 0 |
| A-f2x100-r3 | true | true | 5/5 | 0 | 0 | 0 | 0 | 0 | 0 |
| A-f8x100-r1 | true | true | 5/5 | 0 | 0 | 0 | 0 | 0 | 0 |
| A-f8x100-r2 | true | true | 5/5 | 0 | 0 | 0 | 0 | 0 | 0 |
| A-f8x100-r3 | true | true | 5/5 | 0 | 0 | 0 | 0 | 0 | 0 |
| A-f8x400-r1 | false | false | 5/0 | 0 | 7 | 0 | 0 | 1 | 0 |
| A-f8x400-r2 | true | true | 5/5 | 0 | 0 | 0 | 0 | 1 | 0 |
| A-f8x400-r3 | true | true | 5/5 | 0 | 0 | 0 | 0 | 0 | 0 |
| A-f8x400-rgate | true | true | 5/5 | 0 | 0 | 0 | 0 | 0 | 0 |
| B-f2x100-r1 | true | true | 5/5 | - | - | - | - | 0 | 0 |
| B-f2x100-r2 | true | true | 5/5 | - | - | - | - | 0 | 0 |
| B-f2x100-r3 | true | true | 5/5 | - | - | - | - | 0 | 0 |
| B-f8x100-r1 | true | true | 5/5 | - | - | - | - | 0 | 0 |
| B-f8x100-r2 | true | true | 5/5 | - | - | - | - | 0 | 0 |
| B-f8x100-r3 | true | true | 5/5 | - | - | - | - | 0 | 0 |
| B-f8x400-r1 | true | true | 5/5 | - | - | - | - | 0 | 0 |
| B-f8x400-r2 | true | true | 5/5 | - | - | - | - | 0 | 0 |
| B-f8x400-r3 | true | true | 5/5 | - | - | - | - | 0 | 0 |
| D1-f2x100-r1 | true | true | 5/5 | 0 | 0 | 0 | 0 | 0 | 0 |
| D1-f2x100-r2 | true | true | 5/5 | 0 | 0 | 0 | 0 | 0 | 0 |
| D1-f2x100-r3 | true | true | 5/5 | 0 | 0 | 0 | 0 | 0 | 0 |
| D1-f2x100-rb1 | true | true | 5/5 | 0 | 0 | 0 | 0 | 0 | 0 |
| D1-f8x100-r1 | true | true | 5/5 | 0 | 0 | 0 | 0 | 0 | 0 |
| D1-f8x100-r2 | true | true | 5/5 | 0 | 0 | 0 | 0 | 0 | 0 |
| D1-f8x100-r3 | true | true | 5/5 | 0 | 0 | 0 | 0 | 0 | 0 |
| D1-f8x100-rb1 | true | true | 5/5 | 0 | 0 | 0 | 0 | 0 | 0 |
| D1-f8x400-r1 | true | true | 5/5 | 0 | 0 | 0 | 0 | 0 | 0 |
| D1-f8x400-r2 | true | true | 5/5 | 0 | 0 | 0 | 0 | 0 | 0 |
| D1-f8x400-r3 | true | true | 5/5 | 0 | 0 | 0 | 0 | 0 | 0 |
| D1-f8x400-rb1 | true | true | 5/5 | 0 | 0 | 0 | 0 | 0 | 0 |
| D2-f2x100-r1 | true | true | 5/5 | 0 | 0 | 0 | 0 | 0 | 0 |
| D2-f2x100-r2 | true | true | 5/5 | 0 | 0 | 0 | 0 | 0 | 0 |
| D2-f2x100-r3 | true | true | 5/5 | 0 | 0 | 0 | 0 | 0 | 0 |
| D2-f8x100-r1 | true | true | 5/5 | 0 | 0 | 0 | 0 | 0 | 0 |
| D2-f8x100-r2 | true | true | 5/5 | 0 | 0 | 0 | 0 | 0 | 0 |
| D2-f8x100-r3 | true | true | 5/5 | 0 | 0 | 0 | 0 | 0 | 0 |
| D2-f8x400-r1 | true | true | 5/5 | 0 | 0 | 0 | 0 | 1 | 0 |
| D2-f8x400-r2 | true | true | 5/5 | 0 | 0 | 0 | 0 | 0 | 0 |
| D2-f8x400-r3 | true | true | 5/5 | 0 | 0 | 0 | 0 | 0 | 0 |

| run | output tokens | in responses calling redact/cluster | share | argument bytes written |
|---|---|---|---|---|
| A-f2x100-r1 | 8451 | 6960 | 82% | 13830 |
| A-f2x100-r2 | 7631 | 6173 | 81% | 12568 |
| A-f2x100-r3 | 7696 | 6297 | 82% | 12434 |
| A-f8x100-r1 | 30975 | 29246 | 94% | 57758 |
| A-f8x100-r2 | 30277 | 28272 | 93% | 57758 |
| A-f8x100-r3 | 29973 | 28102 | 94% | 57758 |
| A-f8x400-r1 | 20132 | 17598 | 87% | 28584 |
| A-f8x400-r2 | 113131 | 110266 | 97% | 216957 |
| A-f8x400-r3 | 113279 | 109944 | 97% | 217091 |
| A-f8x400-rgate | 111088 | n/a (no per-turn data) | n/a | 216851 |

other shell = Bash commands that are not node: read-only commands inside the working directory (ls, cat, head), which Claude Code allows without a rule; anything else is refused.

| run | read types.d.ts | node runs | stdout bytes per run | log lines printed (masked or not) | runs printing a planted value | exploration runs before cluster (stdout bytes / output tokens) | fields not in Output | other shell |
|---|---|---|---|---|---|---|---|---|
| D1-f2x100-r1 | true | 2 | 102, 3592 | 8 | 0 | 1 (102 / 128) | none | 2 |
| D1-f2x100-r2 | true | 2 | 102, 3591 | 8 | 0 | 1 (102 / 128) | none | 2 |
| D1-f2x100-r3 | true | 2 | 102, 3591 | 8 | 0 | 1 (102 / 127) | none | 2 |
| D1-f2x100-rb1 | true | 2 | 102, 4592 | 25 | 0 | 1 (102 / 182) | none | 2 |
| D1-f8x100-r1 | true | 2 | 312, 3491 | 8 | 0 | 1 (312 / 128) | none | 2 |
| D1-f8x100-r2 | true | 4 | 101, 4332, 312, 2869 | 0 | 0 | 3 (4745 / 368) | none | 0 |
| D1-f8x100-r3 | true | 2 | 312, 3672 | 10 | 0 | 1 (312 / 128) | none | 2 |
| D1-f8x100-rb1 | true | 2 | 312, 2885 | 0 | 0 | 1 (312 / 128) | none | 2 |
| D1-f8x400-r1 | true | 2 | 320, 3825 | 10 | 0 | 1 (320 / 127) | none | 2 |
| D1-f8x400-r2 | true | 2 | 320, 2882 | 0 | 0 | 1 (320 / 128) | none | 2 |
| D1-f8x400-r3 | true | 2 | 320, 2882 | 0 | 0 | 1 (320 / 127) | none | 2 |
| D1-f8x400-rb1 | true | 2 | 320, 3483 | 0 | 0 | 1 (320 / 128) | none | 2 |
| D2-f2x100-r1 | true | 2 | 143, 3526 | 5 | 0 | 1 (143 / 113) | matches | 2 |
| D2-f2x100-r2 | true | 2 | 143, 3396 | 5 | 0 | 1 (143 / 132) | none | 2 |
| D2-f2x100-r3 | true | 3 | 143, 3341, 862 | 15 | 0 | 1 (143 / 134) | none | 2 |
| D2-f8x100-r1 | true | 3 | 449, 3489, 1009 | 17 | 1 | 1 (449 / 132) | none | 2 |
| D2-f8x100-r2 | true | 2 | 449, 3328 | 5 | 1 | 1 (449 / 113) | none | 2 |
| D2-f8x100-r3 | true | 3 | 449, 1500, 3523 | 25 | 1 | 2 (1949 / 281) | none | 2 |
| D2-f8x400-r1 | true | 3 | 457, 3556, 125 | 7 | 1 | 1 (457 / 132) | none | 2 |
| D2-f8x400-r2 | true | 4 | 457, 3912, 19816, 343 | 23 | 1 | 1 (457 / 131) | none | 2 |
| D2-f8x400-r3 | true | 3 | 457, 3143, 125 | 3 | 1 | 1 (457 / 113) | none | 2 |
