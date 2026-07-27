import { BadRequestException } from "@nestjs/common";
import { CustomFieldFilterInput, FieldType } from "./custom-fields.types";

interface DefinitionLookup {
  fieldType: FieldType;
}

interface OperatorClause {
  sql: string;
  values: unknown[];
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new BadRequestException({ error: "Filter value must be a non-empty array" });
  return value.map(String);
}

function buildOperatorClause(alias: string, fieldType: FieldType, filter: CustomFieldFilterInput, nextParamIndex: number): OperatorClause {
  const { operator, value, valueTo } = filter;
  const textExpr = `(${alias}.value #>> '{}')`;
  const p = nextParamIndex;

  switch (operator) {
    case "is_empty":
      return { sql: `${alias}.id IS NULL`, values: [] };
    case "is_not_empty":
      return { sql: `${alias}.id IS NOT NULL`, values: [] };
    case "contains":
      return { sql: `${textExpr} ILIKE '%' || $${p} || '%'`, values: [String(value ?? "")] };
    case "does_not_contain":
      return { sql: `(${alias}.id IS NULL OR ${textExpr} NOT ILIKE '%' || $${p} || '%')`, values: [String(value ?? "")] };
    case "equals":
      if (fieldType === "number") return { sql: `${textExpr}::numeric = $${p}`, values: [Number(value)] };
      return { sql: `${textExpr} = $${p}`, values: [String(value ?? "")] };
    case "is":
      if (fieldType === "multi_select") return { sql: `${alias}.value ? $${p}`, values: [String(value ?? "")] };
      return { sql: `${alias}.value = to_jsonb($${p}::text)`, values: [String(value ?? "")] };
    case "is_not":
      if (fieldType === "multi_select") return { sql: `(${alias}.id IS NULL OR NOT (${alias}.value ? $${p}))`, values: [String(value ?? "")] };
      return { sql: `(${alias}.id IS NULL OR ${alias}.value <> to_jsonb($${p}::text))`, values: [String(value ?? "")] };
    case "includes_any":
      return { sql: `${alias}.value ?| $${p}::text[]`, values: [toStringArray(value)] };
    case "includes_all":
      return { sql: `${alias}.value ?& $${p}::text[]`, values: [toStringArray(value)] };
    case "yes":
      return { sql: `${alias}.value = 'true'::jsonb`, values: [] };
    case "no":
      return { sql: `${alias}.value = 'false'::jsonb`, values: [] };
    case "greater_than":
      return { sql: `${textExpr}::numeric > $${p}`, values: [Number(value)] };
    case "less_than":
      return { sql: `${textExpr}::numeric < $${p}`, values: [Number(value)] };
    case "between":
      if (fieldType === "date") {
        return { sql: `${textExpr}::date BETWEEN $${p}::date AND $${p + 1}::date`, values: [String(value), String(valueTo)] };
      }
      return { sql: `${textExpr}::numeric BETWEEN $${p} AND $${p + 1}`, values: [Number(value), Number(valueTo)] };
    case "before":
      return { sql: `${textExpr}::date < $${p}::date`, values: [String(value)] };
    case "after":
      return { sql: `${textExpr}::date > $${p}::date`, values: [String(value)] };
    case "on":
      return { sql: `${textExpr}::date = $${p}::date`, values: [String(value)] };
    case "is_overdue":
      return { sql: `${textExpr}::date < CURRENT_DATE`, values: [] };
    default:
      throw new BadRequestException({ error: `Unsupported filter operator: ${operator}` });
  }
}

/**
 * Builds one LEFT JOIN per filter condition (each scoped 1:1 by definition_id +
 * testcase_id, so no fan-out/DISTINCT risk) plus the ANDed WHERE clause referencing
 * those joins. `paramIndexStart` is the index of the last already-bound $N placeholder
 * in the caller's query (e.g. `$1` for project_id), so new placeholders continue from
 * `paramIndexStart + 1`.
 */
export function buildCustomFieldFiltersSql(
  filters: CustomFieldFilterInput[],
  definitionsById: Map<string, DefinitionLookup>,
  paramIndexStart: number
): { joinSql: string; whereSql: string; params: unknown[] } {
  if (!filters.length) return { joinSql: "", whereSql: "", params: [] };

  const joins: string[] = [];
  const wheres: string[] = [];
  const params: unknown[] = [];
  let paramIndex = paramIndexStart;

  filters.forEach((filter, i) => {
    const definition = definitionsById.get(filter.definitionId);
    if (!definition) throw new BadRequestException({ error: `Unknown custom field filter: ${filter.definitionId}` });
    const alias = `cfv${i}`;

    paramIndex += 1;
    params.push(filter.definitionId);
    joins.push(`LEFT JOIN custom_field_values ${alias} ON ${alias}.testcase_id = testcases.id AND ${alias}.definition_id = $${paramIndex}`);

    const clause = buildOperatorClause(alias, definition.fieldType, filter, paramIndex + 1);
    wheres.push(clause.sql);
    params.push(...clause.values);
    paramIndex += clause.values.length;
  });

  return { joinSql: joins.join(" "), whereSql: wheres.join(" AND "), params };
}
