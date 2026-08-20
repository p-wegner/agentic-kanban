import { REPO_TAG_COLOR } from "@agentic-kanban/shared/lib/repo-tags";

interface ReposTouchedFieldProps {
  /** The project's repos (leading + siblings). */
  repos: string[];
  /** Currently-selected repo names. */
  selected: string[];
  onChange: (next: string[]) => void;
  /** Label text (defaults to "Repos touched"). */
  label?: string;
}

/**
 * The "Repos touched" multi-select (#94) — toggle chips of the project's registered
 * repos. Rendered only for multi-repo projects (caller gates on `isMultiRepo`), so
 * single-repo authoring is unchanged. Selected repos become `repo:<name>` tags →
 * chips on the card/detail.
 */
export function ReposTouchedField({ repos, selected, onChange, label = "Repos touched" }: ReposTouchedFieldProps) {
  function toggle(repo: string) {
    onChange(selected.includes(repo) ? selected.filter((r) => r !== repo) : [...selected, repo]);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-gray-600 dark:text-gray-400">{label}</label>
      <div className="flex flex-wrap gap-1.5">
        {repos.map((repo) => {
          const on = selected.includes(repo);
          return (
            <button
              key={repo}
              type="button"
              onClick={() => toggle(repo)}
              aria-pressed={on}
              className={`text-xs px-2 py-1 rounded-full border transition-colors ${
                on
                  ? "border-transparent font-medium"
                  : "border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:border-brand-400"
              }`}
              style={on ? { backgroundColor: REPO_TAG_COLOR + "22", color: REPO_TAG_COLOR } : undefined}
              title={on ? `Touching ${repo}` : `Mark ${repo} as touched`}
            >
              {on ? "✓ " : ""}repo:{repo}
            </button>
          );
        })}
      </div>
    </div>
  );
}
