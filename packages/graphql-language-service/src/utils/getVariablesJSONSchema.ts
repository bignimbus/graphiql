/**
 *  Copyright (c) 2021 GraphQL Contributors.
 *
 *  This source code is licensed under the MIT license found in the
 *  LICENSE file in the root directory of this source tree.
 */

import {
  GraphQLInputField,
  GraphQLInputType,
  isEnumType,
  isInputObjectType,
  isListType,
  isNonNullType,
  isScalarType,
} from 'graphql';

import type {
  JSONSchema4Type,
  JSONSchema6,
  JSONSchema6Definition,
  JSONSchema6TypeName,
} from 'json-schema';
import type { VariableToType } from './collectVariables';

export type { JSONSchema6, JSONSchema6TypeName };

export type JsonSchemaOptions = {
  /**
   * use undocumented `monaco-json` `markdownDescription` field in place of json-schema spec `description` field.
   */
  useMarkdownDescription?: boolean;
};

type PropertiedJSON6 = JSONSchema6 & {
  properties: {
    [k: string]: JSONSchema6;
  };
};

export type JSONSchemaOptions = {
  /**
   * whether to append a non-json schema valid 'markdownDescription` for `monaco-json`
   */
  useMarkdownDescription?: boolean;
  /**
   * Custom scalar schema mappings.
   */
  customScalarSchemas?: Record<string, JSONSchema6>;
};
type JSONSchemaRunningOptions = JSONSchemaOptions & {
  definitionMarker: Marker;
};

export const defaultJSONSchemaOptions = {
  useMarkdownDescription: false,
};

export type MonacoEditorJSONSchema = JSONSchema6 & {
  markdownDescription?: string;
};

export type CombinedSchema = JSONSchema6 | MonacoEditorJSONSchema;

type Definitions = { [k: string]: JSONSchema6Definition };

export type DefinitionResult = {
  definition: JSONSchema6 | MonacoEditorJSONSchema;
  required: boolean;
  definitions?: Definitions;
};

function text(into: string[], newText: string) {
  into.push(newText);
}

function renderType(into: string[], t: GraphQLInputType | GraphQLInputField) {
  if (isNonNullType(t)) {
    renderType(into, t.ofType);
    text(into, '!');
  } else if (isListType(t)) {
    text(into, '[');
    // @ts-ignore
    renderType(into, t.ofType);
    text(into, ']');
  } else {
    text(into, t.name);
  }
}

function renderTypeToString(
  t: GraphQLInputType | GraphQLInputField,
  useMarkdown?: boolean,
) {
  const into: string[] = [];
  if (useMarkdown) {
    text(into, '```graphql\n');
  }
  renderType(into, t);
  if (useMarkdown) {
    text(into, '\n```');
  }
  return into.join('');
}

const scalarTypesMap: { [key: string]: JSONSchema6TypeName } = {
  Int: 'integer',
  String: 'string',
  Float: 'number',
  ID: 'string',
  Boolean: 'boolean',
  // { "type": "string", "format": "date" } is not compatible with proposed DateTime GraphQL-Scalars.com spec
  DateTime: 'string',
};

class Marker {
  private set = new Set<string>();

  mark(name: string): boolean {
    if (this.set.has(name)) {
      return false;
    }
    this.set.add(name);
    return true;
  }
}

/**
 *
 * @param type {GraphQLInputType}
 * @param options
 * @returns {DefinitionResult}
 */
