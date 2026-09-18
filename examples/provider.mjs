// Any runtime works. stdout is exclusively the protocol response; logs go to stderr.
import { readFileSync } from 'node:fs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
if (request.protocolVersion !== 1 || request.action !== 'collect') throw new Error('Unsupported protocol');
const file = process.argv[2];
if (!file) throw new Error('Usage: bun examples/provider.mjs /path/to/agent.jsonl');
const events = readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).map(line => {
  const row = JSON.parse(line);
  return {
    id: row.request_id, session: row.session_id, timestamp: row.time, model: row.model,
    vendor: 'my-gateway', channel: 'api',
    // This example log reports input_tokens inclusive of cached_tokens.
    tokens: { input: row.input_tokens - (row.cached_tokens ?? 0), output: row.output_tokens, cacheRead: row.cached_tokens ?? 0 },
  };
});
console.log(JSON.stringify({ protocolVersion: 1, events }));
