// Deliberately-broken fixture for Task 8's defect B: a main entry that calls
// process.exit() during require(), rather than throwing. lib/module-
// validator.js's loadExported does `require(entryPath)` -- when that require
// itself terminates the process instead of returning or throwing, no
// try/catch anywhere in this process can survive it, and if that require()
// were still happening inside the main gateway process (as it did before
// Task 8), this fixture would take the whole server down instead of being
// reported as a problem with this one module. See
// lib/mcp/gateway.js's validateModuleInChildProcess, which is what makes a
// process.exit() here fatal only to the disposable child process running
// bin/countinghouse-validate.js, not to the gateway that spawned it.
//
// The valid handlers/ tree below is deliberate, same as handler-map-entry-
// throws' sibling fixture: this proves the main entry is what's broken, not
// the module as a whole.
process.exit(1);