function getJSONSchemaFromGraphQLType(
  type: GraphQLInputType | GraphQLInputField,
  options?: JSONSchemaRunningOptions,
  isNonNull?: boolean,
): DefinitionResult {
  let required = false;
  let definition: CombinedSchema = Object.create(null);
  const definitions: Definitions = Object.create(null);

  // TODO: test that this works?
  if ('defaultValue' in type && type.defaultValue !== undefined) {
    definition.default = type.defaultValue as JSONSchema4Type | undefined;
  }

  if (isEnumType(type)) {
    definition.enum = type.getValues().map(val => val.name);
    if (!isNonNull) {
      definition.enum.push(null);
    }
  }

  if (isScalarType(type)) {
    // default scalars
    if (scalarTypesMap[type.name]) {
      if (isNonNull) {
        definition.type = scalarTypesMap[type.name];
      } else {
        definition.type = [scalarTypesMap[type.name], 'null'];
      }
    } else {
      if (options?.customScalarSchemas?.[type.name]) {
        // deep clone
        definition = JSON.parse(
          JSON.stringify(options.customScalarSchemas[type.name]),
        );
      } else {
        definition.type = ['string', 'number', 'boolean', 'integer'];
      }
      if (!isNonNull) {
        if (Array.isArray(definition.type)) {
          definition.type.push('null');
        } else if (definition.type) {
          definition.type = [definition.type, 'null'];
        } else if (definition.oneOf) {
          definition.oneOf.push({ type: 'null' });
        } else {
          definition = {
            oneOf: [definition, { type: 'null' }],
          };
        }
      }
    }
  }

  if (isListType(type)) {
    if (isNonNull) {
      definition.type = 'array';
    } else {
      definition.type = ['array', 'null'];
    }

    const { definition: def, definitions: defs } = getJSONSchemaFromGraphQLType(
      type.ofType,
      options,
    );
    if (def.$ref) {
      definition.items = { $ref: def.$ref };
    } else if (def.oneOf) {
      definition.items = { oneOf: def.oneOf };
    } else {
      definition.items = def;
    }
    if (defs) {
      for (const defName of Object.keys(defs)) {
        definitions[defName] = defs[defName];
      }
    }
  }

  if (isNonNullType(type)) {
    required = true;
    const { definition: def, definitions: defs } = getJSONSchemaFromGraphQLType(
      type.ofType,
      options,
      true,
    );
    definition = def;
    if (defs) {
      for (const defName of Object.keys(defs)) {
        definitions[defName] = defs[defName];
      }
    }
  }

  if (isInputObjectType(type)) {
    if (isNonNull) {
      definition.$ref = `#/definitions/${type.name}`;
    } else {
      definition.oneOf = [
        { $ref: `#/definitions/${type.name}` },
        { type: 'null' },
      ];
    }
    if (options?.definitionMarker?.mark(type.name)) {
      const fields = type.getFields();

      const fieldDef: PropertiedJSON6 = {
        type: 'object',
        properties: {},
        required: [],
      };
      if (type.description) {
        fieldDef.description =
          type.description + '\n' + renderTypeToString(type);
        if (options?.useMarkdownDescription) {
          // @ts-expect-error
          fieldDef.markdownDescription =
            type.description + '\n' + renderTypeToString(type, true);
        }
      } else {
        fieldDef.description = renderTypeToString(type);
        if (options?.useMarkdownDescription) {
          // @ts-expect-error
          fieldDef.markdownDescription = renderTypeToString(type, true);
        }
      }

      for (const fieldName of Object.keys(fields)) {
        const field = fields[fieldName];
        const {
          required: fieldRequired,
          definition: typeDefinition,
          definitions: typeDefinitions,
        } = getJSONSchemaFromGraphQLType(field.type, options);

        const {
          definition: fieldDefinition,
          // definitions: fieldDefinitions,
        } = getJSONSchemaFromGraphQLType(field, options);

        fieldDef.properties[fieldName] = {
          ...typeDefinition,
          ...fieldDefinition,
        } as JSONSchema6;

        const renderedField = renderTypeToString(field.type);
        fieldDef.properties[fieldName].description = field.description
          ? field.description + '\n' + renderedField
          : renderedField;
        if (options?.useMarkdownDescription) {
          const renderedFieldMarkdown = renderTypeToString(field.type, true);
          fieldDef.properties[
            fieldName
            // @ts-expect-error
          ].markdownDescription = field.description
            ? field.description + '\n' + renderedFieldMarkdown
            : renderedFieldMarkdown;
        }

        if (fieldRequired) {
          fieldDef.required!.push(fieldName);
        }
        if (typeDefinitions) {
          for (const [defName, value] of Object.entries(typeDefinitions)) {
            definitions[defName] = value;
          }
        }
      }
      definitions[type.name] = fieldDef;
    }
  }

  if (!isNonNull) {
    const ofType = isNonNullType(type) ? type.ofType : type;

    // append to type descriptions
    if (
      'description' in ofType &&
      !isScalarType(ofType) &&
      ofType.description &&
      !definition.description
    ) {
      definition.description =
        ofType.description + '\n' + renderTypeToString(type);
      if (options?.useMarkdownDescription) {
        // @ts-expect-error
        definition.markdownDescription =
          ofType.description + '\n' + renderTypeToString(type, true);
      }
    } else if (definition.description) {
      // append type to schema description
      definition.description += '\n' + renderTypeToString(type);
      if (options?.useMarkdownDescription) {
        // @ts-expect-error
        definition.markdownDescription =
          definition.description + '\n' + renderTypeToString(type, true);
      }
    } else {
      definition.description = renderTypeToString(type);
      if (options?.useMarkdownDescription) {
        // @ts-expect-error
        definition.markdownDescription = renderTypeToString(type, true);
      }
    }
  }

  return { required, definition, definitions };
}

