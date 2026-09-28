#!/usr/bin/env node
/**
 * Threat-model drift check (issue #685).
 *
 * Fails CI when a new trust boundary or external origin appears in the
 * codebase without a corresponding entry in docs/THREAT_MODEL.md.
 *
 * Usage: node scripts/check-threat-model-drift.mjs
 * Exit code 0 = no drift, 1 = drift detected.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const ROOT = process.cwd();
const MODEL_PATH = join(ROOT, 'docs', 'THREAT_MODEL.md');
const SCAN_DIRS = ['src', 'scripts', 'app', 'pages', 'server', 'api'];
const SCAN_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

// External origins / trust boundaries we care about. Each pattern maps to a
// stable identifier that must be present in the threat model document.
const BOUNDARY_PATTERNS = [
  { id: 'webhook', re: /\bwebhook(s)?\b/i },
  { id: 'on-chain-signing', re: /\b(signTransaction|signMessage|walletconnect|ethers|viem)\b/i },
  { id: 'telemetry', re: /\b(telemetry|analytics|sentry|posthog|datadog)\b/i },
  { id: 'external-origin', re: /https?:\/\/(?!localhost|127\.0\.0\.1)[a-z0-9.-]+/i },
  { id: 'auth-boundary', re: /\b(authorize|authenticate|bearer|oauth|jwt)\b/i },
];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (IGNORE_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (SCAN_EXTS.has(extname(entry))) out.push(full);
  }
  return out;
}

function loadModel() {
  if (!existsSync(MODEL_PATH)) {
    console.error(`[threat-model] missing ${relative(ROOT, MODEL_PATH)}`);
    process.exit(1);
  }
  return readFileSync(MODEL_PATH, 'utf8');
}

function main() {
  const model = loadModel();
  const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));
  const found = new Map(); // id -> Set<file>

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const { id, re } of BOUNDARY_PATTERNS) {
      if (re.test(text)) {
        if (!found.has(id)) found.set(id, new Set());
        found.get(id).add(relative(ROOT, file));
      }
    }
  }

  const missing = [];
  for (const [id, sources] of found) {
    // A boundary is documented when its id appears in the threat model.
    const documented = new RegExp(`\\b${id.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i').test(model);
    if (!documented) missing.push({ id, sources: [...sources].slice(0, 5) });
  }

  if (missing.length > 0) {
    console.error('[threat-model] drift detected: undocumented trust boundaries/origins');
    for (const { id, sources } of missing) {
      console.error(`  - ${id} (e.g. ${sources.join(', ')})`);
    }
    console.error('\nAdd an entry to docs/THREAT_MODEL.md for each boundary above.');
    process.exit(1);
  }

  console.log(`[threat-model] OK: ${found.size} boundary type(s) documented.`);
}

main();
