import { ja } from "../../lib/ja";
import { type ApprovalRequestId } from "@t3tools/contracts";
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { type PendingUserInput } from "../../session-logic";
import {
  countPendingUserInputRows,
  derivePendingUserInputProgress,
  derivePendingUserInputSteps,
  hasPendingUserInputCustomRow,
  initialPendingUserInputHighlight,
  resolvePendingUserInputKey,
  shouldFocusPendingUserInputPanel,
  type PendingUserInputDraftAnswer,
  type PendingUserInputKeyAction,
  type PendingUserInputKeyContext,
} from "../../pendingUserInput";
import { CheckIcon, PencilLineIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { cn } from "~/lib/utils";
import { ComposerBanner } from "./ComposerBanner";

const PANEL_BODY_SELECTOR = "[data-pending-user-input-body]";
const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

// When a question appears the panel takes focus so 1-9, arrows and Enter work at
// once, unless the user was typing somewhere else a moment ago (usually the
// composer). Typing inside the panel's own field does not count, so advancing
// from that field moves focus on to the next question.
let lastEditorKeydownAt: number | null = null;
if (typeof document !== "undefined") {
  document.addEventListener(
    "keydown",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest(PANEL_BODY_SELECTOR)) return;
      if (target.closest(EDITABLE_SELECTOR)) lastEditorKeydownAt = performance.now();
    },
    true,
  );
}

function classifyKeyTarget(
  target: EventTarget | null,
  panelBody: HTMLElement | null,
): PendingUserInputKeyContext {
  if (!(target instanceof Element)) return "outside";
  if (panelBody?.contains(target)) {
    return target instanceof HTMLInputElement ? "text" : "options";
  }
  return target.closest(EDITABLE_SELECTOR) ? "editable" : "outside";
}

interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  respondingRequestIds: ApprovalRequestId[];
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionValue: string) => void;
  /** Writes the same custom answer the composer edits, without touching composer focus. */
  onChangeCustomAnswer: (questionId: string, value: string) => void;
  onAdvance: () => void;
  onDismiss: (requestId: ApprovalRequestId) => void;
}

export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
  pendingUserInputs,
  respondingRequestIds,
  answers,
  questionIndex,
  onToggleOption,
  onChangeCustomAnswer,
  onAdvance,
  onDismiss,
}: PendingUserInputPanelProps) {
  if (pendingUserInputs.length === 0) return null;
  const activePrompt = pendingUserInputs[0];
  if (!activePrompt) return null;

  return (
    <ComposerPendingUserInputCard
      key={activePrompt.requestId}
      prompt={activePrompt}
      isResponding={respondingRequestIds.includes(activePrompt.requestId)}
      answers={answers}
      questionIndex={questionIndex}
      onToggleOption={onToggleOption}
      onChangeCustomAnswer={onChangeCustomAnswer}
      onAdvance={onAdvance}
      onDismiss={onDismiss}
    />
  );
});

