# Test ports

Each test that starts a server binds fixed ports on 127.0.0.1. Two runs that
share a port collide (EADDRINUSE, or a request answered by the other run's
server), so each implementer allocates from a block, and a test that binds a
new port adds its row here in the same PR, so the next allocation is a diff.

## Blocks (reviewer, 2026-11-11)

| Range | Owner |
|---|---|
| 9680–9685 | A: L1's sandbox tests (34, 35) |
| 9686–9689 | A: RC1-min test/remote 01–05's remote and listener ports |
| 9693–9694 | composition/17 |
| 9695–9699 | R2-1 (A) |
| 9700–9719 | the registry |
| 9720–9729 | A: RC1-min, step 3 onward |
| 9730–9739 | B |
| 9740–9749 | C |
| 9750–9754 | A: lean worker step 3 |
| 9755–9759 | C (2026-11-17) |
| 9762–9769 | A: M3 credentials (2026-11-18) |
| 9770–9779 | C (2026-11-17) |
| 9790–9799 | B (2026-11-14) |
| 9800–9809 | A: kind caller, usage 24 (2026-11-19) |
| 9820–9829 | B (2026-11-20) |
| 9834–9839 | B (2026-11-27): validation 38, sandbox 73, auth 64 and 65 |
| 9834–9839 | B (2026-11-27): validation 38, sandbox 73, auth 64 |
| 10840–10849 | C: run-local with CH_TEST_PORT_BASE=10840, its servers and its private Redis (10849) (2026-11-16) |

## By file

Generated from the port literals (9500–9999) in each test file, 2026-11-11.
A row may name a port the file only refers to (a refused or an unused
one) as well as the ports it binds.

