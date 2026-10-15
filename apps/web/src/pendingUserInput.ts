import type { UserInputQuestion } from "@t3tools/contracts";

export interface PendingUserInputDraftAnswer {
  selectedOptionValues?: string[];
  customAnswer?: string;
  attachmentCount?: number;
  attachmentsBlocked?: boolean;
}

export interface PendingUserInputProgress {
  questionIndex: number;
  activeQuestion: UserInputQuestion | null;
  activeDraft: PendingUserInputDraftAnswer | undefined;
  selectedOptionValues: string[];
  customAnswer: string;
  resolvedAnswer: string | string[] | null;
  usingCustomAnswer: boolean;
  answeredQuestionCount: number;
  isLastQuestion: boolean;
  isComplete: boolean;
  canAdvance: boolean;
}

function normalizeDraftAnswer(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeSelectedOptionValues(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  // Provider option IDs must stay unchanged, including whitespace.
  return Array.from(new Set(value.filter((entry) => typeof entry === "string")));
}

export function resolvePendingUserInputAnswer(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
): string | string[] | null {
  if (draft?.attachmentsBlocked) return null;
  const customAnswer =
    question.allowCustomAnswer === false ? null : normalizeDraftAnswer(draft?.customAnswer);
  if (customAnswer) {
    return customAnswer;
  }

  const selectedOptionValues = normalizeSelectedOptionValues(draft?.selectedOptionValues).filter(
    (value) => question.options.some((option) => (option.value ?? option.label) === value),
  );
  if (question.multiSelect) {
    return selectedOptionValues.length > 0
      ? selectedOptionValues
      : question.allowCustomAnswer !== false && (draft?.attachmentCount ?? 0) > 0
        ? ""
        : null;
  }

  return (
    selectedOptionValues[0] ??
    (question.allowCustomAnswer !== false && (draft?.attachmentCount ?? 0) > 0 ? "" : null)
  );
}

export function setPendingUserInputCustomAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
  customAnswer: string,
): PendingUserInputDraftAnswer {
  const selectedOptionValues =
    customAnswer.trim().length > 0
      ? undefined
      : normalizeSelectedOptionValues(draft?.selectedOptionValues);

  return {
    customAnswer,
    ...(selectedOptionValues && selectedOptionValues.length > 0 ? { selectedOptionValues } : {}),
  };
}

const DISPLACED_ANSWER_SEPARATOR = "\n\n";

/**
 * Selecting an option replaces the custom answer, because a non-empty custom
 * answer outranks selected options in `resolvePendingUserInputAnswer`. Text the
 * user typed into the answer field must not vanish on that click: it moves back
 * into the thread draft, after whatever was already waiting there.
 */
export function carryDisplacedCustomAnswerIntoPrompt(
  prompt: string,
  customAnswer: string | undefined,
): string {
  const displaced = customAnswer?.trim() ?? "";
  if (displaced.length === 0) {
    return prompt;
  }
  if (prompt.trim().length === 0) {
    return displaced;
  }
  return `${prompt.trimEnd()}${DISPLACED_ANSWER_SEPARATOR}${displaced}`;
}

export function togglePendingUserInputOptionSelection(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  optionValue: string,
): PendingUserInputDraftAnswer {
  if (question.multiSelect) {
    const selectedOptionValues = normalizeSelectedOptionValues(draft?.selectedOptionValues);
    const nextSelectedOptionValues = selectedOptionValues.includes(optionValue)
      ? selectedOptionValues.filter((value) => value !== optionValue)
      : [...selectedOptionValues, optionValue];

    return {
      customAnswer: "",
      ...(nextSelectedOptionValues.length > 0
        ? { selectedOptionValues: nextSelectedOptionValues }
        : {}),
    };
  }

  return {
    customAnswer: "",
    selectedOptionValues: [optionValue],
  };
}

export function buildPendingUserInputAnswers(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): Record<string, string | string[]> | null {
  const answers: Record<string, string | string[]> = {};

  for (const question of questions) {
    const answer = resolvePendingUserInputAnswer(question, draftAnswers[question.id]);
    if (answer === null) {
      return null;
    }
    answers[question.id] = answer;
  }

  return answers;
}

export function countAnsweredPendingUserInputQuestions(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): number {
  return questions.reduce((count, question) => {
    return resolvePendingUserInputAnswer(question, draftAnswers[question.id]) !== null
      ? count + 1
      : count;
  }, 0);
}

