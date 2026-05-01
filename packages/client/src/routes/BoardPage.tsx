import { useEffect, useState } from "react";
import { Layout } from "../components/Layout.js";
import { apiFetch } from "../lib/api.js";

interface Issue {
  id: string;
  title: string;
  priority: string;
  statusId: string;
  statusName: string;
  sortOrder: number;
}

interface StatusWithIssues {
  id: string;
  name: string;
  projectId: string;
  sortOrder: number;
  issues: Issue[];
}

interface Project {
  id: string;
  name: string;
}

export function BoardPage() {
  const [columns, setColumns] = useState<StatusWithIssues[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const projects = await apiFetch<Project[]>("/api/projects");
        if (projects.length === 0) return;

        const projectId = projects[0].id;
        const board = await apiFetch<StatusWithIssues[]>(
          `/api/projects/${projectId}/board`,
        );

        setColumns(board);
      } catch (err) {
        console.error("Failed to load board:", err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <Layout>
        <div className="flex items-center justify-center h-96 text-gray-500">
          Loading...
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="flex gap-4 p-6 overflow-x-auto min-h-[calc(100vh-57px)]">
        {columns.map((col) => (
          <div
            key={col.id}
            className="flex-shrink-0 w-72 bg-gray-100 rounded-lg p-3"
          >
            <h2 className="font-medium text-sm text-gray-700 mb-3 px-1">
              {col.name}
              <span className="ml-2 text-gray-400">{col.issues.length}</span>
            </h2>
            <div className="space-y-2">
              {col.issues.map((issue) => (
                <div
                  key={issue.id}
                  className="bg-white rounded-md shadow-sm p-3 border border-gray-200"
                >
                  <p className="text-sm text-gray-900">{issue.title}</p>
                  <span className="text-xs text-gray-400 mt-1 block">
                    {issue.priority}
                  </span>
                </div>
              ))}
              {col.issues.length === 0 && (
                <p className="text-xs text-gray-400 text-center py-4">
                  No issues
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </Layout>
  );
}
