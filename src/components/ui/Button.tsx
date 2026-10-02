import type { LucideIcon } from 'lucide-react';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../utils/cn';

export function Tip({
  children,
  side = 'bottom',
  align = 'center',
}: {
  children: ReactNode;
  side?: 'top' | 'bottom';
  align?: 'start' | 'center' | 'end';
}) {
  return (
    <span
      role="tooltip"
      className={cn(
        'tip',
        side === 'bottom' ? 'tip--bottom' : 'tip--top',
        align === 'center' ? 'tip--center' : align === 'start' ? 'tip--start' : 'tip--end',
      )}
    >
      {children}
    </span>
  );
}

interface ToolButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: LucideIcon;
  label: string;
  shortcut?: string;
  active?: boolean;
  showLabel?: 'always' | 'sm' | 'lg' | 'xl';
  tipSide?: 'top' | 'bottom';
  tipAlign?: 'start' | 'center' | 'end';
  iconClassName?: string;
  size?: 'md' | 'sm';
  trailing?: ReactNode;
  noTip?: boolean;
}

export const ToolButton = forwardRef<HTMLButtonElement, ToolButtonProps>(function ToolButton(
  {
    icon: Icon,
    label,
    shortcut,
    active,
    showLabel,
    tipSide = 'bottom',
    tipAlign = 'center',
    className,
    iconClassName,
    size = 'md',
    trailing,
    noTip,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={active}
      {...rest}
      className={cn(
        'tool-btn',
        size === 'md' ? 'tool-btn--md' : 'tool-btn--sm',
        active && 'tool-btn--active',
        className,
      )}
    >
      <Icon size={size === 'md' ? 18 : 16} strokeWidth={1.6} className={iconClassName} />
      {showLabel && (
        <span className={cn('tool-btn-label', showLabel !== 'always' && `tool-btn-label--${showLabel}`)}>
          {label}
        </span>
      )}
      {trailing}
      {!noTip && (
        <Tip side={tipSide} align={tipAlign}>
          {label}
          {shortcut && <span className="tip-hint">{shortcut}</span>}
        </Tip>
      )}
    </button>
  );
});

export type ButtonVariant = 'standard' | 'accent' | 'subtle' | 'danger';

export function Button({
  variant = 'standard',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type="button"
      {...rest}
      className={cn('btn', `btn--${variant}`, className)}
    />
  );
}

export function Sep({ className }: { className?: string }) {
  return <div className={cn('sep', className)} />;
}
