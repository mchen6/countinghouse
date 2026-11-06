// Code-mode wrappers for the token-cost measurement (perf/token-cost-compare.js,
// groups D1 and D2): the log-triage leaf tools presented to the model as a
// small Node library it calls from its own scripts, the way Anthropic's "Code
// execution with MCP" presents MCP servers -- a directory per server, a file
// per tool, types alongside.
//
//   node perf/gen-code-mode-wrappers.js --tools <tools-list.json> --out <dir>
//        --variant D1|D2 [--url <mcp url>] [--keyEnv <env var name>]
//   node perf/gen-code-mode-wrappers.js --tools <tools-list.json> --check <report.md>
//
// <tools-list.json> is the `result` of a tools/list call against the running
// instance, saved as-is. Everything written is derived from it mechanically:
//
//   <out>/servers/log-triage/types.d.ts   <Tool>Input (and, for D1, <Tool>Output)
//                                         interfaces; nested objects become their
//                                         own named interfaces, arrays a concrete
//                                         element type, enums literal unions,
//                                         optional fields `?`; title, description
//                                         and every constraint keyword go into
//                                         the field's JSDoc.
//   <out>/servers/log-triage/<fn>.js      one async function per tool, posting
//                                         tools/call to the instance with the key
//                                         read from the environment.
//   <out>/servers/log-triage/README.md    the four functions.
//
// countinghouse returns structuredContent as {output: <result>} while
// tools/list advertises the schema of <result> itself, so every wrapper
// returns structuredContent.output: the value the Output type describes.
//
// D1 and D2 have identical inputs. D2 drops the Output interfaces and declares
// `@returns {Promise<unknown>}` instead, the case of an MCP server without
// outputSchema; the tool description stays in both.
//
// Before anything is written, the schemas are checked for concreteness (every
// object has properties, every array items, every field a type) and the
// generated types.d.ts for loose types (any, unknown, object, Object, {},
// Array<...>, Record<...>, index signatures). Either check failing exits 1
// with nothing written. --check writes the per-field table of the schema check
// for every tool in the list, the composite included.
const fs   = require('fs');
const path = require('path');

const SERVER_DIR = path.join('servers', 'log-triage');

// tool name in tools/list -> exported function name
const TOOLS = {
  log_read_readservice_list:            'list',
  log_read_readservice_read:            'read',
  pii_redact_redactservice_redact:      'redact',
  error_cluster_clusterservice_cluster: 'cluster'
};

const CONCRETE_TYPES = ['string', 'integer', 'number', 'boolean', 'object', 'array', 'null'];
const CONSTRAINTS    = ['enum', 'format', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'default'];

function parseArgs(argv) {
  const o = {url: 'http://127.0.0.1:9540/mcp', keyEnv: 'CH_PERF_KEY'};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    if (argv[i + 1] == null) throw new Error(`missing value for ${argv[i]}`);
    o[k] = argv[i + 1];
  }
  return o;
}

// ---- dereferencing ----------------------------------------------------------

// Expands every local $ref ("#/..."), relative to the schema it appears in.
// A remote $ref is an error: the instance is the only source of truth here.
function deref(schema, root, seen) {
  root = root || schema;
  seen = seen || [];
  if (Array.isArray(schema)) return schema.map((s) => deref(s, root, seen));
  if (schema == null || typeof schema !== 'object') return schema;
  if (schema.$ref != null) {
    if (!schema.$ref.startsWith('#/')) throw new Error(`non-local $ref ${schema.$ref}`);
    if (seen.includes(schema.$ref)) throw new Error(`recursive $ref ${schema.$ref}`);
    const target = schema.$ref.slice(2).split('/').reduce((node, part) => {
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      if (node == null || !(key in node)) throw new Error(`unresolvable $ref ${schema.$ref}`);
      return node[key];
    }, root);
    const rest = Object.assign({}, schema);
    delete rest.$ref;
    return Object.assign({}, deref(target, root, seen.concat(schema.$ref)), deref(rest, root, seen));
  }
  const out = {};
  for (const [k, v] of Object.entries(schema)) out[k] = deref(v, root, seen);
  return out;
}

