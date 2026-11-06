// Reading an MCP tools/call result the way the gateway now shapes it
// (docs/superpowers/specs/2026-11-06-mcp-conformance-design.md):
//
// - success: the module's output is structuredContent when the tool declares
//   an object output schema, otherwise the text block alone (a string as-is,
//   anything else as JSON, nothing as '');
// - error: no structuredContent; the code, when there is one, is in
//   _meta['countinghouse/code'].
//
// Tests that only care about the value use toolOutput; whether a given tool
// sends structuredContent at all is pinned by test/mcp-contract/03.
function toolOutput(result) {
  if (result == null) return undefined;
  if (result.structuredContent !== undefined) return result.structuredContent;
  const block = Array.isArray(result.content) ? result.content[0] : null;
  if (block == null || typeof(block.text) !== 'string') return undefined;
  if (block.text === '') return undefined;
  try { return JSON.parse(block.text); } catch (e) { return block.text; }
}

function toolErrorCode(result) {
  return (result != null && result._meta != null) ? result._meta['countinghouse/code'] : undefined;
}

module.exports = {toolOutput, toolErrorCode};
