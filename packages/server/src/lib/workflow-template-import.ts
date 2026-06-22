/**
 * Pure helpers for importing a workflow template from an arbitrary JSON payload.
 *
 * Extracted verbatim from the two byte-identical copies that previously lived in
 * `services/workflow.service.ts` and `cli/commands/workflow.ts`. Both consumers now
 * import from here so the normalization + validation rules can never drift apart.
 */

import type { TemplateNodeInput, TemplateEdgeInput } from "@agentic-kanban/shared/lib/workflow-engine";

/**
 * Structural view of the dynamic JSON payload accepted by an import. Every field
 * is optional because the source is arbitrary user-supplied JSON; the values are
 * narrowed downstream by `validateImportedTemplate`.
 */
interface RawTemplateImport {
  template?: RawTemplateImport;
  workflow?: RawTemplateImport;
  metadata?: RawTemplateImport;
  name?: string;
  description?: string | null;
  ticketType?: string | null;
  isDefault?: boolean;
  nodes?: TemplateNodeInput[];
  edges?: TemplateEdgeInput[];
}

export function normalizeImportedTemplate(input: unknown) {
  const root = (input ?? {}) as RawTemplateImport;
  const source = root.template ?? root.workflow ?? root;
  const metadata = source.metadata ?? source ?? {};
  return {
    name: root.name ?? source.name ?? metadata.name ?? "",
    description: root.description ?? source.description ?? metadata.description ?? null,
    ticketType: root.ticketType ?? source.ticketType ?? metadata.ticketType ?? null,
    isDefault: root.isDefault ?? source.isDefault ?? metadata.isDefault ?? false,
    nodes: source.nodes ?? [],
    edges: source.edges ?? [],
  };
}

export type ImportedTemplateSpec = ReturnType<typeof normalizeImportedTemplate>;

export function validateImportedTemplate(spec: ImportedTemplateSpec): string[] {
  const errors: string[] = [];
  if (typeof spec.name !== "string" || spec.name.trim().length === 0) {
    errors.push("Imported workflow name is required.");
  }
  if (!Array.isArray(spec.nodes)) {
    errors.push("Imported workflow nodes must be an array.");
  } else {
    spec.nodes.forEach((node, index) => {
      if (!node || typeof node !== "object") {
        errors.push(`Imported workflow node at index ${index} must be an object.`);
        return;
      }
      if (typeof node.id !== "string" || node.id.trim().length === 0) {
        errors.push(`Imported workflow node at index ${index} must have a non-empty string id.`);
      }
      if (typeof node.nodeType !== "string" || node.nodeType.trim().length === 0) {
        errors.push(`Imported workflow node at index ${index} must have a non-empty string nodeType.`);
      }
    });
  }
  if (!Array.isArray(spec.edges)) {
    errors.push("Imported workflow edges must be an array.");
  } else {
    spec.edges.forEach((edge, index) => {
      if (!edge || typeof edge !== "object") {
        errors.push(`Imported workflow edge at index ${index} must be an object.`);
        return;
      }
      if (typeof edge.fromNodeId !== "string" || edge.fromNodeId.trim().length === 0) {
        errors.push(`Imported workflow edge at index ${index} must have a non-empty string fromNodeId.`);
      }
      if (typeof edge.toNodeId !== "string" || edge.toNodeId.trim().length === 0) {
        errors.push(`Imported workflow edge at index ${index} must have a non-empty string toNodeId.`);
      }
    });
  }
  return errors;
}
