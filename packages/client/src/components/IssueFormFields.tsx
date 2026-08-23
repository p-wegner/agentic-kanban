import type { CreateIssueRequest, IssueEstimate } from "@agentic-kanban/shared";
import { ISSUE_TYPES, issueTypeLabel } from "@agentic-kanban/shared";
import type { IssueTemplate } from "../hooks/useIssueTemplates.js";

/**
 * Field primitives shared by the two create-issue shells (#772).
 *
 * `CreateIssueForm` (the compact inline card on a board column) and `CreateIssuePanel`
 * (the slide-over) are deliberately different components — different focus/keyboard
 * behaviour, different submit payloads, different extra fields. What they had written
 * twice is the *fields*: the same option lists, the same template-confirm, the same
 * thumbnail strip, the same checkbox row. Those live here; the two shells stay separate
 * rather than becoming one component behind a pile of mode flags.
 *
 * Every primitive takes its own `className` because the two shells are sized differently
 * (text-xs inline vs text-sm panel) — that is presentation, not a behaviour switch.
 */

interface PastedImageStripProps {
  images: string[];
  onRemove: (index: number) => void;
  className?: string;
  imageClassName?: string;
}

/** Thumbnails for screenshots pasted into the description, each with a remove badge. */
export function PastedImageStrip({
  images,
  onRemove,
  className = "flex flex-wrap gap-2",
  imageClassName = "h-12 w-auto rounded border border-gray-200 dark:border-gray-700 object-cover",
}: PastedImageStripProps) {
  if (images.length === 0) return null;
  return (
    <div className={className}>
      {images.map((url, i) => (
        <div key={i} className="relative group">
          <img src={url} alt={`screenshot-${i + 1}`} className={imageClassName} />
          <button
            type="button"
            onClick={() => onRemove(i)}
            className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-red-500 text-white rounded-full text-xs leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
          >×</button>
        </div>
      ))}
    </div>
  );
}

interface IssueTemplateSelectProps {
  templates: IssueTemplate[];
  /** Current description — a non-empty one prompts before it is replaced. */
  description: string;
  onApply: (body: string) => void;
  className: string;
}

/** "Template..." picker that replaces the description, confirming first if it has text. */
export function IssueTemplateSelect({ templates, description, onApply, className }: IssueTemplateSelectProps) {
  if (templates.length === 0) return null;
  return (
    <select
      value=""
      onChange={(e) => {
        const tpl = templates.find((t) => t.id === e.target.value);
        if (!tpl) return;
        if (description.trim() && !window.confirm("Replace current description with the template?")) return;
        onApply(tpl.body);
      }}
      className={className}
      title="Apply a template to the description"
    >
      <option value="">Template...</option>
      {templates.map((t) => (
        <option key={t.id} value={t.id}>{t.name}</option>
      ))}
    </select>
  );
}

interface IssueTypeSelectProps {
  value: CreateIssueRequest["issueType"];
  onChange: (value: CreateIssueRequest["issueType"]) => void;
  className: string;
}

export function IssueTypeSelect({ value, onChange, className }: IssueTypeSelectProps) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as CreateIssueRequest["issueType"])}
      className={className}
    >
      {ISSUE_TYPES.map((t) => (
        <option key={t} value={t}>{issueTypeLabel(t)}</option>
      ))}
    </select>
  );
}

const ESTIMATES: IssueEstimate[] = ["XS", "S", "M", "L", "XL"];

interface IssueEstimateSelectProps {
  value: IssueEstimate | "";
  onChange: (value: IssueEstimate | "") => void;
  className: string;
  /** Label for "no estimate" — the panel labels the field, the inline card does not. */
  emptyLabel: string;
  title?: string;
}

export function IssueEstimateSelect({ value, onChange, className, emptyLabel, title }: IssueEstimateSelectProps) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as IssueEstimate | "")}
      className={className}
      title={title}
    >
      <option value="">{emptyLabel}</option>
      {ESTIMATES.map((e) => (
        <option key={e} value={e}>{e}</option>
      ))}
    </select>
  );
}

export interface AgentSkillOption {
  id: string;
  name: string;
  description: string | null;
}

interface SkillSelectProps {
  skills: AgentSkillOption[];
  value: string;
  onChange: (value: string) => void;
  className: string;
}

/** Optional agent skill to launch the workspace with. Renders nothing when none exist. */
export function SkillSelect({ skills, value, onChange, className }: SkillSelectProps) {
  if (skills.length === 0) return null;
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={className}>
      <option value="">None</option>
      {skills.map((s) => (
        <option key={s.id} value={s.id}>{s.name}</option>
      ))}
    </select>
  );
}

interface AgentOptionCheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  className: string;
}

/** One of the start-workspace option checkboxes (plan mode / skip review / direct). */
export function AgentOptionCheckbox({ checked, onChange, label, className }: AgentOptionCheckboxProps) {
  return (
    <label className={className}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="rounded border-gray-300 text-brand-600 focus:ring-brand-500"
      />
      {label}
    </label>
  );
}
