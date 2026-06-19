/** Lightweight fallback shown for the ~1 frame it takes to fetch a lazy view chunk. */
export function ViewLoadingFallback() {
  return (
    <div className="flex-1 min-h-0 flex items-center justify-center text-gray-400 dark:text-gray-500">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-current border-t-transparent" aria-label="Loading view" />
    </div>
  );
}
