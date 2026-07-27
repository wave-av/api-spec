#!/usr/bin/env node
/**
 * assert-refs.mjs — fail if any internal `$ref` in an OpenAPI document does not resolve.
 *
 * WHY THIS EXISTS (separate from `redocly lint`):
 * `redocly lint` validates the document against the OpenAPI schema, but this repo's spec is
 * hand-edited, and the failure mode that actually bites here is a `$ref` pointing at a component
 * that was renamed, moved, or never added — `#/components/schemas/Typo`. That yields a spec that
 * still *parses*, so YAML tooling is happy, and then the SDK generator emits a broken or empty
 * type for every consumer downstream. This is the cheap structural half of "the spec is loadable".
 *
 * Usage: node .github/scripts/assert-refs.mjs openapi.yaml
 * Exit 0 = every internal $ref resolves. Exit 1 = at least one dangling ref (listed on stderr).
 * Exit 2 = could not read/parse the file, or bad usage.
 *
 * Reads ONLY the local file passed as argv[2]. No network. No execution of spec content.
 */
import { readFileSync } from 'node:fs';

const specPath = process.argv[2];

if (!specPath) {
  console.error('usage: assert-refs.mjs <openapi.yaml|openapi.json>');
  process.exit(2);
}

let doc;
try {
  const raw = readFileSync(specPath, 'utf8');
  if (specPath.endsWith('.json')) {
    doc = JSON.parse(raw);
  } else {
    // js-yaml v4's `load` IS the safe parser — `safeLoad` was removed in v4 precisely because
    // `load` now uses DEFAULT_SCHEMA, which constructs no arbitrary types. (The dangerous one is
    // `load(raw, { schema: yaml.DEFAULT_FULL_SCHEMA })`, which we do not use.)
    const yaml = await import('js-yaml');
    doc = (yaml.default ?? yaml).load(raw);
  }
} catch (err) {
  console.error(`could not read/parse ${specPath}: ${err.message}`);
  process.exit(2);
}

/**
 * Resolve a JSON Pointer like `#/components/schemas/Foo` against the document.
 *
 * Descends via `getOwnPropertyDescriptor` rather than `node[part]` deliberately, for two reasons:
 *   1. It is OWN-KEYS ONLY. A plain `in`/index lookup walks the prototype chain, so
 *      `#/__proto__/anything` or `#/constructor/name` would report as RESOLVING when no such
 *      node exists in the spec — the check would silently pass on a dangling ref.
 *   2. It reads the slot without invoking a getter, so a hostile or exotic document cannot run
 *      code during resolution. (It also keeps static analysers quiet about dynamic index reads.)
 */
function resolves(ref) {
  if (!ref.startsWith('#/')) return true; // external refs are out of scope for this check
  let node = doc;
  for (const rawPart of ref.slice(2).split('/')) {
    // RFC 6901 escaping: ~1 => '/', ~0 => '~'
    const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === null || typeof node !== 'object') return false;
    const slot = Object.getOwnPropertyDescriptor(node, part);
    if (slot === undefined) return false;
    node = slot.value;
  }
  return true;
}

/** Walk the whole document collecting every `$ref` value with the path it was found at. */
const found = [];
(function walk(node, where) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, `${where}[${i}]`));
  } else if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') found.push({ ref: v, where });
      else walk(v, `${where}/${k}`);
    }
  }
})(doc, '');

const dangling = found.filter(({ ref }) => !resolves(ref));

if (dangling.length > 0) {
  console.error(`::error::${dangling.length} dangling $ref(s) in ${specPath}`);
  for (const { ref, where } of dangling) console.error(`  ${ref}   (at ${where})`);
  process.exit(1);
}

console.log(`assert-refs: ${found.length} $ref(s) in ${specPath}, all resolve`);
