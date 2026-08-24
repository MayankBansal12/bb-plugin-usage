import { cn } from "../../lib/utils";
import { CONTROL_HOVER_TRANSITION } from "./motion.js";

export type ToggleGroupOption<T extends string | number> = {
  value: T;
  label: string;
};

type ToggleGroupLayoutProps<T extends string | number> = {
  value: T;
  options: Array<ToggleGroupOption<T>>;
  fill?: boolean;
};

export type ToggleGroupProps<T extends string | number> =
  ToggleGroupLayoutProps<T> & {
    onChange: (value: T) => void;
    label: string;
  };

const ROOT_CLASSES =
  "grid h-8 items-center gap-0.5 rounded-lg border border-border p-0.5";

function rootClassName(fill: boolean) {
  return cn(ROOT_CLASSES, fill ? "w-full" : "w-max");
}

function gridStyle(count: number) {
  return { gridTemplateColumns: `repeat(${Math.max(1, count)}, 1fr)` };
}

function itemClassName(active: boolean, interactive: boolean) {
  return cn(
    "inline-flex h-full min-w-[56px] items-center justify-center whitespace-nowrap rounded-md px-3 text-xs font-medium leading-none",
    active
      ? "bg-state-active text-foreground"
      : "text-muted-foreground",
    interactive && [
      CONTROL_HOVER_TRANSITION,
      "outline-none hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
    ],
  );
}

/**
 * A compact, single-choice control using BB's shared interactive-state colors.
 */
export function ToggleGroup<T extends string | number>({
  value,
  options,
  onChange,
  label,
  fill = false,
}: ToggleGroupProps<T>) {
  return (
    <div
      className={rootClassName(fill)}
      style={gridStyle(options.length)}
      role="group"
      aria-label={label}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={itemClassName(active, true)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** Non-interactive counterpart used while the surrounding view is loading. */
export function ToggleGroupPreview<T extends string | number>({
  value,
  options,
  fill = false,
}: ToggleGroupLayoutProps<T>) {
  return (
    <div
      aria-hidden="true"
      className={rootClassName(fill)}
      style={gridStyle(options.length)}
    >
      {options.map((option) => (
        <span
          key={option.value}
          className={itemClassName(option.value === value, false)}
        >
          {option.label}
        </span>
      ))}
    </div>
  );
}