const ComposerPendingUserInputCard = memo(function ComposerPendingUserInputCard({
  prompt,
  isResponding,
  answers,
  questionIndex,
  onToggleOption,
  onChangeCustomAnswer,
  onAdvance,
  onDismiss,
}: {
  prompt: PendingUserInput;
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionValue: string) => void;
  onChangeCustomAnswer: (questionId: string, value: string) => void;
  onAdvance: () => void;
  onDismiss: (requestId: ApprovalRequestId) => void;
}) {
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const activeQuestion = progress.activeQuestion;
  const autoAdvanceTimerRef = useRef<number | null>(null);
  const onAdvanceRef = useRef(onAdvance);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const customInputRef = useRef<HTMLInputElement | null>(null);
  const [optimisticSingleSelect, setOptimisticSingleSelect] = useState<{
    questionId: string;
    optionValue: string;
  } | null>(null);
  // The keyboard highlight is separate from the selection: arrows move it, and
  // only Enter, Space, a digit or a click chooses. Scoped to a question so the
  // next question starts from its own selection.
  const [highlightState, setHighlightState] = useState<{
    questionId: string;
    index: number;
  } | null>(null);
  const [hasFocusWithin, setHasFocusWithin] = useState(false);
  // Collapsing hides everything but the header so a tall prompt stops covering
  // the thread the user is trying to read. Scoped to a single question: the card
  // is keyed by request id so the next prompt starts expanded, and storing the
  // collapsed question's id (rather than a bare flag) reopens the card when the
  // prompt advances to its next question, which can happen without a click —
  // sending from the composer advances the active question.
  const [collapsedQuestionId, setCollapsedQuestionId] = useState<string | null>(null);
  const isCollapsed = collapsedQuestionId !== null && collapsedQuestionId === activeQuestion?.id;

  const highlightIndex =
    activeQuestion && highlightState?.questionId === activeQuestion.id
      ? highlightState.index
      : activeQuestion
        ? initialPendingUserInputHighlight(activeQuestion, progress.selectedOptionValues)
        : 0;

  useEffect(() => {
    onAdvanceRef.current = onAdvance;
  }, [onAdvance]);

  useEffect(() => {
    if (!activeQuestion || activeQuestion.multiSelect || !optimisticSingleSelect) {
      return;
    }
    if (optimisticSingleSelect.questionId !== activeQuestion.id) {
      setOptimisticSingleSelect(null);
      return;
    }
    if (
      progress.customAnswer.trim().length === 0 &&
      progress.selectedOptionValues.includes(optimisticSingleSelect.optionValue)
    ) {
      setOptimisticSingleSelect(null);
    }
  }, [
    activeQuestion,
    optimisticSingleSelect,
    progress.customAnswer,
    progress.selectedOptionValues,
  ]);

  // Clear auto-advance timer on unmount
  useEffect(() => {
    return () => {
      if (autoAdvanceTimerRef.current !== null) {
        window.clearTimeout(autoAdvanceTimerRef.current);
      }
    };
  }, []);

  // Take focus when a question appears (and again for each next question).
  const activeQuestionId = activeQuestion?.id;
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || activeQuestionId === undefined) return;
    const msSinceEditorKeydown =
      lastEditorKeydownAt === null ? null : performance.now() - lastEditorKeydownAt;
    if (shouldFocusPendingUserInputPanel(msSinceEditorKeydown)) {
      body.focus({ preventScroll: true });
    }
  }, [activeQuestionId]);

  const handleOptionSelection = useCallback(
    (questionId: string, optionValue: string, advance: boolean) => {
      if (activeQuestion?.multiSelect) {
        onToggleOption(questionId, optionValue);
        return;
      }
      setOptimisticSingleSelect({ questionId, optionValue });
      onToggleOption(questionId, optionValue);
      if (!advance) return;
      if (autoAdvanceTimerRef.current !== null) {
        window.clearTimeout(autoAdvanceTimerRef.current);
      }
      autoAdvanceTimerRef.current = window.setTimeout(() => {
        autoAdvanceTimerRef.current = null;
        onAdvanceRef.current();
      }, 200);
    },
    [activeQuestion, onToggleOption],
  );

  const applyKeyAction = useCallback(
    (action: PendingUserInputKeyAction) => {
      if (!activeQuestion) return;
      const questionId = activeQuestion.id;
      const optionAt = (index: number) => {
        const option = activeQuestion.options[index];
        return option ? (option.value ?? option.label) : null;
      };
      switch (action.type) {
        case "choose-option":
        case "toggle-option": {
          const optionValue = optionAt(action.optionIndex);
          if (optionValue === null) return;
          setHighlightState({ questionId, index: action.optionIndex });
          handleOptionSelection(questionId, optionValue, action.type === "choose-option");
          return;
        }
        case "move-highlight": {
          setHighlightState({ questionId, index: action.index });
          if (action.index >= activeQuestion.options.length) {
            customInputRef.current?.focus();
          } else if (document.activeElement === customInputRef.current) {
            bodyRef.current?.focus({ preventScroll: true });
          }
          return;
        }
        case "leave-text":
          setHighlightState({ questionId, index: activeQuestion.options.length - 1 });
          bodyRef.current?.focus({ preventScroll: true });
          return;
        case "submit":
          onAdvanceRef.current();
          return;
        case "none":
          return;
      }
    },
    [activeQuestion, handleOptionSelection],
  );

  // Shortcuts: 1-9 pick an option directly, also from anywhere that is not an
  // editable field; arrows, Enter and Space work while focus is inside the panel.
  // The composer and the panel's own text field are typing contexts, so digits
  // there are text. Collapsed prompts opt out, since their options are not on screen.
  const canAdvance = progress.canAdvance;
  useEffect(() => {
    if (!activeQuestion || isResponding || isCollapsed) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      const action = resolvePendingUserInputKey({
        key: event.key,
        hasModifier: event.metaKey || event.ctrlKey || event.altKey,
        isComposing: event.isComposing,
        context: classifyKeyTarget(event.target, bodyRef.current),
        question: activeQuestion,
        highlightIndex,
        canAdvance,
      });
      if (action.type === "none") return;
      event.preventDefault();
      applyKeyAction(action);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeQuestion, applyKeyAction, canAdvance, highlightIndex, isCollapsed, isResponding]);

  if (!activeQuestion) {
    return null;
  }

  const customAnswerActive = progress.customAnswer.trim().length > 0;
  const showCustomRow = hasPendingUserInputCustomRow(activeQuestion);
  const customRowIndex = activeQuestion.options.length;
  const steps = derivePendingUserInputSteps(prompt.questions, answers, progress.questionIndex);
  const hasMultipleQuestions = prompt.questions.length > 1;
  const showConfirmButton = activeQuestion.multiSelect || customAnswerActive;
  const rowCount = countPendingUserInputRows(activeQuestion);

  return (
    <Collapsible
      open={!isCollapsed}
      onOpenChange={(open) => {
        setCollapsedQuestionId(open ? null : activeQuestion.id);
      }}
    >
      <CollapsibleTrigger
        render={<ComposerBanner.Row render={<button type="button" />} />}
        title={
          isCollapsed
            ? ja("Show the question and its options")
            : ja("Hide the question and its options")
        }
        data-pending-user-input-toggle={isCollapsed ? "collapsed" : "expanded"}
      >
        <ComposerBanner.Icon />
        <ComposerBanner.Content>
          <span className="shrink-0 font-semibold text-foreground">{activeQuestion.header}</span>
          {isCollapsed ? (
            <span className="min-w-0 flex-1 truncate text-secondary-label">
              {activeQuestion.question}
            </span>
          ) : null}
        </ComposerBanner.Content>
        <ComposerBanner.Actions>
          {hasMultipleQuestions ? (
            <span className="text-3xs font-medium text-muted-foreground tabular-nums">
              質問 {progress.questionIndex + 1}/{prompt.questions.length}
            </span>
          ) : null}
          <ComposerBanner.ToggleIcon expanded={!isCollapsed} />
          {prompt.dismissible ? (
            // Sits inside the trigger button, so stop the click from toggling
            // the disclosure. Dismiss closes the question without a reply.
            <ComposerBanner.Dismiss
              render={<span role="button" tabIndex={0} />}
              aria-label="回答せずに質問を閉じる"
              title="回答せずに質問を閉じる"
              disabled={isResponding}
              data-pending-user-input-dismiss
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onDismiss(prompt.requestId);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                event.stopPropagation();
                onDismiss(prompt.requestId);
              }}
            />
          ) : null}
        </ComposerBanner.Actions>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <ComposerBanner.Scroll>
          <ComposerBanner.Body className="pe-1 pb-1 wrap-anywhere">
            {hasMultipleQuestions ? (
              <ol className="mb-2 flex flex-wrap gap-1.5" aria-label="質問の進み具合">
                {steps.map((step) => (
                  <li
                    key={step.id}
                    aria-current={step.status === "current" ? "step" : undefined}
                    className={cn(
                      "flex min-w-0 max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
                      step.status === "current" &&
                        "border-primary/50 bg-primary/10 font-semibold text-foreground",
                      step.status === "done" &&
                        "border-border/60 bg-muted/40 text-muted-foreground",
                      step.status === "upcoming" && "border-border/40 text-muted-foreground/70",
                    )}
                  >
                    {step.status === "done" ? (
                      <CheckIcon className="size-3 shrink-0 text-primary" />
                    ) : null}
                    <span className="truncate">{step.header}</span>
                    {step.summary ? (
                      <span className="max-w-32 truncate text-foreground/70">: {step.summary}</span>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : null}
            <p className="text-sm font-semibold leading-snug text-foreground">
              {activeQuestion.question}
            </p>
            {activeQuestion.multiSelect ? (
              <p className="mt-1 text-secondary-label text-xs">
                1つ以上の選択肢を選んで「決定」を押してください。
              </p>
            ) : null}
            <div
              ref={bodyRef}
              tabIndex={-1}
              role="group"
              aria-label={activeQuestion.header}
              data-pending-user-input-body=""
              className="mt-2 space-y-1.5 outline-none"
              onFocus={() => setHasFocusWithin(true)}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setHasFocusWithin(false);
              }}
            >
              {activeQuestion.options.map((option, index) => {
                const optionValue = option.value ?? option.label;
                const isOptimisticallySelected =
                  optimisticSingleSelect?.questionId === activeQuestion.id &&
                  optimisticSingleSelect.optionValue === optionValue;
                const isSelected =
                  isOptimisticallySelected ||
                  (!customAnswerActive && progress.selectedOptionValues.includes(optionValue));
                return (
                  <PendingOptionRow
                    key={`${activeQuestion.id}:${optionValue}`}
                    shortcutKey={index < 9 ? String(index + 1) : "•"}
                    label={ja(option.label)}
                    description={
                      option.description && option.description !== option.label
                        ? ja(option.description)
                        : null
                    }
                    multiSelect={activeQuestion.multiSelect === true}
                    isSelected={isSelected}
                    isHighlighted={hasFocusWithin && highlightIndex === index}
                    disabled={isResponding}
                    onClick={() => {
                      setHighlightState({ questionId: activeQuestion.id, index });
                      handleOptionSelection(activeQuestion.id, optionValue, true);
                    }}
                  />
                );
              })}
              {showCustomRow ? (
                <div
                  className={cn(
                    "flex w-full items-start gap-3 rounded-lg border px-3 py-2 transition-colors duration-150",
                    customAnswerActive
                      ? "border-primary/60 bg-primary/10"
                      : "border-border/60 bg-background/40",
                    hasFocusWithin && highlightIndex === customRowIndex && "ring-2 ring-ring/60",
                  )}
                >
                  <RowBadge isSelected={customAnswerActive}>
                    <PencilLineIcon className="size-4" />
                  </RowBadge>
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <label
                      htmlFor={`pending-user-input-custom-${activeQuestion.id}`}
                      className="text-sm font-semibold text-foreground"
                    >
                      その他（自由入力）
                    </label>
                    <Input
                      id={`pending-user-input-custom-${activeQuestion.id}`}
                      ref={customInputRef}
                      size="sm"
                      value={progress.customAnswer}
                      disabled={isResponding}
                      placeholder="選択肢にない答えはここに入力して Enter"
                      autoComplete="off"
                      onFocus={() =>
                        setHighlightState({ questionId: activeQuestion.id, index: customRowIndex })
                      }
                      onChange={(event) => {
                        onChangeCustomAnswer(activeQuestion.id, event.target.value);
                      }}
                    />
                  </div>
                </div>
              ) : null}
            </div>
            {rowCount > 0 ? (
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <p className="min-w-0 text-secondary-label text-2xs max-sm:hidden">
                  {activeQuestion.multiSelect
                    ? "1-9 で切り替え · ↑↓ で移動 · Space で切り替え · Enter で決定"
                    : "1-9 で選択 · ↑↓ で移動 · Enter で決定"}
                </p>
                {showConfirmButton ? (
                  <Button
                    size="sm"
                    className="ms-auto"
                    disabled={isResponding || !progress.canAdvance}
                    onClick={() => onAdvance()}
                  >
                    決定
                  </Button>
                ) : null}
              </div>
            ) : null}
          </ComposerBanner.Body>
        </ComposerBanner.Scroll>
      </CollapsiblePanel>
    </Collapsible>
  );
});

function RowBadge({ isSelected, children }: { isSelected: boolean; children: ReactNode }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-md text-sm font-semibold tabular-nums",
        isSelected ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
      )}
    >
      {children}
    </span>
  );
}

