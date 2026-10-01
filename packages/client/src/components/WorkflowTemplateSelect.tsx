import { useApiResource } from "../hooks/useApiResource.js";

interface WorkflowTemplateOption {
  id: string;
  name: string;
}

/**
 * Workflow-template picker for the slide-over create panel (#1270). Renders nothing until the
 * project has at least one template; the empty option means the issue type's default workflow.
 */
export function WorkflowTemplateSelect({ projectId, value, onChange, selectClassName }: {
  projectId: string | undefined;
  value: string;
  onChange: (id: string) => void;
  selectClassName: string;
}) {
  const { data: templates } = useApiResource<WorkflowTemplateOption[]>(
    projectId ? `/api/workflows/templates?projectId=${projectId}` : null,
    { fallbackError: "Failed to load workflow templates" },
  );
  if (!templates || templates.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 flex-1">
      <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Workflow</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full ${selectClassName}`}
        aria-label="Workflow"
      >
        <option value="">Default workflow</option>
        {templates.map((t) => (
          <option key={t.id} value={t.id}>{t.name}</option>
        ))}
      </select>
    </div>
  );
}
