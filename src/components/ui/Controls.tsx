import { ChevronDown, type LucideIcon } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { cn } from '../../utils/cn';

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  className,
  disabled,
  onDoubleClick,
  ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  className?: string;
  disabled?: boolean;
  onDoubleClick?: () => void;
  ariaLabel?: string;
}) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <input
      type="range"
      aria-label={ariaLabel}
      className={cn('win-slider', className)}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      onDoubleClick={onDoubleClick}
      style={{ '--pct': `${Math.min(100, Math.max(0, pct))}%` } as CSSProperties}
    />
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'group/t relative inline-flex h-5 w-10 shrink-0 cursor-pointer items-center rounded-full border transition-colors disabled:pointer-events-none disabled:opacity-40',
        checked ? 'border-transparent bg-accent hover:bg-accent-hover' : 'border-fg2 bg-transparent hover:bg-subtle',
      )}
    >
      <span
        className={cn(
          'absolute rounded-full transition-all duration-150',
          checked
            ? 'left-[23px] h-3 w-3 bg-on-accent group-hover/t:left-[22px] group-hover/t:h-3.5 group-hover/t:w-3.5'
            : 'left-[4px] h-3 w-3 bg-fg2 group-hover/t:h-3.5 group-hover/t:w-3.5',
        )}
      />
    </button>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: { value: T; label: ReactNode; icon?: LucideIcon }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={cn('inline-flex shrink-0 rounded-md border border-stroke bg-card p-0.5', className)}>
      {options.map((o) => {
        const Icon = o.icon;
        return (
          <button
            key={String(o.value)}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex h-7 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[4px] px-3 text-[13px] transition-colors',
              o.value === value ? 'bg-accent text-on-accent' : 'text-fg hover:bg-subtle',
            )}
          >
            {Icon && <Icon size={14} strokeWidth={1.8} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={cn('relative', className)}>
      <select
        value={String(value)}
        onChange={(e) => {
          const o = options.find((x) => String(x.value) === e.target.value);
          if (o) onChange(o.value);
        }}
        className="h-8 w-full appearance-none rounded-[5px] border border-stroke bg-card pl-3 pr-8 text-[13px] text-fg outline-none hover:bg-card-hover focus:border-accent"
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown size={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-fg2" />
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="inline-flex cursor-default select-none items-center gap-2.5 text-[13px] text-fg">
      <span
        className={cn(
          'flex h-[18px] w-[18px] items-center justify-center rounded-[4px] border transition-colors',
          checked ? 'border-transparent bg-accent text-on-accent' : 'border-fg2 bg-transparent',
        )}
      >
        {checked && (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M2.5 6.2l2.3 2.3 4.7-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <input type="checkbox" className="sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

/** 键帽：展示快捷键的组合键 */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cn('kbd', className)}>{children}</kbd>;
}
