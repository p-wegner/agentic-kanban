import { useState } from "react";
import type { CreateIssueRequest } from "@agentic-kanban/shared";

interface CreateIssueFormProps {
  projectId: string;
  statusId: string;
  onSubmit: (data: CreateIssueRequest) => Promise<void>;
  onCancel: () => void;
}

export function CreateIssueForm({
  projectId,
  statusId,
  onSubmit,
  onCancel,
}: CreateIssueFormProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<CreateIssueRequest["priority"]>("medium");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit({
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        statusId,
        projectId,
      });
    } finally {
      setSubmitting(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      onCancel();
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      onKeyDown={handleKeyDown}
      className="bg-white rounded-md shadow-sm p-3 border border-blue-200 space-y-2"
    >
      <input
        type="text"
        placeholder="Issue title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        autoFocus
        className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
      <textarea
        placeholder="Description (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={2}
        className="w-full text-xs border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
      />
      <select
        value={priority}
        onChange={(e) => setPriority(e.target.value as CreateIssueRequest["priority"])}
        className="w-full text-xs border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
      >
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
        <option value="critical">Critical</option>
      </select>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!title.trim() || submitting}
          className="text-xs bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? "Adding..." : "Add"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-gray-500 px-3 py-1.5 hover:text-gray-700"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