// ---- schema concreteness ----------------------------------------------------

function typesOf(s) {
  if (s.type == null) return [];
  return Array.isArray(s.type) ? s.type : [s.type];
}

// Walks one schema; returns {rows, problems, stops}. A row per field (the root
// included); a problem per failed check; a stop for an object without
// properties or an array without items, which ends the measurement.
function checkSchema(tool, which, schema) {
  const rows = [], problems = [], stops = [];
  (function walk(s, p, required) {
    const types = typesOf(s);
    const cons = CONSTRAINTS.filter((k) => s[k] !== undefined)
      .map((k) => `${k}=${JSON.stringify(s[k])}`).join(', ');
    const row = {tool, which, path: p, type: types.join('|') || '(none)', required, constraints: cons,
      additionalProperties: types.includes('object') ? JSON.stringify(s.additionalProperties) : ''};
    rows.push(row);
    if (types.length === 0) problems.push(`${tool} ${which} ${p}: no type`);
    for (const t of types) {
      if (!CONCRETE_TYPES.includes(t)) problems.push(`${tool} ${which} ${p}: unknown type ${t}`);
    }
    if (types.includes('object')) {
      if (s.properties == null) {
        stops.push(`${tool} ${which} ${p}: object without properties`);
      } else {
        if (!Array.isArray(s.required)) problems.push(`${tool} ${which} ${p}: object has no "required" list`);
        if (s.additionalProperties !== false) {
          problems.push(`${tool} ${which} ${p}: additionalProperties is ${JSON.stringify(s.additionalProperties)}, not false`);
        }
        const req = s.required || [];
        for (const [name, sub] of Object.entries(s.properties)) {
          walk(sub, `${p}.${name}`, req.includes(name) ? 'yes' : 'no');
        }
      }
    }
    if (types.includes('array')) {
      if (s.items == null || Array.isArray(s.items)) stops.push(`${tool} ${which} ${p}: array without a single items schema`);
      else walk(s.items, `${p}[]`, '-');
    }
  })(schema, '$', '-');
  return {rows, problems, stops};
}

// ---- TypeScript generation --------------------------------------------------

const pascal = (s) => s.replace(/(^|[_\-\s])(\w)/g, (m, a, c) => c.toUpperCase()).replace(/^\w/, (c) => c.toUpperCase());
// "clusters" -> "Cluster", "files" -> "File": the element of a plural array.
const singular = (s) => (/ies$/.test(s) ? s.replace(/ies$/, 'y') : /ses$/.test(s) ? s.replace(/es$/, '') : s.replace(/s$/, ''));

function jsdoc(s, indent) {
  const lines = [];
  if (s.title) lines.push(s.title);
  if (s.description) {
    if (lines.length) lines.push('');
    lines.push(...s.description.split('\n'));
  }
  // TS has no integer type; keep the schema's distinction in the doc.
  if (typesOf(s).includes('integer')) lines.push('@integer');
  for (const k of CONSTRAINTS) {
    if (k === 'enum' || s[k] === undefined) continue;
    lines.push(`@${k} ${typeof s[k] === 'string' ? s[k] : JSON.stringify(s[k])}`);
  }
  if (lines.length === 0) return '';
  return `${indent}/**\n${lines.map((l) => `${indent} *${l ? ` ${  l}` : ''}`).join('\n')}\n${indent} */\n`;
}

// Returns the TS type expression for `s`, pushing any named interfaces it
// needs onto `decls`.
function tsType(s, name, decls) {
  const parts = typesOf(s).map((t) => {
    switch (t) {
      case 'string':  return s.enum ? s.enum.map((v) => JSON.stringify(v)).join(' | ') : 'string';
      case 'integer':
      case 'number':  return 'number';
      case 'boolean': return 'boolean';
      case 'null':    return 'null';
      case 'array': {
        const el = tsType(s.items, singular(name), decls);
        return /[|&]/.test(el) ? `(${el})[]` : `${el}[]`;
      }
      case 'object':  return declareInterface(s, name, decls);
      default: throw new Error(`no TS type for ${t}`);
    }
  });
  return parts.join(' | ');
}

