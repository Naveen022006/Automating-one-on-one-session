import { z } from "zod";

/**
 * Custom intake questions an influencer attaches to a service ("What do you want to work on?", "Share your portfolio
 * link"), and the customer's answers. Everything here is pure so the rules are unit-tested; the booking API, the
 * service editor and the booking page all use the same definitions.
 */

export const MAX_QUESTIONS = 8;
export const MAX_ANSWER_LENGTH = 1000;
export const QUESTION_TYPES = ["text", "longtext", "select"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

// Type aliases (not interfaces) so the values are assignable to Prisma's JSON input type.
export type IntakeQuestion = {
  id: string;
  label: string;
  type: QuestionType;
  required: boolean;
  /** Only for type "select". */
  options?: string[];
};

export type IntakeAnswer = {
  id: string;
  /** Copied from the question at booking time. */
  label: string;
  answer: string;
};

const questionId = z.string().trim().regex(/^[a-z][a-z0-9_]{0,23}$/, "Invalid question id");

export const intakeQuestionSchema = z
  .object({
    id: questionId.optional(),
    label: z.string().trim().min(3, "Write the question (at least 3 characters).").max(120, "Keep questions under 120 characters."),
    type: z.enum(QUESTION_TYPES),
    required: z.boolean().default(false),
    options: z.array(z.string().trim().min(1).max(60)).min(2, "Add at least two choices.").max(10, "At most 10 choices.").optional(),
  })
  .superRefine((q, ctx) => {
    if (q.type === "select" && !q.options) ctx.addIssue({ code: "custom", path: ["options"], message: "Add at least two choices." });
    if (q.type !== "select" && q.options) ctx.addIssue({ code: "custom", path: ["options"], message: "Only choice questions have options." });
    if (q.options && new Set(q.options.map((o) => o.toLowerCase())).size !== q.options.length) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "Choices must be different." });
    }
  });

/** Validated input for a service. Assigns stable ids to new questions and rejects duplicates. */
export const intakeQuestionsInput = z
  .array(intakeQuestionSchema)
  .max(MAX_QUESTIONS, `At most ${MAX_QUESTIONS} questions.`)
  .transform((qs) => {
    const taken = new Set(qs.map((q) => q.id).filter(Boolean) as string[]);
    let n = 0;
    return qs.map((q): IntakeQuestion => {
      let id = q.id;
      if (!id) {
        do id = `q${++n}`;
        while (taken.has(id));
        taken.add(id);
      }
      return { id, label: q.label, type: q.type, required: q.required, ...(q.options ? { options: q.options } : {}) };
    });
  })
  .refine((qs) => new Set(qs.map((q) => q.id)).size === qs.length, "Question ids must be unique.");

/** Reads questions stored as JSON, dropping anything malformed instead of failing a whole booking page. */
export function parseQuestions(raw: unknown): IntakeQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: IntakeQuestion[] = [];
  for (const item of raw.slice(0, MAX_QUESTIONS)) {
    const r = intakeQuestionSchema.safeParse(item);
    if (r.success && r.data.id) out.push({ id: r.data.id, label: r.data.label, type: r.data.type, required: r.data.required, ...(r.data.options ? { options: r.data.options } : {}) });
  }
  return out;
}

export type AnswerResult = { ok: true; answers: IntakeAnswer[] } | { ok: false; errors: Record<string, string> };

/**
 * Checks a customer's answers against the service's questions. Unknown ids are ignored (never stored), required
 * questions must be answered, a choice must be one of the options, and answers are trimmed and length-limited.
 * Returns the answers with the question text copied in, in question order.
 */
export function validateAnswers(questions: IntakeQuestion[], raw: unknown): AnswerResult {
  const given: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const errors: Record<string, string> = {};
  const answers: IntakeAnswer[] = [];

  for (const q of questions) {
    const value = given[q.id];
    const text = typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : "";
    if (!text) {
      if (q.required) errors[q.id] = "Please answer this question.";
      continue;
    }
    if (text.length > MAX_ANSWER_LENGTH) {
      errors[q.id] = `Please keep this under ${MAX_ANSWER_LENGTH} characters.`;
      continue;
    }
    if (q.type === "select" && !q.options?.includes(text)) {
      errors[q.id] = "Choose one of the options.";
      continue;
    }
    if (q.type === "text" && text.includes("\n")) {
      errors[q.id] = "Please use a single line.";
      continue;
    }
    answers.push({ id: q.id, label: q.label, answer: text });
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, answers };
}

/** Reads stored answers (JSON) for display, dropping anything malformed. */
export function parseAnswers(raw: unknown): IntakeAnswer[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((a) =>
    a && typeof a === "object" && typeof (a as IntakeAnswer).label === "string" && typeof (a as IntakeAnswer).answer === "string"
      ? [{ id: String((a as IntakeAnswer).id ?? ""), label: (a as IntakeAnswer).label, answer: (a as IntakeAnswer).answer }]
      : [],
  );
}