function PendingOptionRow({
  shortcutKey,
  label,
  description,
  multiSelect,
  isSelected,
  isHighlighted,
  disabled,
  onClick,
}: {
  shortcutKey: string;
  label: string;
  description: string | null;
  multiSelect: boolean;
  isSelected: boolean;
  isHighlighted: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role={multiSelect ? "checkbox" : "radio"}
      aria-checked={isSelected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg border px-3 py-2 text-left outline-none transition-colors duration-150",
        isSelected
          ? "border-primary/60 bg-primary/10 text-foreground"
          : "border-border/60 bg-background/40 text-foreground hover:bg-muted/40",
        isHighlighted && "ring-2 ring-ring/60",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
      )}
    >
      <RowBadge isSelected={isSelected}>{shortcutKey}</RowBadge>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-semibold">{label}</span>
        {description ? <span className="text-secondary-label text-xs">{description}</span> : null}
      </span>
      {multiSelect ? (
        <span
          aria-hidden
          className={cn(
            "mt-1 flex size-4 shrink-0 items-center justify-center rounded-sm border",
            isSelected
              ? "border-primary bg-primary text-primary-foreground"
              : "border-input bg-background",
          )}
        >
          {isSelected ? <CheckIcon className="size-3" strokeWidth={3} /> : null}
        </span>
      ) : isSelected ? (
        <CheckIcon aria-hidden className="mt-1 size-4 shrink-0 text-primary" />
      ) : null}
    </button>
  );
}
