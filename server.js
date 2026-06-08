// ============================================================
// Brand Events Kickoff — local server (v2, gogcli edition)
//
// Run with:   node server.js
//
// When the form is submitted, for each selected document the server uses
// gogcli (`gog`) — already installed and authenticated — to:
//   1. Copy the blank template (by file ID) into the user's My Drive ROOT.
//      No folder placement: the team saves the file wherever they want.
//   2. Fill the project details into each template's native fields via
//      gog docs/sheets find-replace.
//   3. Return the direct Google Doc/Sheet/Slide link to the new copy.
//
// No OAuth, no Google Cloud Console, no API keys — gogcli only.
// (The earlier Anthropic-proxy server is preserved as server-anthropic-proxy.js.)
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const GOG_BIN = process.env.GOG_BIN || 'gog';
const PAGE_FILE = path.join(__dirname, 'brand-events-kickoff-v2.html');

// Blank template file IDs, keyed by the document id used in the browser.
const TEMPLATE_FILE_IDS = {
  planning:    '18AjBQyxtosFNDdaq0T9ksZoRTo_KgeE9lqUUJZjMO-4',
  production:  '1APYKC2FZ4taN2J3UQsc2U-hNgev5PySJw_LJBISyQuY',
  photography: '1NFN6TphQZZbM4mjtFNA9WiHf6pcx0HwrEGxWNvLhqV0',
  broadcast:   '1cFhyJG7gAtgImHnimlB1s2UBtsm9c2dbdusUaomZudU',
  film:        '1LYw1sWPhyCX83MrktaygfEtyMfOikMvmajyWLp508ns',
  wrap:        '1jSCiqL7ezqqztUWfuyflIAvgn8umd1QKo3bw8Xx4A_w'
};

// What kind of file each template is — drives which gog subcommand fills it.
const DOC_KIND = {
  planning:    'sheet',
  production:  'slides',  // Slides API disabled for our gogcli client → copy only
  photography: 'doc',
  broadcast:   'doc',
  film:        'doc',
  wrap:        'doc'
};

// ------------------------------------------------------------
// Native-field fill plans. Each returns a list of find/replace ops to run on
// the COPY.
//
// The three briefs (photography, broadcast, film) have placeholder tokens
// pre-seeded into the RIGHT-HAND "Details" column cells of their info table
// ({{EVENT_NAME}}, {{EVENT_DATE}}, {{LOCATION}}). Filling is a simple, robust
// find-replace of each token — the value lands in the correct Details cell.
// Tokens are always replaced (with "" when the form field is empty) so no raw
// {{TOKEN}} text is ever left behind.
//
// The reconciliation doc has no seeded tokens, so it still appends the value to
// the label cell (e.g. "Project Title" -> "Project Title: <name>").
// ------------------------------------------------------------
function fillPlan(id, meta) {
  const name = (meta.name && meta.name !== '[Project Name]') ? meta.name : '';
  const date = meta.dateFormatted || meta.date || '';
  const loc  = meta.location || '';
  const type = meta.type || '';

  // Token op: always runs, clearing the token when the value is empty.
  const tok = (token, value) => ({ find: token, replace: value || '' });
  // Label-append op: only when a value exists.
  const append = (label, value) =>
    value ? { find: label, replace: `${label}: ${value}` } : null;

  switch (id) {
    case 'planning': // Sheet — Success Metrics tab placeholder, ×4
      return (name || date)
        ? [{ sheet: true, find: '[project name, date]',
             replace: [name, date].filter(Boolean).join(', ') }]
        : [];
    case 'photography': // "Location / Venue" Details cell holds {{LOCATION}}
    case 'broadcast':   // "Venue / Location" Details cell holds {{LOCATION}}
      return [tok('{{EVENT_NAME}}', name), tok('{{EVENT_DATE}}', date),
              tok('{{LOCATION}}', loc)];
    case 'film': {
      const ops = [];
      // Title line carries the event name too; only rewrite it when we have one.
      if (name) ops.push({ find: 'Film Content Capture Brief: Event Name',
                           replace: `Film Content Capture Brief: ${name}` });
      ops.push(tok('{{EVENT_NAME}}', name), tok('{{EVENT_DATE}}', date),
               tok('{{LOCATION}}', loc));
      return ops;
    }
    case 'wrap': // Project reconciliation — no seeded tokens, append to labels
      return [append('Project Title', name), append('Event Type', type),
              append('Event Date', date), append('Location / Venue', loc)].filter(Boolean);
    default:
      return [];
  }
}

