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
        'invisible pointer-events-none absolute z-50 whitespace-nowrap rounded-md border border-stroke bg-dialog px-2 py-1 text-xs font-normal text-fg opacity-0 shadow-flyout transition-[opacity,visibility] duration-100 group-hover/tip:visible group-hover/tip:opacity-100 group-hover/tip:delay-500',
        side === 'bottom' ? 'top-full mt-1.5' : 'bottom-full mb-1.5',
        align === 'center' && 'left-1/2 -translate-x-1/2',
        align === 'start' && 'left-0',
        align === 'end' && 'right-0',
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
        'group/tip relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md text-[13px] text-fg transition-colors hover:bg-subtle active:bg-subtle-press disabled:pointer-events-none disabled:opacity-35',
        size === 'md' ? 'h-9 min-w-9 px-2' : 'h-7 min-w-7 px-1.5',
        active && 'bg-accent-soft text-accent hover:bg-accent-soft',
        className,
      )}
    >
      <Icon size={size === 'md' ? 18 : 16} strokeWidth={1.6} className={iconClassName} />
      {showLabel && (
        <span
          className={cn(
            showLabel === 'always' && 'inline',
            showLabel === 'sm' && 'hidden sm:inline',
            showLabel === 'lg' && 'hidden lg:inline',
            showLabel === 'xl' && 'hidden xl:inline',
          )}
        >
          {label}
        </span>
      )}
      {trailing}
      {!noTip && (
        <Tip side={tipSide} align={tipAlign}>
          {label}
          {shortcut && <span className="ml-2 text-fg3">{shortcut}</span>}
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
      className={cn(
        'inline-flex h-8 cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap rounded-[5px] px-4 text-[13px] transition-colors disabled:pointer-events-none disabled:opacity-40',
        variant === 'standard' &&
          'border border-stroke bg-card text-fg shadow-[0_1px_0_var(--stroke)] hover:bg-card-hover active:text-fg2',
        variant === 'accent' && 'border border-transparent bg-accent text-on-accent hover:bg-accent-hover active:opacity-90',
        variant === 'subtle' && 'text-fg hover:bg-subtle active:bg-subtle-press',
        variant === 'danger' && 'border border-transparent bg-danger text-white hover:brightness-110',
        className,
      )}
    />
  );
}

export function Sep({ className }: { className?: string }) {
  return <div className={cn('mx-1 h-5 w-px shrink-0 bg-stroke', className)} />;
}
