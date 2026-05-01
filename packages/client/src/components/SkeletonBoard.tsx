export function SkeletonBoard() {
  return (
    <div className="flex gap-4 p-6 overflow-x-auto min-h-[calc(100vh-105px)]">
      {Array.from({ length: 5 }).map((_, colIdx) => (
        <div key={colIdx} className="flex-shrink-0 w-72 bg-gray-100 rounded-lg p-3">
          <div className="flex items-center justify-between mb-3 px-1">
            <div className="h-4 w-24 bg-gray-200 rounded animate-pulse" />
          </div>
          <div className="space-y-2">
            {Array.from({ length: colIdx === 0 ? 3 : 1 }).map((_, cardIdx) => (
              <div key={cardIdx} className="bg-white rounded-md p-3 border border-gray-200">
                <div className="h-3.5 w-3/4 bg-gray-200 rounded animate-pulse mb-2" />
                <div className="h-3 w-1/3 bg-gray-200 rounded animate-pulse" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