export function derivePendingUserInputProgress(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
  questionIndex: number,
): PendingUserInputProgress {
  const normalizedQuestionIndex =
    questions.length === 0 ? 0 : Math.max(0, Math.min(questionIndex, questions.length - 1));
  const activeQuestion = questions[normalizedQuestionIndex] ?? null;
  const activeDraft = activeQuestion ? draftAnswers[activeQuestion.id] : undefined;
  const resolvedAnswer = activeQuestion
    ? resolvePendingUserInputAnswer(activeQuestion, activeDraft)
    : null;
  const customAnswer =
    activeQuestion?.allowCustomAnswer === false ? "" : (activeDraft?.customAnswer ?? "");
  const answeredQuestionCount = countAnsweredPendingUserInputQuestions(questions, draftAnswers);
  const isLastQuestion =
    questions.length === 0 ? true : normalizedQuestionIndex >= questions.length - 1;

  return {
    questionIndex: normalizedQuestionIndex,
    activeQuestion,
    activeDraft,
    selectedOptionValues: normalizeSelectedOptionValues(activeDraft?.selectedOptionValues),
    customAnswer,
    resolvedAnswer,
    usingCustomAnswer: customAnswer.trim().length > 0,
    answeredQuestionCount,
    isLastQuestion,
    isComplete: buildPendingUserInputAnswers(questions, draftAnswers) !== null,
    canAdvance: resolvedAnswer !== null,
  };
}

// ---------------------------------------------------------------------------
// Keyboard and layout decisions for the question panel. Kept pure so the panel
// only has to read the DOM (which context has focus) and apply the result.
// ---------------------------------------------------------------------------

/** Typing in the panel's own text field, or in the composer, must never fire shortcuts. */
export type PendingUserInputKeyContext =
  /** Focus is on the panel's option list (or its container). Every shortcut applies. */
  | "options"
  /** Focus is in the panel's free-text field. Only navigation and submit keys apply. */
  | "text"
  /** Focus is in some other editable field, such as the composer. Nothing applies. */
  | "editable"
  /** Focus is elsewhere and not editable. Only the 1-9 shortcuts apply. */
  | "outside";

export type PendingUserInputKeyAction =
  | { type: "none" }
  /** Same as clicking the option: single-select selects and advances, multi-select toggles. */
  | { type: "choose-option"; optionIndex: number }
  /** Selects (single) or toggles (multi) without advancing. */
  | { type: "toggle-option"; optionIndex: number }
  /** Moves the highlight; the custom-answer row is the index after the last option. */
  | { type: "move-highlight"; index: number }
  /** Sends the current answer, or moves to the next question. */
  | { type: "submit" }
  /** Leaves the free-text field and returns to the option list. */
  | { type: "leave-text" };

export interface PendingUserInputKeyInput {
  key: string;
  hasModifier: boolean;
  isComposing: boolean;
  context: PendingUserInputKeyContext;
  question: Pick<UserInputQuestion, "options" | "multiSelect" | "allowCustomAnswer">;
  highlightIndex: number;
  canAdvance: boolean;
}

const NO_KEY_ACTION: PendingUserInputKeyAction = { type: "none" };

export function hasPendingUserInputCustomRow(
  question: Pick<UserInputQuestion, "allowCustomAnswer">,
): boolean {
  return question.allowCustomAnswer !== false;
}

/** Number of rows the highlight can visit: every option, plus the free-text row. */
export function countPendingUserInputRows(
  question: Pick<UserInputQuestion, "options" | "allowCustomAnswer">,
): number {
  return question.options.length + (hasPendingUserInputCustomRow(question) ? 1 : 0);
}

/** Maps a "1"-"9" key to an option index, or null when that option does not exist. */
export function pendingUserInputOptionIndexForKey(key: string, optionCount: number): number | null {
  if (!/^[1-9]$/.test(key)) return null;
  const index = Number.parseInt(key, 10) - 1;
  return index < optionCount ? index : null;
}

/** Steps the highlight by `delta` rows and wraps around at both ends. */
export function movePendingUserInputHighlight(
  current: number,
  delta: 1 | -1,
  rowCount: number,
): number {
  if (rowCount <= 0) return 0;
  const clamped = Math.max(0, Math.min(current, rowCount - 1));
  return (clamped + delta + rowCount) % rowCount;
}

/** The row that starts highlighted: the first selected option, otherwise the first row. */
export function initialPendingUserInputHighlight(
  question: Pick<UserInputQuestion, "options">,
  selectedOptionValues: ReadonlyArray<string>,
): number {
  const index = question.options.findIndex((option) =>
    selectedOptionValues.includes(option.value ?? option.label),
  );
  return index >= 0 ? index : 0;
}