function declareInterface(s, name, decls) {
  const req = s.required || [];
  let body = '';
  for (const [prop, sub] of Object.entries(s.properties)) {
    const t = tsType(sub, name + pascal(prop), decls);
    body += `${jsdoc(sub, '  ')  }  ${prop}${req.includes(prop) ? '' : '?'}: ${t};\n`;
  }
  if (s.additionalProperties != null && typeof s.additionalProperties === 'object') {
    body += `  [key: string]: ${tsType(s.additionalProperties, `${name  }Value`, decls)};\n`;
  }
  decls.push(`${jsdoc(s, '')  }export interface ${name} {\n${body}}\n`);
  return name;
}

// ---- type self-check --------------------------------------------------------

// Lexical check of the generated .d.ts: comments and string literals are
// removed first, so a JSDoc mentioning "object" or a literal "WARN" can't
// trip it. `allowedIndex` is how many index signatures the schemas ask for
// (additionalProperties set to a schema); any other is a failure.
const LOOSE = [
  ['any',                  /\bany\b/],
  ['unknown',              /\bunknown\b/],
  ['object',               /\bobject\b/],
  ['Object',               /\bObject\b/],
  ['{}',                   /\{\s*\}/],
  ['Array<...>',           /\bArray\s*</],
  ['Record<...>',          /\bRecord\s*</]
];

function selfCheck(dts, allowedIndex) {
  const code = dts.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const found = [];
  for (const [label, re] of LOOSE) {
    code.split('\n').forEach((line, i) => { if (re.test(line)) found.push(`${label}: line ${i + 1}: ${line.trim()}`); });
  }
  const index = code.split('\n').filter((l) => /\[\s*\w+\s*:\s*(string|number)\s*\]\s*:/.test(l));
  if (index.length > allowedIndex) found.push(`index signature(s): ${index.map((l) => l.trim()).join('; ')}`);
  return {
    ok: found.length === 0,
    found,
    interfaces: (code.match(/export interface \w+/g) || []).map((m) => m.split(' ')[2])
  };
}

// ---- wrappers ---------------------------------------------------------------

function wrapperJs(fn, tool, description, inputIface, outputIface, url, keyEnv) {
  const returns = outputIface ? `Promise<import('./types').${outputIface}>` : 'Promise<unknown>';
  const desc = description.split('\n').map((l) => ` * ${l}`).join('\n');
  return `'use strict';
// Generated by perf/gen-code-mode-wrappers.js from the instance's tools/list.
// Calls the MCP tool ${tool} on the local countinghouse.

/**
${desc}
 *
 * @param {import('./types').${inputIface}} input
 * @returns {${returns}}
 */
async function ${fn}(input) {
  const key = process.env.${keyEnv};
  if (!key) throw new Error('${keyEnv} is not set');
  const res = await fetch('${url}', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'X-CH-Key': key},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: '${tool}', arguments: input || {}}})
  });
  const body = await res.json();
  if (body.error) throw new Error(\`${tool}: \${body.error.message}\`);
  if (body.result.isError) throw new Error(\`${tool}: \${body.result.content.map((c) => c.text).join(' ')}\`);
  // countinghouse's structuredContent is {output: <result>}, one level above
  // the advertised outputSchema; the function returns the result itself.
  const sc = body.result.structuredContent;
  if (sc == null || !('output' in sc)) throw new Error(\`${tool}: no structuredContent.output in the response\`);
  return sc.output;
}

module.exports = {${fn}};
`;
}