// ------------------------------------------------------------
// gogcli runner — args passed as an array (no shell), so commas/spaces in
// values never need escaping.
// ------------------------------------------------------------
function runGog(args) {
  return new Promise((resolve, reject) => {
    execFile(GOG_BIN, args, { env: process.env, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`gog ${args.join(' ')} failed: ${(stderr || err.message).trim().slice(0, 300)}`));
        } else {
          resolve(stdout);
        }
      });
  });
}

function parseJson(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

// Copy one template into My Drive root (no --parent) and fill its fields.
async function createOne(d, meta) {
  const fileId = TEMPLATE_FILE_IDS[d.id];
  const newName = `${meta.name || '[Project Name]'} — ${d.name}`;

  // 1. Copy into My Drive root.
  const out = await runGog(['drive', 'copy', fileId, newName, '--json']);
  const parsed = parseJson(out);
  const file = parsed && parsed.file;
  if (!file || !file.id) throw new Error('Copy did not return a file id.');
  const url = file.webViewLink ||
    `https://drive.google.com/open?id=${file.id}`;

  // 2. Fill native fields (best-effort; Slides can't be filled).
  const kind = DOC_KIND[d.id];
  let filled = 0, unfilled = false;
  if (kind === 'slides') {
    unfilled = true; // Slides API disabled for our gogcli client.
  } else {
    for (const op of fillPlan(d.id, meta)) {
      const cmd = op.sheet
        ? ['sheets', 'find-replace', file.id, op.find, op.replace, '--json']
        : ['docs', 'find-replace', file.id, op.find, op.replace, '--json'];
      try { await runGog(cmd); filled++; }
      catch (e) { /* non-fatal: a missing field shouldn't sink the whole copy */ }
    }
  }

  return { id: d.id, name: d.name, fileName: newName, url, filled, unfilled };
}

async function generateAll(body) {
  const meta = body.meta || {};
  const docs = Array.isArray(body.docs) ? body.docs : [];

  const results = [];
  for (const d of docs) {
    if (!TEMPLATE_FILE_IDS[d.id]) {
      results.push({ id: d.id, name: d.name,
        error: 'No blank template is configured for this document type yet.' });
      continue;
    }
    try {
      results.push(await createOne(d, meta));
    } catch (e) {
      results.push({ id: d.id, name: d.name, error: e.message });
    }
  }
  return { results };
}

// ------------------------------------------------------------
// HTTP server
// ------------------------------------------------------------
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, tool: GOG_BIN, drive: 'My Drive (root)' }));
    return;
  }

  // Convenience: serve the tool itself.
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/brand-events-kickoff-v2.html'))) {
    fs.readFile(PAGE_FILE, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'brand-events-kickoff-v2.html not found next to server.js' }));
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/generate') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 5 * 1024 * 1024) req.destroy(); });
    req.on('end', async () => {
      let parsed;
      try { parsed = JSON.parse(body); }
      catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }
      const count = parsed.docs ? parsed.docs.length : 0;
      const name = (parsed.meta && parsed.meta.name) || '[unnamed]';
      console.log(`\n[generate] ${count} document(s) for "${name}" → My Drive root`);
      try {
        const result = await generateAll(parsed);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        for (const r of result.results) {
          console.log(r.url ? `  ✓ ${r.name} → ${r.url}` : `  ✗ ${r.name}: ${r.error}`);
        }
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
        console.log(`[generate] error: ${e.message}`);
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('============================================================');
  console.log(` Brand Events Kickoff server running at http://localhost:${PORT}`);
  console.log(` Using gogcli ("${GOG_BIN}") — no OAuth, no API key.`);
  console.log(' Copies are created in My Drive (root); the team files them themselves.');
  console.log(' Open brand-events-kickoff-v2.html in your browser to use it.');
  console.log(' Press Ctrl+C to stop.');
  console.log('============================================================');
});

process.on('SIGINT', () => {
  console.log('\nShutting down.');
  server.close(() => process.exit(0));
});
