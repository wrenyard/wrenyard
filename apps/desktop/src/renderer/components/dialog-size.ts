/* App-wide dialog size scale for the Desktop interaction foundations
 * (spec section 4.1, rule 7). A modal is one of only three widths. The width
 * classes are passed to `DialogContent` / `AlertDialogContent`; sizing dialogs
 * is the sole registered exception to the "components/ui is CLI-generated" rule. */

export const DIALOG_SIZES = {
  sm: 'sm:max-w-[400px]',
  md: 'sm:max-w-[520px]',
  lg: 'sm:max-w-[720px]',
} as const;

export type DialogSize = keyof typeof DIALOG_SIZES;

/**
 * `AlertDialogContent` declares its width through `data-[size=…]` variants,
 * which out-specify a `sm:` utility; the confirmation shell re-declares the
 * `sm` width in that variant group.
 */
export const DIALOG_CONFIRM_CLASS = 'data-[size=sm]:max-w-[400px]';

/**
 * Keeps the dialog inside the viewport and reserves a fixed header row and
 * footer row around a single flexible body row. Apply together with a size
 * class; the dialog body must then be the middle in-flow child and carry
 * `DIALOG_BODY_CLASS` so only it scrolls.
 */
export const DIALOG_CONTENT_CLASS =
  'max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden';

/** The scrollable body region between the fixed header and footer. */
export const DIALOG_BODY_CLASS = 'min-h-0 overflow-y-auto';