function readme(withOutputs) {
  const rows = Object.entries(TOOLS).map(([tool, fn]) =>
    `| \`${fn}(input)\` | \`./${fn}.js\` | \`${pascal(fn)}Input\` | ${withOutputs ? `\`${pascal(fn)}Output\`` : 'not declared'} |`);
  return `# log-triage

Four async functions, one per tool of the log-triage server. Each takes one
input object and returns a promise of the tool's result.

| Function | File | Input type | Output type |
|---|---|---|---|
${rows.join('\n')}

The types are in [\`types.d.ts\`](types.d.ts). Each function's JSDoc in its own
file has the tool's description. Import a function with
\`const {${Object.values(TOOLS)[0]}} = require('./servers/log-triage/${Object.values(TOOLS)[0]}.js')\`.
`;
}

// ---- main -------------------------------------------------------------------

function main() {
  const o = parseArgs(process.argv.slice(2));
  const list = JSON.parse(fs.readFileSync(o.tools, 'utf8'));
  const tools = (list.tools || list).map((t) => Object.assign({}, t, {
    inputSchema:  deref(t.inputSchema),
    outputSchema: t.outputSchema == null ? null : deref(t.outputSchema)
  }));

  // schema concreteness over every listed tool
  const rows = [], problems = [], stops = [];
  for (const t of tools) {
    for (const [which, s] of [['input', t.inputSchema], ['output', t.outputSchema]]) {
      if (s == null) { problems.push(`${t.name} ${which}: no schema`); continue; }
      const r = checkSchema(t.name, which, s);
      rows.push(...r.rows); problems.push(...r.problems); stops.push(...r.stops);
    }
  }

  if (o.check) {
    const md = ['| tool | schema | path | type | required | constraints | additionalProperties |',
      '|---|---|---|---|---|---|---|']
      .concat(rows.map((r) => `| ${r.tool} | ${r.which} | \`${r.path}\` | ${r.type} | ${r.required} | ${r.constraints.replace(/\|/g, '\\|')} | ${r.additionalProperties} |`))
      .concat(['', `Problems (${problems.length}):`], problems.map((p) => `- ${p}`))
      .concat(['', `Stops (${stops.length}):`], stops.map((p) => `- ${p}`));
    fs.writeFileSync(o.check, `${md.join('\n')  }\n`);
    console.log(`schema check: ${rows.length} field(s), ${problems.length} problem(s), ${stops.length} stop(s) -> ${o.check}`);
    process.exit(stops.length ? 1 : 0);
  }

  if (o.variant !== 'D1' && o.variant !== 'D2') throw new Error('--variant D1|D2');
  if (!o.out) throw new Error('--out <dir>');
  // A field without a concrete type has no honest TS type either.
  const leafStops = stops.concat(problems.filter((p) => /: (no type|unknown type)/.test(p)))
    .filter((s) => Object.keys(TOOLS).includes(s.split(' ')[0]));
  if (leafStops.length) {
    console.error(`schema not concrete, nothing generated:\n${  leafStops.join('\n')}`);
    process.exit(1);
  }

  const withOutputs = o.variant === 'D1';
  const decls = [];
  const files = {};
  let allowedIndex = 0;
  for (const [tool, fn] of Object.entries(TOOLS)) {
    const t = tools.find((x) => x.name === tool);
    if (t == null) throw new Error(`${tool} is not in tools/list`);
    const schemas = withOutputs ? [t.inputSchema, t.outputSchema] : [t.inputSchema];
    for (const s of schemas) {
      JSON.stringify(s, (k, v) => { if (k === 'additionalProperties' && v && typeof v === 'object') allowedIndex++; return v; });
    }
    const inIface = tsType(t.inputSchema, `${pascal(fn)}Input`, decls);
    const outIface = withOutputs ? tsType(t.outputSchema, `${pascal(fn)}Output`, decls) : null;
    files[`${fn}.js`] = wrapperJs(fn, tool, t.description, inIface, outIface, o.url, o.keyEnv);
  }
  const dts = `// Generated by perf/gen-code-mode-wrappers.js from the instance's tools/list.\n\n${  decls.join('\n')}`;
  const check = selfCheck(dts, allowedIndex);
  console.log(JSON.stringify({variant: o.variant, selfCheck: check}, null, 2));
  if (!check.ok) {
    console.error('type self-check failed, nothing generated');
    process.exit(1);
  }

  const dir = path.join(o.out, SERVER_DIR);
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'types.d.ts'), dts);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  fs.writeFileSync(path.join(dir, 'README.md'), readme(withOutputs));
}

if (require.main === module) main();

module.exports = {deref, checkSchema, selfCheck};
