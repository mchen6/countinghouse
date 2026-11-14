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
| `test/auth/26-bson-preparse-auth.js` | 9662 |
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
| `test/job-control/test001.js` | 9527 |
| `test/load-module/test001.js` | 9527 |
| `test/load-module/test002.js` | 9527 |
| `test/mcp-contract/01-tools-list-unchanged.js` | 9531 |
| `test/mcp-contract/06-output-schema-at-call-start.js` | 9612 |
| `test/mcp-contract/07-error-shape.js` | 9656–9657 |
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
| `test/remote/01-declaration.js` | 9688 |
| `test/remote/02-credentials.js` | 9688–9689 |
| `test/remote/03-client.js` | 9686–9687 |
| `test/remote/04-resolved-address.js` | 9687–9688 |
| `test/remote/05-route.js` | 9688, 9720–9721 |
| `test/remote/06-listing.js` | 9722–9723 |
| `test/remote/07-counting.js` | 9728–9729 |
| `test/remote/08-origin-map.js` | 9744–9745, 9748 |
| `test/remote/09-sandboxed-call.js` | 9746–9747 |
| `test/remote/10-hardened-install.js` | 9699, 9726 |
| `test/remote/11-hop-then-remote.js` | 9742–9743 |
| `test/sandbox/01-modes.js` | 9605 |
| `test/sandbox/02-permissions.js` | 9606 |
| `test/sandbox/04-load-time.js` | 9607 |
| `test/sandbox/05-lockdown.js` | 9608–9610 |
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
| `test/sandbox/27-reload-during-discovery-bound.js` | 9637 |
| `test/sandbox/28-crash-during-restart-discovery.js` | 9638 |
| `test/sandbox/29-link-to-module-parent.js` | 9650 |
| `test/sandbox/30-deviceonline-while-unloading.js` | 9640 |
| `test/sandbox/46-redis-namespace.js` | 9736–9737 |
| `test/sandbox/32-job-late-completion.js` | 9643 |
| `test/sandbox/33-operator-actions-in-order.js` | 9644–9645 |
| `test/sandbox/34-always-denied.js` | 9680–9682 |
| `test/sandbox/35-enforce-tls.js` | 9683–9685 |
| `test/sandbox/39-resolve-shim.js` | 9724–9725 |
| `test/single-thread/01-facade.js` | 9636 |
| `test/single-thread/02-identity.js` | 9636 |
| `test/single-thread/03-resolve.js` | 9727 |
| `test/stdio/03-module-data-dirs.js` | 9733 (a `--redisUrl` nothing listens on) |
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
| `test/unit/test017.js` | 9527 |
| `test/unit/test018.js` | 9527 |
| `test/unit/test019.js` | 9527 |
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
| `test/validation/02-stray-output-rejected.js` | 9575 |
