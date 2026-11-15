/**
 * Zod → JSON Schema (OpenAPI 3.1) converter.
 *
 * A deliberately small converter for the constructs our contracts actually use:
 * objects, arrays, enums, literals, unions, nullable, optional, defaults,
 * records, string/url/datetime/uuid/regex formats and numeric bounds. Anything
 * it does not recognise becomes `{}` (any value) and is reported by the contract
 * test that validates the generated document, rather than guessed.
 */
import { z } from 'zod';

type JsonSchema = Record<string, unknown>;

function fromEffects(schema: z.ZodEffects<z.ZodTypeAny>): JsonSchema {
  // `.refine()`/`.transform()` wrappers document their input shape.
  return convert(schema.innerType());
}

function enumValues(schema: z.ZodTypeAny): string[] | undefined {
  const definition = schema._def as unknown as { values?: unknown };
  if (Array.isArray(definition.values)) return definition.values as string[];
  if (definition.values instanceof Set) return [...(definition.values as Set<string>)];
  return undefined;
}

export function convert(schema: z.ZodTypeAny): JsonSchema {
  const definition = schema._def as unknown as Record<string, unknown>;
  const typeName = (schema.constructor as { name?: string }).name;

  switch (typeName) {
    case 'ZodString': {
      const out: JsonSchema = { type: 'string' };
      const checks = (definition['checks'] as { kind: string; value?: unknown; regex?: RegExp }[] | undefined) ?? [];
      for (const check of checks) {
        switch (check.kind) {
          case 'min':
            out['minLength'] = Number(check.value);
            break;
          case 'max':
            out['maxLength'] = Number(check.value);
            break;
          case 'url':
            out['format'] = 'uri';
            break;
          case 'email':
            out['format'] = 'email';
            break;
          case 'uuid':
            out['format'] = 'uuid';
            break;
          case 'datetime':
            out['format'] = 'date-time';
            break;
          case 'regex':
            if (check.regex) out['pattern'] = check.regex.source;
            break;
          default:
            break;
        }
      }
      return out;
    }
    case 'ZodNumber': {
      const out: JsonSchema = { type: 'number' };
      const checks = (definition['checks'] as { kind: string; value?: unknown }[] | undefined) ?? [];
      for (const check of checks) {
        if (check.kind === 'int') out['type'] = 'integer';
        if (check.kind === 'min') out['minimum'] = Number(check.value);
        if (check.kind === 'max') out['maximum'] = Number(check.value);
      }
      return out;
    }
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodNull':
      return { type: 'null' };
    case 'ZodLiteral': {
      const value = definition['value'];
      return { type: value === null ? 'null' : typeof value, const: value };
    }
    case 'ZodEnum': {
      const values = enumValues(schema) ?? [];
      return { type: 'string', enum: values };
    }
    case 'ZodNativeEnum': {
      const values = Object.values(definition['values'] as Record<string, unknown>).filter(
        (value): value is string => typeof value === 'string',
      );
      return { type: 'string', enum: values };
    }
    case 'ZodArray': {
      const inner = definition['type'] as z.ZodTypeAny;
      const min = definition['minLength'] as { value: number } | null | undefined;
      const max = definition['maxLength'] as { value: number } | null | undefined;
      const out: JsonSchema = { type: 'array', items: convert(inner) };
      if (min) out['minItems'] = min.value;
      if (max) out['maxItems'] = max.value;
      return out;
    }
    case 'ZodObject': {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = convert(value as z.ZodTypeAny);
        if (!(value instanceof z.ZodOptional) && !(value instanceof z.ZodDefault)) {
          required.push(key);
        }
      }
      const out: JsonSchema = { type: 'object', properties };
      if (required.length > 0) out['required'] = required;
      const catchall = (definition['catchall'] as z.ZodTypeAny | undefined) ?? undefined;
      if (catchall && !(catchall instanceof z.ZodNever)) {
        out['additionalProperties'] = convert(catchall);
      } else if (typeof definition['unknownKeys'] === 'string' && definition['unknownKeys'] === 'passthrough') {
        out['additionalProperties'] = true;
      }
      return out;
    }
    case 'ZodRecord': {
      const valueType = definition['valueType'] as z.ZodTypeAny;
      return { type: 'object', additionalProperties: convert(valueType) };
    }
    case 'ZodUnion': {
      const options = (definition['options'] as z.ZodTypeAny[] | undefined) ?? [];
      const variants = options.map(convert);
      const typeOf = (variant: JsonSchema): unknown => variant['type'];
      const nullVariant = variants.filter((variant) => typeOf(variant) === 'null');
      const rest = variants.filter((variant) => typeOf(variant) !== 'null');
      if (nullVariant.length === 1 && rest.length === 1) {
        const only = rest[0] as JsonSchema;
        return { ...only, type: [only['type'], 'null'] };
      }
      return { anyOf: variants };
    }
    case 'ZodOptional': {
      const inner = definition['innerType'] as z.ZodTypeAny;
      return convert(inner);
    }
    case 'ZodNullable': {
      const inner = definition['innerType'] as z.ZodTypeAny;
      const converted = convert(inner);
      converted['type'] = [converted['type'], 'null'];
      return converted;
    }
    case 'ZodDefault': {
      const inner = definition['innerType'] as z.ZodTypeAny;
      const converted = convert(inner);
      try {
        converted['default'] = (definition['defaultValue'] as () => unknown)();
      } catch {
        // A default that cannot be evaluated statically is simply not documented.
      }
      return converted;
    }
    case 'ZodEffects':
      return fromEffects(schema as z.ZodEffects<z.ZodTypeAny>);
    case 'ZodPipeline':
      return convert(definition['in'] as z.ZodTypeAny);
    case 'ZodAny':
    case 'ZodUnknown':
      return {};
    case 'ZodNever':
      return { not: {} };
    default:
      return {};
  }
}

export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  return convert(schema);
}
