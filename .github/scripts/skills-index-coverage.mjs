#!/usr/bin/env node
/**
 * skills-index-coverage.mjs — fail if a live, priced gateway capability has no operation in
 * openapi.yaml.
 *
 * WHY THIS EXISTS: docs are GENERATED from openapi.yaml, but the gateway's live capability
 * index (https://gateway.wave.online/.well-known/wave-skills.json) is the actual source of
 * truth for what customers can call and pay for. The two can drift — a capability ships at
 * the gateway before anyone documents it here. This gate catches that drift going forward:
 * every name in the live index must resolve to a documented product in the spec (a matching
 * top-level path segment or tag), or be named — with a reason — in the allowlist next to
 * this script.
 *
 * Matching is deliberately coarse (product-level, not per-operation): the skills index itself
 * is flat (one entry per product, e.g. `/v1/render`), while the spec documents richer nested
 * shapes for the same product (`/render`, `/render/{jobId}`, `/render/{jobId}/events`). A skill
 * named `foo` is "covered" if the spec has a path whose first segment is `foo` OR a tag whose
 * name normalizes to `foo` (case/space/hyphen-insensitive).
 *
 * Usage: node .github/scripts/skills-index-coverage.mjs openapi.yaml
 * Exit 0 = every live capability is covered or allowlisted.
 * Exit 1 = at least one live, non-allowlisted capability has no matching operation.
 * Exit 2 = could not read/parse the spec, or the live index could not be fetched.
 *
 * Network: fetches ONLY the well-known skills index URL below (GET, unauthenticated, public).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SKILLS_INDEX_URL = 'https://gateway.wave.online/.well-known/wave-skills.json';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ALLOWLIST_PATH = join(__dirname, 'skills-index-allowlist.json');

const specPath = process.argv[2];
if (!specPath) {
  console.error('usage: skills-index-coverage.mjs <openapi.yaml>');
  process.exit(2);
}

function norm(name) {
  return String(name).replace(/[-_ ]/g, '').toLowerCase();
}

let doc;
try {
  const raw = readFileSync(specPath, 'utf8');
  const yaml = await import('js-yaml');
  doc = (yaml.default ?? yaml).load(raw);
} catch (err) {
  console.error(`could not read/parse ${specPath}: ${err.message}`);
  process.exit(2);
}

let allowlist = [];
try {
  allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
} catch (err) {
  console.error(`could not read/parse ${ALLOWLIST_PATH}: ${err.message}`);
  process.exit(2);
}
const allowSet = new Set(allowlist.map((e) => norm(e.name)));
for (const e of allowlist) {
  if (!e.name || !e.justification) {
    console.error(`allowlist entry missing name/justification: ${JSON.stringify(e)}`);
    process.exit(2);
  }
}

const covered = new Set();
for (const p of Object.keys(doc.paths ?? {})) {
  const seg = p.split('/').filter(Boolean)[0];
  if (seg && !seg.startsWith('{')) covered.add(norm(seg));
}
for (const t of doc.tags ?? []) {
  if (t.name) covered.add(norm(t.name));
}

let skills;
try {
  const res = await fetch(SKILLS_INDEX_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  skills = await res.json();
} catch (err) {
  console.error(`could not fetch ${SKILLS_INDEX_URL}: ${err.message}`);
  process.exit(2);
}

const missing = [];
for (const s of skills) {
  const key = norm(s.name);
  if (covered.has(key)) continue;
  if (allowSet.has(key)) continue;
  missing.push(s.name);
}

console.log(`skills-index-coverage: ${skills.length - missing.length}/${skills.length} live capabilities covered (${allowlist.length} allowlisted)`);
if (missing.length) {
  console.error(`::error::${missing.length} live priced capabilities have no matching operation/tag in ${specPath}: ${missing.join(', ')}`);
  process.exit(1);
}
console.log('skills-index-coverage: OK');
