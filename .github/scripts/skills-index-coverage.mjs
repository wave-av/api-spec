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
const allowByName = new Map(allowlist.map((e) => [norm(e.name), e]));
for (const e of allowlist) {
  if (!e.name || !e.justification) {
    console.error(`allowlist entry missing name/justification: ${JSON.stringify(e)}`);
    process.exit(2);
  }
}

// Dotted-path lookup for `expect` predicates, e.g. "pricing.model" -> skill.pricing.model.
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

// An allowlist entry with an `expect` predicate is honored ONLY while the live skill's
// metadata still matches every expected field — if the gateway later reprices or rescopes
// the capability, the exemption stops applying and coverage is enforced again instead of
// silently staying exempt on a name match alone.
function allowlistStillApplies(entry, liveSkill) {
  if (!entry.expect) return true;
  if (!liveSkill) return false;
  return Object.entries(entry.expect).every(([path, expected]) => getPath(liveSkill, path) === expected);
}

const covered = new Set();
for (const p of Object.keys(doc.paths ?? {})) {
  const seg = p.split('/').filter(Boolean)[0];
  if (seg && !seg.startsWith('{')) covered.add(norm(seg));
}
for (const t of doc.tags ?? []) {
  if (t.name) covered.add(norm(t.name));
}

const FETCH_TIMEOUT_MS = 20_000;

let skills;
try {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(SKILLS_INDEX_URL, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  skills = await res.json();
} catch (err) {
  const reason = err.name === 'AbortError' ? `timed out after ${FETCH_TIMEOUT_MS}ms` : err.message;
  console.error(`could not fetch ${SKILLS_INDEX_URL}: ${reason}`);
  process.exit(2);
}

if (!Array.isArray(skills)) {
  console.error(`${SKILLS_INDEX_URL} did not return an array (got ${typeof skills}): ${JSON.stringify(skills).slice(0, 200)}`);
  process.exit(2);
}

const missing = [];
let allowlistedCount = 0;
for (const s of skills) {
  if (!s || typeof s.name !== 'string') {
    console.error(`skills-index entry missing a string "name": ${JSON.stringify(s)}`);
    process.exit(2);
  }
  const key = norm(s.name);
  if (covered.has(key)) continue;
  const entry = allowByName.get(key);
  if (entry) {
    if (allowlistStillApplies(entry, s)) {
      allowlistedCount++;
      continue;
    }
    console.error(
      `::error::allowlist entry "${entry.name}" no longer matches its "expect" predicate against the ` +
      `live skill (${JSON.stringify(entry.expect)} vs live ${JSON.stringify(s)}) — treating "${s.name}" as ` +
      `uncovered instead of silently honoring a stale exemption.`,
    );
  }
  missing.push(s.name);
}

console.log(`skills-index-coverage: ${skills.length - missing.length}/${skills.length} live capabilities covered (${allowlistedCount} allowlisted)`);
if (missing.length) {
  console.error(`::error::${missing.length} live priced capabilities have no matching operation/tag in ${specPath}: ${missing.join(', ')}`);
  process.exit(1);
}
console.log('skills-index-coverage: OK');
