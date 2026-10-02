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
      className={cn('toggle', checked ? 'toggle--on' : 'toggle--off')}
    >
      <span className="toggle-thumb" />
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
    <div className={cn('segmented', className)}>
      {options.map((o) => {
        const Icon = o.icon;
        return (
          <button
            key={String(o.value)}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn('seg-item', o.value === value ? 'seg-item--on' : 'seg-item--off')}
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
    <div className={cn('u-relative', className)}>
      <select
        value={String(value)}
        onChange={(e) => {
          const o = options.find((x) => String(x.value) === e.target.value);
          if (o) onChange(o.value);
        }}
        className="select"
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown size={14} className="select-caret" />
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
    <label className="checkbox">
      <span className={cn('checkbox-box', checked ? 'checkbox-box--on' : 'checkbox-box--off')}>
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
