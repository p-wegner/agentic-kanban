import { cronFieldHint, type ScheduleMode } from "../../lib/scheduled-run-form.js";

type ScheduleModeFieldsProps = {
  mode: ScheduleMode;
  onModeChange: (mode: ScheduleMode) => void;
  intervalMinutes: number;
  onIntervalChange: (minutes: number) => void;
  cron: string;
  onCronChange: (cron: string) => void;
  cronPlaceholder: string;
};

/**
 * Shared schedule picker for both the create and edit scheduled-run forms: a
 * mode selector (interval vs cron) plus the matching input and, for cron, a live
 * description / validation-error line. Previously duplicated verbatim in both forms.
 */
export function ScheduleModeFields({ mode, onModeChange, intervalMinutes, onIntervalChange, cron, onCronChange, cronPlaceholder }: ScheduleModeFieldsProps) {
  const hint = cronFieldHint(cron);
  return (
    <>
      <div className="flex items-center gap-2">
        <label className="text-xs text-gray-600">Schedule:</label>
        <select
          value={mode}
          onChange={(e) => onModeChange(e.target.value as ScheduleMode)}
          className="text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-brand-500"
        >
          <option value="interval">Interval (minutes)</option>
          <option value="cron">Cron expression</option>
        </select>
      </div>
      {mode === "interval" ? (
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-600 whitespace-nowrap">Every</label>
          <input
            type="number"
            min={1}
            value={intervalMinutes}
            onChange={(e) => onIntervalChange(Number(e.target.value))}
            className="w-20 text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
          <span className="text-xs text-gray-600">minutes</span>
        </div>
      ) : (
        <div className="space-y-1">
          <input
            type="text"
            value={cron}
            onChange={(e) => onCronChange(e.target.value)}
            placeholder={cronPlaceholder}
            className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 font-mono"
          />
          {hint.show && (
            hint.valid
              ? <p className="text-xs text-green-600">{hint.message}</p>
              : <p className="text-xs text-red-500">{hint.message}</p>
          )}
        </div>
      )}
    </>
  );
}
