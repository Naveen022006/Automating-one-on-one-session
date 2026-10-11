/**
 * Keyboard-focus decisions of the booking and account forms, as pure functions (no DOM, no React) so the rules can be tested.
 * Used by web/src/pages/booking/BookingFlow.tsx and web/src/components/auth/AuthForms.tsx.
 */

/** The marker the field components put on an input whose value was refused (see describedBy in primitives.tsx). */
export const INVALID_SELECTOR = '[aria-invalid="true"]';

interface Focusable {
  focus(): void;
}
interface SearchableForm {
  querySelector(selector: string): Focusable | null;
}

/**
 * After a failed submit, once the error texts are rendered: focus the FIRST field marked invalid, so the failure is never silent when
 * the message is above the fold. Returns whether something was focused.
 */
export function focusFirstInvalid(form: SearchableForm | null): boolean {
  const field = form?.querySelector(INVALID_SELECTOR) ?? null;
  if (!field) return false;
  field.focus();
  return true;
}

/** The id of the heading of each step of the booking flow (the focus target when the step changes). */
export const STEP_HEADING_IDS = ["pick-service", "pick-time", "your-details", "pay-title", "done-title"] as const;
export const REQUESTED_HEADING_ID = "requested-title";

/** Step 4 is the confirmation: of a booking, or of a REQUEST that waits for the host's approval. */
export function stepHeadingId(step: number, requested: boolean): string | null {
  if (step === 4 && requested) return REQUESTED_HEADING_ID;
  return STEP_HEADING_IDS[step] ?? null;
}

/**
 * Where focus goes after a render: the new step's heading when the step ACTUALLY changed since the last one seen, else nowhere.
 * Comparing with the previous step (not "is this the first run?") matters in development: React StrictMode runs every effect twice
 * on mount, and a "first run" flag set by the first pass made the second pass steal focus on the page load.
 */
export function headingToFocus(previousStep: number, step: number, requested: boolean): string | null {
  return previousStep === step ? null : stepHeadingId(step, requested);
}
