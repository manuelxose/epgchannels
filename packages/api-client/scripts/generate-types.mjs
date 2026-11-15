/**
 * `client:generate` — generates TypeScript types from the exported OpenAPI
 * document, so the SDK's wire types can be checked against the published
 * contract instead of being maintained by hand.
 *
 * The generator covers the constructs our own document uses (objects, arrays,
 * enums, `type: [..]` nullable unions, `anyOf`, `oneOf`, `$ref`, `additionalProperties`).
 * It fails loudly on a construct it does not understand, instead of emitting a
 * type that silently means something else.
 *
 * Usage: node scripts/generate-types.mjs [--openapi ../../openapi/openapi.json]
 *                                       [--out src/generated/openapi-types.ts]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const openApiPath = resolve(argOf('--openapi', '../../openapi/openapi.json'));
const outPath = resolve(argOf('--out', 'src/generated/openapi-types.ts'));
const document = JSON.parse(await readFile(openApiPath, 'utf8'));

function typeName(ref) {
  const match = /^#\/components\/schemas\/(.+)$/.exec(ref);
  if (!match) throw new Error(`Unsupported $ref: ${ref}`);
  return match[1];
}

function literalUnion(values) {
  return values.map((value) => JSON.stringify(value)).join(' | ');
}

function emit(schema, indent = 0) {
  if (!schema || typeof schema !== 'object') return 'unknown';
  if (schema.$ref) return typeName(schema.$ref);
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) return literalUnion(schema.enum);
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map((variant) => emit(variant, indent)).join(' | ');
  if (Array.isArray(schema.oneOf)) return schema.oneOf.map((variant) => emit(variant, indent)).join(' | ');
  if (schema.allOf) return schema.allOf.map((variant) => emit(variant, indent)).join(' & ');

  const type = schema.type;
  const nullable = Array.isArray(type) && type.includes('null');
  const baseType = Array.isArray(type) ? type.filter((entry) => entry !== 'null') : type;

  let rendered;
  if (Array.isArray(type) && baseType.length === 1 && baseType[0] === 'string' && Array.isArray(schema.enum)) {
    rendered = literalUnion(schema.enum);
  } else if (Array.isArray(type) && baseType.length === 1) {
    // A nullable scalar written as `type: ["integer", "null"]`.
    rendered = emit({ ...schema, type: baseType[0] }, indent);
  } else if (baseType === 'string') {
    rendered = 'string';
  } else if (baseType === 'integer' || baseType === 'number') {
    rendered = 'number';
  } else if (baseType === 'boolean') {
    rendered = 'boolean';
  } else if (baseType === 'null') {
    rendered = 'null';
  } else if (baseType === 'array') {
    rendered = `ReadonlyArray<${emit(schema.items, indent)}>`;
  } else if (baseType === 'object' || baseType === undefined) {
    if (schema.properties && Object.keys(schema.properties).length > 0) {
      const required = new Set(schema.required ?? []);
      const pad = '  '.repeat(indent + 1);
      const lines = Object.entries(schema.properties).map(([key, value]) => {
        const optional = required.has(key) ? '' : '?';
        const safeKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
        return `${pad}readonly ${safeKey}${optional}: ${emit(value, indent + 1)};`;
      });
      rendered = `{\n${lines.join('\n')}\n${'  '.repeat(indent)}}`;
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      rendered = `Readonly<Record<string, ${emit(schema.additionalProperties, indent)}>>`;
    } else if (schema.additionalProperties === true || baseType === 'object') {
      rendered = 'Readonly<Record<string, unknown>>';
    } else {
      rendered = 'unknown';
    }
  } else {
    throw new Error(`Unsupported schema construct: ${JSON.stringify(schema).slice(0, 160)}`);
  }

  if (nullable && !rendered.includes('null')) {
    return `${rendered} | null`;
  }
  return rendered;
}

const lines = [
  '// GENERATED — do not edit by hand.',
  '// Source: openapi/openapi.json (TDT Platform API v1).',
  `// Generated: ${new Date().toISOString()}`,
  '',
];

for (const [name, schema] of Object.entries(document.components.schemas)) {
  lines.push(`export type ${name} = ${emit(schema)};`);
  lines.push('');
}

const operations = [];
for (const [path, methods] of Object.entries(document.paths)) {
  for (const [method, operation] of Object.entries(methods)) {
    if (!operation || typeof operation !== 'object') continue;
    operations.push({ path, method: method.toUpperCase(), operationId: operation.operationId ?? null, tags: operation.tags ?? [] });
  }
}
lines.push('/** Every documented operation, as generated from the contract. */');
lines.push('export const OPENAPI_OPERATIONS = {');
for (const operation of operations) {
  lines.push(`  ${operation.operationId}: { method: ${JSON.stringify(operation.method)}, path: ${JSON.stringify(operation.path)} },`);
}
lines.push('} as const;');
lines.push('');
lines.push(`export const OPENAPI_VERSION = ${JSON.stringify(document.openapi)};`);
lines.push('');

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${lines.join('\n')}`, 'utf8');
console.log(
  JSON.stringify(
    {
      command: 'client:generate',
      openapi: openApiPath,
      out: outPath,
      schemas: Object.keys(document.components.schemas).length,
      operations: operations.length,
    },
    null,
    2,
  ),
);