/**
 * Generates a JSONSchema6 valid document for operation(s) from a map of Map<string, GraphQLInputType>.
 *
 * It generates referenced Definitions for each type, so that no graphql types are repeated.
 *
 * Note: you must install `@types/json-schema` if you want a valid result type
 *
 * @param facts {OperationFacts} the result of getOperationFacts, or getOperationASTFacts
 * @returns {JSONSchema6}'
 *
 * @example
 * simple usage:
 *
 * ```ts
 * import { parse } from 'graphql'
 * import { collectVariables, getVariablesJSONSchema } from 'graphql-language-service'
 * const variablesToType = collectVariables(parse(query), schema)
 * const JSONSchema6Result = getVariablesJSONSchema(variablesToType, schema)
 * ```
 *
 * @example
 * advanced usage:
 * ```ts
 *
 * import { parse } from 'graphql'
 * import { collectVariables, getVariablesJSONSchema } from 'graphql-language-service'
 * const variablesToType = collectVariables(parse(query), schema)
 *
 * // you can append `markdownDescription` to JSON schema, which  monaco-json uses.
 * const JSONSchema6Result = getVariablesJSONSchema(variablesToType, schema, { useMarkdownDescription: true })
 *
 * // let's say we want to use it with an IDE extension that expects a JSON file
 * // the resultant object literal can be written to string
 * import fs from 'fs/promises'
 * await fs.writeFile('operation-schema.json', JSON.stringify(JSONSchema6Result, null, 2))
 * ```
 */
export function getVariablesJSONSchema(
  variableToType: VariableToType,
  options?: JSONSchemaOptions,
): JSONSchema6 {
  const jsonSchema: PropertiedJSON6 = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {},
    required: [],
  };

  const runtimeOptions: JSONSchemaRunningOptions = {
    ...options,
    definitionMarker: new Marker(),
  };

  if (variableToType) {
    // I would use a reduce here, but I wanted it to be readable.
    for (const [variableName, type] of Object.entries(variableToType)) {
      const { definition, required, definitions } =
        getJSONSchemaFromGraphQLType(type, runtimeOptions);
      jsonSchema.properties[variableName] = definition;
      if (required) {
        jsonSchema.required?.push(variableName);
      }
      if (definitions) {
        jsonSchema.definitions = { ...jsonSchema?.definitions, ...definitions };
      }
    }
  }
  return jsonSchema;
}
