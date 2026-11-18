/**
 * Modal dialog: rendered in a portal, traps focus, closes on Escape and on
 * backdrop click, restores focus to the trigger when closed.
 */
import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import { IconButton } from './Button';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons row at the bottom. */
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Prevents closing with Escape/backdrop while something is in flight. */
  busy?: boolean;
  role?: 'dialog' | 'alertdialog';
}

const widths = { sm: 'sm:max-w-md', md: 'sm:max-w-lg', lg: 'sm:max-w-2xl' };

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  busy,
  role = 'dialog',
}: DialogProps) {
  const titleId = useId();
  const descId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  // Latest callbacks for the keydown listener, without re-running the effect.
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
    busyRef.current = busy;
  });

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    // Focus the first form control, else the first focusable element.
    const first =
      panel?.querySelector<HTMLElement>(
        '[data-autofocus], input:not([disabled]), select, textarea',
      ) ?? panel?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) {
        event.stopPropagation();
        onCloseRef.current();
      }
      if (event.key === 'Tab' && panel) {
        const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (items.length === 0) return;
        const firstItem = items[0]!;
        const lastItem = items[items.length - 1]!;
        if (event.shiftKey && document.activeElement === firstItem) {
          event.preventDefault();
          lastItem.focus();
        } else if (!event.shiftKey && document.activeElement === lastItem) {
          event.preventDefault();
          firstItem.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = overflow;
      previouslyFocused?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
        aria-hidden
        onClick={() => !busy && onClose()}
      />
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className={cn(
          'relative flex max-h-[92vh] w-full flex-col rounded-t-2xl border border-border bg-surface shadow-2xl sm:rounded-2xl',
          widths[size],
        )}
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold text-fg">
              {title}
            </h2>
            {description ? (
              <p id={descId} className="mt-1 text-sm text-fg-muted">
                {description}
              </p>
            ) : null}
          </div>
          <IconButton
            icon="x"
            label={t('common.close')}
            size="sm"
            onClick={onClose}
            disabled={busy}
            className="-mt-1 -mr-2"
          />
        </div>
        {children ? <div className="overflow-y-auto px-5 pb-5">{children}</div> : null}
        {footer ? (
          <div className="flex flex-col-reverse gap-2 border-t border-border bg-surface-2/50 px-5 py-3.5 sm:flex-row sm:justify-end sm:rounded-b-2xl">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
