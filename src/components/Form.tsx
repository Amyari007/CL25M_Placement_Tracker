import type { FormHTMLAttributes, KeyboardEvent, MouseEvent, ReactNode } from 'react';

/**
 * A <form> that works even where browsers block form submission
 * (sandboxed preview panels): clicks on submit buttons and Enter in a
 * text field call `onSubmit` directly instead of submitting the form.
 */
export function Form({
  onSubmit,
  children,
  ...rest
}: Omit<FormHTMLAttributes<HTMLFormElement>, 'onSubmit'> & { onSubmit: () => void; children: ReactNode }) {
  function onClickCapture(e: MouseEvent<HTMLFormElement>) {
    const btn = (e.target as HTMLElement).closest('button');
    if (btn && btn.getAttribute('type') === 'submit' && !btn.disabled) {
      e.preventDefault();
      onSubmit();
    }
  }
  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    const t = e.target as HTMLElement;
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    if (t.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit'].includes((t as HTMLInputElement).type)) {
      e.preventDefault();
      onSubmit();
    }
  }
  return (
    <form
      noValidate
      {...rest}
      onClickCapture={onClickCapture}
      onKeyDown={onKeyDown}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {children}
    </form>
  );
}
