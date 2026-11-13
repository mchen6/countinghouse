// An index.js that throws, beside a valid handlers/ tree: a main entry is
// never run, by the runtime or by countinghouse-validate (lib/module-layout.js,
// the one module format), so this module validates and loads clean
// (test/module-authoring/01). Before the one format, the validator required
// it and reported a loadModuleEntry problem.
throw new Error('boom');