| File | Ports |
|---|---|
| `test/auth/01-file-provider-tools-list-filtering.js` | 9527, 9811 |
| `test/auth/05-eager-init-at-startup.js` | 9527 |
| `test/auth/06-admin-gating.js` | 9527 |
| `test/auth/07-task-ownership.js` | 9541 |
| `test/auth/08-job-billing-identity.js` | 9542 |
| `test/auth/09-http-invoke-action-metering.js` | 9543 |
| `test/auth/10-balance-auth.js` | 9544 |
| `test/auth/11-admin-module-lifecycle.js` | 9545 |
| `test/auth/12-composing-module-identities.js` | 9546 |
| `test/auth/13-ctx-billing-identity.js` | 9593, 9598 |
| `test/auth/14-removed-callback-routes.js` | 9546 |
| `test/auth/15-read-path-rate-limits.js` | 9545–9546 |
| `test/auth/16-removed-iot-routes.js` | 9547–9548 |
| `test/auth/17-removed-package-routes.js` | 9549 |
| `test/auth/19-peer-channel-revocation.js` | 9601 |
| `test/auth/20-request-body-limits.js` | 9661 |
| `test/auth/21-debug-and-bind.js` | 9662–9663 |
| `test/auth/22-browser-origins.js` | 9665 |
| `test/auth/24-job-ownership.js` | 9669 |
| `test/auth/25-job-schedulers.js` | 9670 |
| `test/auth/30-no-keys-reach-modules.js` | 9631 |
| `test/auth/31-identity.js` | 9646–9649 |
| `test/auth/32-reload-auth.js` | 9628 |
| `test/auth/33-jobs-authorized-at-run.js` | 9641 |
| `test/auth/34-job-bounds.js` | 9642 |
| `test/auth/40-no-metering-in-workers.js` | 9650 |
| `test/auth/41-mcp-tool-call-cost.js` | 9651 |
| `test/auth/42-redis-down-answers.js` | 9652 |
| `test/auth/44-cache-require-builtins.js` | 9653 |
| `test/auth/45-retired-device-fields.js` | 9655 |
| `test/auth/46-redis-down-binary-result.js` | 9667 (its Redis proxy: a free port each run) |
| `test/auth/53-no-keys-reach-reads.js` | 9757 |
| `test/auth/54-routes-listing-scope.js` | 9794 |
| `test/auth/56-job-queue-per-server.js` | 9733, 9796, 9674 |
| `test/auth/57-server-id.js` | none (in-process) |
| `test/auth/58-pre8-device-grants.js` | 9675, 9676 |
| `test/auth/58-pre8-device-grants.js` | 9675, 9676, 9677 |
| `test/auth/59-unauth-limit.js` | 9822, 9823, 9824, 9825 |
| `test/auth/60-overview-scope.js` | 9826, 9827 |
| `test/auth/62-auth-stores-private.js` | 9833 |
| `test/auth/61-job-owner-never-the-key.js` | 9830, 9831, 9832 |
| `test/auth/64-job-run-refused-uncharged.js` | 9839 |
| `test/auth/65-job-rerun-refused-uncharged.js` | 9836 |
| `test/benchmark/test001.js` | 9527 |
| `test/benchmark/test002.js` | 9527 |
| `test/composition/02-ctx-call.js` | 9556–9557, 9560 |
| `test/composition/03-declaration.js` | 9557 |
| `test/composition/04-failure-and-billing.js` | 9527, 9530–9531, 9541, 9546, 9550, 9556–9560, 9574–9575, 9584, 9586, 9590–9591, 9593, 9595 |
| `test/composition/07-single-thread-conflict-guard.js` | 9561 |
| `test/composition/08-bare-server-discovery.js` | 9562–9563 |
| `test/composition/09-refusal-codes.js` | 9564 |
| `test/composition/10-log-triage-example.js` | 9596–9597 |
| `test/composition/13-ready-line.js` | 9599, 9604 |
| `test/composition/14-repo-scan-default-root.js` | 9605 |
| `test/composition/15-composite-inner-reload.js` | 9609–9610 |
| `test/composition/16-hop-missing-device-oracle.js` | 9616–9617 |
| `test/composition/17-hop-module-error.js` | 9618–9620 |
| `test/composition/18-call-tokens.js` | 9695–9698 |
| `test/composition/21-declared-calls-enforced.js` | 9699 (also remote/10's stand-in port; the two never run concurrently) |
| `test/composition/25-refused-before-crash.js` | 9678–9679, 9711 |
| `test/device-config/02-from-main-thread.js` | 9629 |
| `test/device-config/03-json-errors-without-content.js` | 9629 |
| `test/direct-peer-channels/01-echo-roundtrip.js` | 9527 |
| `test/direct-peer-channels/02-invalidation-on-restart.js` | 9527 |
| `test/direct-peer-channels/03-grant-time-auth.js` | 9527 |
| `test/direct-peer-channels/04-metering.js` | 9527 |
| `test/direct-peer-channels/05-backpressure.js` | 9527 |
| `test/direct-peer-channels/06-no-double-billing.js` | 9527 |
| `test/direct-peer-channels/07-callee-grants.js` | 9668 |
| `test/fs-broker/03-broker.js` | 9999 |
| `test/fs-broker/04-scheduler.js` | 9625 |
| `test/fs-broker/09-wired.js` | 9626 |
| `test/fs-broker/12-identity.js` | 9630 |
| `test/fs-broker/13-collisions.js` | 9631 |
| `test/fs-broker/14-hoisted-install.js` | 9633 |
| `test/fs-broker/29-handle-stream-close.js` | 9758 |
| `test/job-control/test001.js` | 9527 |
| `test/load-module/test001.js` | 9527 |
| `test/load-module/test002.js` | 9527 |
| `test/mcp-contract/01-tools-list-unchanged.js` | 9531 |
| `test/mcp-contract/06-output-schema-at-call-start.js` | 9612 |
| `test/mcp-contract/07-error-shape.js` | 9656–9657 |
| `test/mcp-contract/11-progress-e2e.js` | 9580 |
| `test/mcp-contract/12-any-json-output.js` | 9581 |
| `test/mcp-contract/14-handler-progress-e2e.js` | 9582 |
| `test/mcp-contract/16-resources-read.js` | 9583, 9585 |
| `test/mcp-contract/19-cancel-e2e.js` | 9587–9588 |
| `test/mcp-contract/21-list-pages.js` | 9592 |
| `test/mcp-contract/27-tasks-modern.js` | 9637, 9639, 9660 |
| `test/mcp-contract/34-declared-text-cleaned.js` | 9755–9756 |
| `test/mcp-contract/28-task-ask.js` | 9690–9692 |
| `test/mcp-contract/36-sdk-feature-conformance.js` | (a free port, as 03) |
| `test/mcp-contract/37-task-notifications.js` | 9671, 9672, 9673 |
| `test/mcp-contract/capture-error-shape.js` | 9658–9659 |
| `test/mcp-contract/capture-tools-list.js` | 9530 |
| `test/module-authoring/03-authoring-tools-gating.js` | 9550–9552 |
| `test/module-authoring/04-authoring-loop.js` | 9550, 9552–9554 |
| `test/module-loading/01-load-failure-diagnostics.js` | 9571–9573 |
| `test/module-loading/02-sqlite3-unavailable.js` | 9591 |
| `test/module-loading/03-legacy-spec-not-silent.js` | 9574 |
| `test/module-loading/05-handler-map-assembly.js` | 9584 |
| `test/module-loading/06-dual-path-discovery.js` | 9586 |
| `test/module-loading/07-handler-ctx.js` | 9590 |
| `test/module-loading/08-error-semantics.js` | 9595 |
| `test/module-loading/10-schema-pointer-not-silent.js` | 9575 |
| `test/module-loading/12-reload-fresh-code.js` | 9602–9604 |
| `test/module-loading/13-name-mismatch.js` | 9615 |
| `test/module-loading/14-lifecycle.js` | 9634 |
| `test/module-loading/15-reload-scenarios.js` | 9606 |
| `test/module-loading/16-failed-reload-ends-worker.js` | 9632 |
| `test/module-loading/27-lean-ctx-log.js` | 9753 |
| `test/module-loading/28-lean-perf-harness.js` (perf/lean-worker-perf.js) | 9752 |
| `test/remote/01-declaration.js` | 9688 |
| `test/remote/02-credentials.js` | 9688–9689 |
| `test/remote/03-client.js` | 9686–9687 |
| `test/remote/04-resolved-address.js` | 9687–9688 |
| `test/remote/05-route.js` | 9688, 9720–9721 |
| `test/remote/06-listing.js` | 9722–9723 |
| `test/remote/07-counting.js` | 9728–9729 |
| `test/remote/12-cancel-abort.js` | 9589 |
| `test/remote/13-by-module.js` | 9762–9763 |
| `test/remote/14-credential-env.js` | 9764–9765 |
| `test/remote/15-pinned-remote.js` | 9766–9768 |
| `test/module-loading/21-module-layout.js` | 9740–9741 |
| `test/module-loading/33-registry-opt-in.js` | 9594 |
| `test/module-loading/34-icon-reload-single-thread.js` | 9600 |
| `test/module-loading/36-per-session-declaration.js` | 9729 |
| `test/remote/08-origin-map.js` | 9744–9745, 9748 |
| `test/remote/09-sandboxed-call.js` | 9746–9747 |
| `test/remote/10-hardened-install.js` | 9699, 9726 |
| `test/remote/11-hop-then-remote.js` | 9742–9743 |
| `test/remote/16-charge-bound.js` | 9828 |
| `test/sandbox/01-modes.js` | 9605 |
| `test/sandbox/02-permissions.js` | 9606 |
| `test/sandbox/04-load-time.js` | 9607 |
| `test/sandbox/05-lockdown.js` | 9608–9610, 9771–9773 |
| `test/sandbox/07-restart.js` | 9611–9614 |
| `test/sandbox/08-limits.js` | 9613 |
| `test/sandbox/09-hardened.js` | 9614 |
| `test/sandbox/10-node-version.js` | 9624 |
| `test/sandbox/12-load-failure.js` | 9614 |
| `test/sandbox/17-uninstall.js` | 9635 |
| `test/sandbox/18-hardened-probe.js` | 9653 |
| `test/sandbox/20-redis-op.js` | 9664 |
| `test/sandbox/21-validate-sandboxed.js` | 9666 |
| `test/sandbox/23-worker-end-fails-in-flight.js` | 9607–9608 |
| `test/sandbox/24-codes-after-worker-end.js` | 9613–9615 |
| `test/sandbox/25-jobs-wait-through-reload.js` | 9621–9623 |
| `test/sandbox/26-job-timeout.js` | 9624–9625, 9627 |
| `test/sandbox/28-crash-during-restart-discovery.js` | 9638 |
| `test/sandbox/29-link-to-module-parent.js` | 9650 |
| `test/sandbox/30-deviceonline-while-unloading.js` | 9640 |
| `test/sandbox/45-load-bound.js` | 9734–9735 |
| `test/sandbox/46-redis-namespace.js` | 9736–9737 |
| `test/sandbox/47-redis-purge.js` | 9738 |
| `test/sandbox/49-message-bound.js` | 9739 |
| `test/sandbox/50-module-stdio.js` | 9790 |
| `test/fixtures/server-left-behind/failing.js` (run by `test/validation/16-no-server-left.js`) | 9791 |
| `test/sandbox/54-per-call-values.js` | 9792 |
| `test/sandbox/57-session-caps.js` | none (a session socket in its home) |
| `test/sandbox/59-protected-paths-denied.js` | 9796, 9797, 9798 |
| `test/sandbox/60-audit-writes.js` | 9799 (audit, enforce and off, one after another) |
| `test/sandbox/63-unlisted-part-restarting.js` | 9793 |
| `test/sandbox/32-job-late-completion.js` | 9643 |
| `test/sandbox/33-operator-actions-in-order.js` | 9644–9645 |
| `test/sandbox/34-always-denied.js` | 9680–9682 |
| `test/sandbox/35-enforce-tls.js` | 9683–9685 |
| `test/sandbox/39-resolve-shim.js` | 9724–9725 |
| `test/sandbox/41-main-thread-validation.js` | 9749 |
| `test/sandbox/42-hop-results-transferred.js` | 9749 (after 41's server has stopped: one mocha process runs the folder's files one after another) |
| `test/sandbox/48-hop-inputs-transferred.js` | 9749 (after 41's and 42's servers have stopped, as 42) |
| `test/sandbox/49-peer-hops-validated.js` | 9749 (after 41's, 42's and 48's servers have stopped, as 42) |
| `test/sandbox/43-lean-worker-files.js` | 9750 |
| `test/sandbox/48-lean-lockdown.js` | 9751 |
| `test/sandbox/66-no-late-runtime-loads.js` | 9775–9776 |
| `test/sandbox/68-runtime-isolation.js` | 9759 |
| `test/sandbox/69-compatibility-table.js` | 9777 |
| `test/sandbox/73-uninstall-store-down.js` | 9834, 9835 (its Redis proxy) |
| `test/single-thread/01-facade.js` | 9636 |
| `test/single-thread/02-identity.js` | 9636 |
| `test/single-thread/03-resolve.js` | 9727 |
| `test/stdio/03-module-data-dirs.js` | 9733 (a `--redisUrl` nothing listens on) |
| `test/store/08-blob-options.js` | 9579 |
| `test/test1.js` | 9527 |
| `test/test2.js` | 9527 |
| `test/test3.js` | 9527 |
| `test/test4.js` | 9527 |
| `test/test6.js` | 9527 |
| `test/test7.js` | 9527 |
| `test/test8.js` | 9527 |
| `test/unit/test001.js` | 9527 |
| `test/unit/test002.js` | 9527 |
| `test/unit/test003.js` | 9527 |
| `test/unit/test004.js` | 9527 |
| `test/unit/test005.js` | 9527 |
| `test/unit/test006.js` | 9527 |
| `test/unit/test007.js` | 9527 |
| `test/unit/test008.js` | 9527 |
| `test/unit/test009.js` | 9527 |
| `test/unit/test010.js` | 9527 |
| `test/unit/test011.js` | 9527 |
| `test/unit/test012.js` | 9527 |
| `test/unit/test013.js` | 9527 |
| `test/unit/test014.js` | 9527 |
| `test/unit/test015.js` | 9527 |
| `test/unit/test016.js` | 9527 |
| `test/unit/test020.js` | 9527 |
| `test/unit/test021.js` | 9527 |
| `test/unit/test022.js` | 9527 |
| `test/unit/test023.js` | 9527 |
| `test/unit/test024.js` | 9527 |
| `test/unit/test025.js` | 9527 |
| `test/unit/test027.js` | 9527 |
| `test/unit/test028.js` | 9527 |
| `test/unit/test029.js` | 9527 |
| `test/unit/test030.js` | 9527 |
| `test/unit/test031.js` | 9527 |
| `test/unit/test032.js` | 9527 |
| `test/usage/24-caller-kind.js` | 9800, 9801, 9802 |
| `test/usage/27-shutdown-records.js` | 9820, 9821 |
| `test/validation/02-stray-output-rejected.js` | 9575 |
| `test/validation/19-output-not-json.js` | 9576 |
| `test/validation/20-output-not-json-hop.js` | 9577 |
| `test/validation/20-output-not-json-hop.js` | 9578 |
| `test/validation/35-rate-limit-options.js` | 9829 (a start that exits 2 before it listens) |
| `test/validation/38-no-server-outlives-its-file.js` | 9837, 9838 (its fixture's servers) |
