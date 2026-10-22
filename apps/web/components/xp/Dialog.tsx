'use client';

import { useEffect, useEffectEvent, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { CtrlGlyph } from './Window';
import { ErrorIcon, InfoIcon, QuestionIcon, WarningIcon } from './Icons';
import { Button } from './Button';
import styles from './Window.module.css';
import box from './Dialog.module.css';

type DialogProps = {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  dim?: boolean;
  /** Content for the dialog's own button row. */
  footer?: ReactNode;
};

export function useModalFocus(ref: RefObject<HTMLElement | null>, onClose: () => void) {
  const close = useEffectEvent(onClose);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const desktop = document.querySelector<HTMLElement>('[data-desktop]');
    if (desktop) desktop.inert = true;
    const onKey = (e: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[data-dockhood-dialog]');
      if (dialogs[dialogs.length - 1] !== ref.current) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key !== 'Tab') return;
      const targets = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? [])].filter((target) => target.getClientRects().length > 0);
      if (!targets?.length) { e.preventDefault(); ref.current?.focus(); return; }
      const first = targets[0], last = targets[targets.length - 1];
      if (!ref.current?.contains(document.activeElement)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    (ref.current?.querySelector<HTMLElement>('[data-autofocus], button:not(:disabled):not([aria-label="Close"])') ?? ref.current)?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      if (desktop) desktop.inert = !!document.querySelector('[data-dockhood-dialog]');
      if (previous?.isConnected && !previous.closest('[inert]')) {
        const collapsed = previous.closest('details:not([open])');
        (collapsed?.querySelector('summary') ?? previous).focus();
      }
    };
  }, [ref]);
}

export function Dialog({ title, onClose, children, width = 360, dim = true, footer }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref, onClose);

  return createPortal(
    <div className={`${styles.overlay} ${dim ? styles.dim : ''}`} onPointerDown={(e) => e.target === e.currentTarget && e.preventDefault()}>
      <div ref={ref} data-dockhood-dialog tabIndex={-1} role="alertdialog" aria-modal="true" aria-label={title} className={`${styles.window} ${styles.dialog}`} style={{ width }}>
        <header role="presentation" className={styles.titlebar}>
          <span className={styles.title}>{title}</span>
          <span className={styles.controls}>
            <button type="button" className={`${styles.ctrl} ${styles.close}`} aria-label="Close" onClick={onClose}>
              <CtrlGlyph kind="close" />
            </button>
            <span className={`${styles.ctrl} ${styles.minimize}`} aria-hidden="true" />
            <span className={`${styles.ctrl} ${styles.maximizeCtrl}`} aria-hidden="true" />
          </span>
        </header>
        <div className={box.content}>{children}</div>
        {footer && <div className={box.footer}>{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

const KIND_ICON = {
  info: InfoIcon,
  warning: WarningIcon,
  error: ErrorIcon,
  question: QuestionIcon,
} as const;

type MessageBoxProps = {
  title: string;
  kind?: keyof typeof KIND_ICON;
  children: ReactNode;
  onClose: () => void;
  /** Defaults to a single OK button that closes. */
  buttons?: ReactNode;
  width?: number;
};

export function MessageBox({ title, kind = 'info', children, onClose, buttons, width }: MessageBoxProps) {
  const Icon = KIND_ICON[kind];
  return (
    <Dialog
      title={title}
      onClose={onClose}
      width={width}
      footer={
        buttons ?? (
          <Button onClick={onClose} data-autofocus>
            OK
          </Button>
        )
      }
    >
      <div className={box.message}>
        <Icon size={32} />
        <div className={box.text}>{children}</div>
      </div>
    </Dialog>
  );
}
