/** Minimal toast notifications for mutation feedback ("Host saved"). */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import { Icon } from '../Icon';

type ToastTone = 'success' | 'danger' | 'info';
interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastApi {
  show: (message: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastApi>({ show: () => {} });

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback(
    (id: number) => setItems((list) => list.filter((i) => i.id !== id)),
    [],
  );

  const show = useCallback(
    (message: string, tone: ToastTone = 'success') => {
      const id = nextId.current++;
      setItems((list) => [...list.slice(-3), { id, tone, message }]);
      window.setTimeout(() => dismiss(id), tone === 'danger' ? 8000 : 4000);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div
          aria-live="polite"
          className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:items-end"
        >
          {items.map((item) => (
            <div
              key={item.id}
              role={item.tone === 'danger' ? 'alert' : 'status'}
              className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border border-border bg-surface px-3.5 py-3 text-sm text-fg shadow-lg"
            >
              <Icon
                name={item.tone === 'danger' ? 'alert' : item.tone === 'info' ? 'info' : 'check'}
                size={18}
                className={cn(
                  'mt-px shrink-0',
                  item.tone === 'danger'
                    ? 'text-danger'
                    : item.tone === 'info'
                      ? 'text-info'
                      : 'text-success',
                )}
              />
              <p className="min-w-0 flex-1 break-words">{item.message}</p>
              <button
                type="button"
                onClick={() => dismiss(item.id)}
                className="text-fg-muted hover:text-fg"
                aria-label={t('common.dismiss')}
              >
                <Icon name="x" size={14} />
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}
