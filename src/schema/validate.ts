// validate.ts - minimal, dependency-free JSON Schema validator.
//
// WHY THIS EXISTS: holdco has a zero-runtime-dependency rule, so pulling in
// ajv (or any json-schema library) is off the table. This module implements
// EXACTLY the draft-07 subset that the schemas under schema/ use - nothing
// more:
//
//   type       - "string" | "number" | "integer" | "boolean" | "object" |
//                "array" | "null", or an array of those
//   enum, const
//   properties, required, additionalProperties (boolean form only)
//   items      - single-schema form only (no tuple validation)
//   pattern, minimum, minLength
//   anyOf
//
// Any keyword outside that list is intentionally ignored. Do NOT add new
// keywords to files in schema/ without teaching this validator first -
// tests/schema.test.ts exercises every keyword above and walks all fixtures.

import * as fs from "node:fs";

export interface ValidationResult {
	valid: boolean;
	errors: string[];
}

/** Human-readable runtime type of a JSON value (for error messages). */
function describe(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

/** Does `value` satisfy one JSON Schema `type` name? */
function matchesType(expected: string, value: unknown): boolean {
	switch (expected) {
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number";
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "null":
			return value === null;
		case "object":
			return typeof value === "object" && value !== null && !Array.isArray(value);
		case "array":
			return Array.isArray(value);
		default:
			return false;
	}
}

/** Structural equality for enum/const (JSON values only). */
function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== typeof b || a === null || b === null) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((v, i) => deepEqual(v, b[i]));
	}
	if (typeof a === "object") {
		const ka = Object.keys(a as object);
		const kb = Object.keys(b as object);
		if (ka.length !== kb.length) return false;
		return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
	}
	return false;
}

function validateAt(schema: any, value: unknown, path: string, errors: string[]): void {
	if (schema === true || schema === null || schema === undefined) return;
	const at = path || "/";

	// anyOf - at least one branch must validate cleanly.
	if (Array.isArray(schema.anyOf)) {
		const matched = schema.anyOf.some((branch: any) => {
			const sub: string[] = [];
			validateAt(branch, value, path, sub);
			return sub.length === 0;
		});
		if (!matched) {
			errors.push(`${at}: value ${JSON.stringify(value)} matches none of the ${schema.anyOf.length} anyOf branches`);
		}
	}

	// type - on mismatch, stop here: every further keyword would just cascade.
	if (schema.type !== undefined) {
		const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
		if (!types.some((t) => matchesType(t, value))) {
			errors.push(`${at}: expected ${types.join("|")}, got ${describe(value)}`);
			return;
		}
	}

	if (schema.enum !== undefined && !schema.enum.some((e: unknown) => deepEqual(e, value))) {
		errors.push(`${at}: value ${JSON.stringify(value)} not in enum [${schema.enum.map((e: unknown) => JSON.stringify(e)).join(", ")}]`);
	}
	if (schema.const !== undefined && !deepEqual(schema.const, value)) {
		errors.push(`${at}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
	}

	if (typeof value === "string") {
		if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
			errors.push(`${at}: string ${JSON.stringify(value)} does not match pattern ${schema.pattern}`);
		}
		if (schema.minLength !== undefined && value.length < schema.minLength) {
			errors.push(`${at}: string length ${value.length} < minLength ${schema.minLength}`);
		}
	}

	if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
		errors.push(`${at}: ${value} < minimum ${schema.minimum}`);
	}

	if (Array.isArray(value) && schema.items !== undefined) {
		value.forEach((item, i) => validateAt(schema.items, item, `${path}/${i}`, errors));
	}

	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		const obj = value as Record<string, unknown>;
		const props: Record<string, unknown> = schema.properties ?? {};
		if (Array.isArray(schema.required)) {
			for (const key of schema.required) {
				if (!(key in obj)) errors.push(`${at}: missing required property "${key}"`);
			}
		}
		for (const [key, propSchema] of Object.entries(props)) {
			if (key in obj) validateAt(propSchema, obj[key], `${path}/${key}`, errors);
		}
		if (schema.additionalProperties === false) {
			for (const key of Object.keys(obj)) {
				if (!(key in props)) errors.push(`${at}: unexpected additional property "${key}"`);
			}
		}
	}
}

/** Validate `value` against a (parsed) schema. Errors carry JSON-pointer-ish
 *  paths, e.g. `/usage/cost_usd: expected number, got string`. */
export function validate(schema: any, value: unknown): ValidationResult {
	const errors: string[] = [];
	validateAt(schema, value, "", errors);
	return { valid: errors.length === 0, errors };
}

/** Convenience: read + parse a schema file, then validate. Throws only on an
 *  unreadable/unparsable schema file (that is a programmer error, not data). */
export function validateFile(schemaPath: string, value: unknown): ValidationResult {
	const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
	return validate(schema, value);
}