export function resolvePendingUserInputKey(
  input: PendingUserInputKeyInput,
): PendingUserInputKeyAction {
  const { key, context, question, highlightIndex, canAdvance } = input;
  // Modifier chords belong to the app, and IME composition keys (Enter confirms a
  // conversion) belong to the text field.
  if (input.hasModifier || input.isComposing || context === "editable") return NO_KEY_ACTION;

  const optionCount = question.options.length;
  const rowCount = countPendingUserInputRows(question);

  if (context === "text") {
    switch (key) {
      case "Enter":
        return canAdvance ? { type: "submit" } : NO_KEY_ACTION;
      case "ArrowUp":
        return optionCount > 0
          ? {
              type: "move-highlight",
              index: movePendingUserInputHighlight(optionCount, -1, rowCount),
            }
          : NO_KEY_ACTION;
      case "ArrowDown":
        return optionCount > 0
          ? {
              type: "move-highlight",
              index: movePendingUserInputHighlight(optionCount, 1, rowCount),
            }
          : NO_KEY_ACTION;
      case "Escape":
        return optionCount > 0 ? { type: "leave-text" } : NO_KEY_ACTION;
      default:
        return NO_KEY_ACTION;
    }
  }

  const digitIndex = pendingUserInputOptionIndexForKey(key, optionCount);
  if (digitIndex !== null) return { type: "choose-option", optionIndex: digitIndex };
  if (context === "outside") return NO_KEY_ACTION;

  const highlightedOption = highlightIndex < optionCount;
  switch (key) {
    case "ArrowDown":
      return {
        type: "move-highlight",
        index: movePendingUserInputHighlight(highlightIndex, 1, rowCount),
      };
    case "ArrowUp":
      return {
        type: "move-highlight",
        index: movePendingUserInputHighlight(highlightIndex, -1, rowCount),
      };
    case "Enter":
      if (question.multiSelect) {
        if (canAdvance) return { type: "submit" };
        // Nothing is chosen yet, so Enter picks the highlighted row rather than doing nothing.
        return highlightedOption
          ? { type: "toggle-option", optionIndex: highlightIndex }
          : NO_KEY_ACTION;
      }
      if (highlightedOption) return { type: "choose-option", optionIndex: highlightIndex };
      return canAdvance ? { type: "submit" } : NO_KEY_ACTION;
    case " ":
      return highlightedOption
        ? { type: "toggle-option", optionIndex: highlightIndex }
        : NO_KEY_ACTION;
    default:
      return NO_KEY_ACTION;
  }
}

/** How long after the last keystroke in an editor the panel treats the user as still typing. */
export const PENDING_USER_INPUT_TYPING_GRACE_MS = 1500;

/** A new question takes focus unless the user was typing somewhere else a moment ago. */
export function shouldFocusPendingUserInputPanel(msSinceEditorKeydown: number | null): boolean {
  return msSinceEditorKeydown === null || msSinceEditorKeydown > PENDING_USER_INPUT_TYPING_GRACE_MS;
}

/** Text shown for an answered question: the typed answer, or the labels of the chosen options. */
export function describePendingUserInputAnswer(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
): string | null {
  const answer = resolvePendingUserInputAnswer(question, draft);
  if (answer === null) return null;
  const values = Array.isArray(answer) ? answer : [answer];
  const labels = values
    .map(
      (value) =>
        question.options.find((option) => (option.value ?? option.label) === value)?.label ?? value,
    )
    .filter((label) => label.length > 0);
  return labels.length > 0 ? labels.join("、") : null;
}

export interface PendingUserInputStep {
  id: string;
  header: string;
  status: "done" | "current" | "upcoming";
  /** What was answered, for done steps. */
  summary: string | null;
}

/** One entry per question for the "質問 n/N" indicator; answered ones read as done. */
export function derivePendingUserInputSteps(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
  activeQuestionIndex: number,
): PendingUserInputStep[] {
  return questions.map((question, index) => {
    if (index === activeQuestionIndex) {
      return { id: question.id, header: question.header, status: "current", summary: null };
    }
    const summary = describePendingUserInputAnswer(question, draftAnswers[question.id]);
    return {
      id: question.id,
      header: question.header,
      status: summary !== null ? "done" : "upcoming",
      summary,
    };
  });
}
