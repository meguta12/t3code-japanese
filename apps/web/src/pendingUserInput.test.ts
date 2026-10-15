import { describe, expect, it } from "vite-plus/test";

import {
  buildPendingUserInputAnswers,
  carryDisplacedCustomAnswerIntoPrompt,
  countAnsweredPendingUserInputQuestions,
  derivePendingUserInputProgress,
  derivePendingUserInputSteps,
  describePendingUserInputAnswer,
  initialPendingUserInputHighlight,
  movePendingUserInputHighlight,
  pendingUserInputOptionIndexForKey,
  resolvePendingUserInputAnswer,
  resolvePendingUserInputKey,
  shouldFocusPendingUserInputPanel,
  type PendingUserInputKeyInput,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "./pendingUserInput";

const singleSelectQuestion = {
  id: "scope",
  header: "Scope",
  question: "What should the plan target first?",
  options: [
    {
      label: "Orchestration-first",
      description: "Focus on orchestration first",
    },
  ],
  multiSelect: false,
} as const;

const multiSelectQuestion = {
  id: "areas",
  header: "Areas",
  question: "Which areas should this change cover?",
  options: [
    {
      label: "Server",
      description: "Server",
    },
    {
      label: "Web",
      description: "Web",
    },
  ],
  multiSelect: true,
} as const;

const nativeChoiceQuestion = {
  id: "result",
  header: "Result",
  question: "Which result should be used?",
  options: [
    { value: " first\t", label: "Result", description: "First result" },
    { value: "second", label: "Result", description: "Second result" },
  ],
  allowCustomAnswer: false,
  multiSelect: false,
} as const;

describe("resolvePendingUserInputAnswer", () => {
  it("prefers a custom answer over selected options", () => {
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        selectedOptionValues: ["Orchestration-first"],
        customAnswer: "Keep the existing envelope for one release",
      }),
    ).toBe("Keep the existing envelope for one release");
  });

  it("falls back to the selected option for single-select questions", () => {
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        selectedOptionValues: ["Orchestration-first"],
      }),
    ).toBe("Orchestration-first");
  });

  it("returns all selected labels for multi-select questions", () => {
    expect(
      resolvePendingUserInputAnswer(multiSelectQuestion, {
        selectedOptionValues: ["Server", "Web"],
      }),
    ).toEqual(["Server", "Web"]);
  });

  it("clears the preset selection when a custom answer is entered", () => {
    expect(
      setPendingUserInputCustomAnswer(
        {
          selectedOptionValues: ["Server", "Web"],
        },
        "doesn't matter",
      ),
    ).toEqual({
      customAnswer: "doesn't matter",
    });
  });

  it("does not replace a required choice with a custom answer", () => {
    expect(
      resolvePendingUserInputAnswer(nativeChoiceQuestion, {
        selectedOptionValues: ["second"],
        customAnswer: "Use another result",
      }),
    ).toBe("second");
  });

  it("does not submit labels or unknown values when an option has a value", () => {
    expect(
      resolvePendingUserInputAnswer(nativeChoiceQuestion, {
        selectedOptionValues: ["Result", "unknown"],
      }),
    ).toBeNull();
  });
});

describe("togglePendingUserInputOptionSelection", () => {
  it("toggles options for multi-select questions", () => {
    expect(togglePendingUserInputOptionSelection(multiSelectQuestion, undefined, "Server")).toEqual(
      {
        customAnswer: "",
        selectedOptionValues: ["Server"],
      },
    );

    expect(
      togglePendingUserInputOptionSelection(
        multiSelectQuestion,
        {
          selectedOptionValues: ["Server", "Web"],
        },
        "Server",
      ),
    ).toEqual({
      customAnswer: "",
      selectedOptionValues: ["Web"],
    });
  });

  it("selects and removes options with the same label independently", () => {
    const question = { ...nativeChoiceQuestion, multiSelect: true };
    const firstSelected = togglePendingUserInputOptionSelection(question, undefined, " first\t");
    const bothSelected = togglePendingUserInputOptionSelection(question, firstSelected, "second");

    expect(buildPendingUserInputAnswers([question], { result: bothSelected })).toEqual({
      result: [" first\t", "second"],
    });

    const secondSelected = togglePendingUserInputOptionSelection(
      question,
      bothSelected,
      " first\t",
    );
    expect(buildPendingUserInputAnswers([question], { result: secondSelected })).toEqual({
      result: ["second"],
    });
  });
});

describe("buildPendingUserInputAnswers", () => {
  it("returns a canonical answer map for complete prompts", () => {
    expect(
      buildPendingUserInputAnswers(
        [
          singleSelectQuestion,
          {
            id: "compat",
            header: "Compat",
            question: "How strict should compatibility be?",
            options: [
              {
                label: "Keep current envelope",
                description: "Preserve current wire format",
              },
            ],
            multiSelect: false,
          },
        ],
        {
          scope: {
            selectedOptionValues: ["Orchestration-first"],
          },
          compat: {
            customAnswer: "Keep the current envelope for one release window",
          },
        },
      ),
    ).toEqual({
      scope: "Orchestration-first",
      compat: "Keep the current envelope for one release window",
    });
  });

  it("returns arrays for answered multi-select prompts", () => {
    expect(
      buildPendingUserInputAnswers([multiSelectQuestion], {
        areas: {
          selectedOptionValues: ["Server", "Web"],
        },
      }),
    ).toEqual({
      areas: ["Server", "Web"],
    });
  });

  it("returns null when any question is unanswered", () => {
    expect(buildPendingUserInputAnswers([singleSelectQuestion], {})).toBeNull();
  });

  it.each([" first\t", ""])("preserves the exact selected option value %j", (value) => {
    const question = {
      ...nativeChoiceQuestion,
      options: [{ ...nativeChoiceQuestion.options[0], value }, nativeChoiceQuestion.options[1]],
    };
    const draft = togglePendingUserInputOptionSelection(question, undefined, value);

    expect(buildPendingUserInputAnswers([question], { result: draft })).toEqual({ result: value });
    expect(derivePendingUserInputProgress([question], { result: draft }, 0)).toMatchObject({
      selectedOptionValues: [value],
      answeredQuestionCount: 1,
      canAdvance: true,
      isComplete: true,
    });
  });
});

describe("pending user input question progress", () => {
  const questions = [
    singleSelectQuestion,
    {
      id: "compat",
      header: "Compat",
      question: "How strict should compatibility be?",
      options: [
        {
          label: "Keep current envelope",
          description: "Preserve current wire format",
        },
      ],
      multiSelect: false,
    },
  ] as const;

  it("counts only answered questions", () => {
    expect(
      countAnsweredPendingUserInputQuestions(questions, {
        scope: {
          selectedOptionValues: ["Orchestration-first"],
        },
      }),
    ).toBe(1);
  });

  it("derives the active question and advancement state", () => {
    expect(
      derivePendingUserInputProgress(
        questions,
        {
          scope: {
            selectedOptionValues: ["Orchestration-first"],
          },
        },
        0,
      ),
    ).toMatchObject({
      questionIndex: 0,
      activeQuestion: questions[0],
      selectedOptionValues: ["Orchestration-first"],
      customAnswer: "",
      resolvedAnswer: "Orchestration-first",
      answeredQuestionCount: 1,
      isLastQuestion: false,
      isComplete: false,
      canAdvance: true,
    });
  });

  it("treats multi-select questions as answered when they have selected options", () => {
    expect(
      derivePendingUserInputProgress(
        [multiSelectQuestion],
        {
          areas: {
            selectedOptionValues: ["Server", "Web"],
          },
        },
        0,
      ),
    ).toMatchObject({
      selectedOptionValues: ["Server", "Web"],
      resolvedAnswer: ["Server", "Web"],
      canAdvance: true,
      isComplete: true,
    });
  });

  it("requires an option when custom answers are disabled", () => {
    const drafts = { result: { customAnswer: "Use another result" } };

    expect(buildPendingUserInputAnswers([nativeChoiceQuestion], drafts)).toBeNull();
    expect(derivePendingUserInputProgress([nativeChoiceQuestion], drafts, 0)).toMatchObject({
      customAnswer: "",
      usingCustomAnswer: false,
      resolvedAnswer: null,
      answeredQuestionCount: 0,
      canAdvance: false,
      isComplete: false,
    });
  });
});

it("accepts attachment-only answers after every upload finishes", () => {
  const questions = [
    { id: "spec", header: "Spec", question: "Provide a spec", options: [], multiSelect: false },
  ];
  expect(buildPendingUserInputAnswers(questions, { spec: { attachmentCount: 1 } })).toEqual({
    spec: "",
  });
  expect(
    buildPendingUserInputAnswers(questions, {
      spec: { attachmentCount: 1, attachmentsBlocked: true },
    }),
  ).toBeNull();
  expect(
    buildPendingUserInputAnswers([{ ...questions[0]!, allowCustomAnswer: false }], {
      spec: { attachmentCount: 1 },
    }),
  ).toBeNull();
});

describe("carryDisplacedCustomAnswerIntoPrompt", () => {
  it("keeps the thread draft when nothing was typed into the answer", () => {
    expect(carryDisplacedCustomAnswerIntoPrompt("draft", undefined)).toBe("draft");
    expect(carryDisplacedCustomAnswerIntoPrompt("draft", "   ")).toBe("draft");
  });

  it("moves the typed answer into an empty thread draft", () => {
    expect(carryDisplacedCustomAnswerIntoPrompt("", "also rename the flag ")).toBe(
      "also rename the flag",
    );
  });

  it("appends the typed answer after an existing thread draft", () => {
    expect(carryDisplacedCustomAnswerIntoPrompt("first half\n", "second half")).toBe(
      "first half\n\nsecond half",
    );
  });
});

describe("pendingUserInputOptionIndexForKey", () => {
  it("maps digits 1-9 to option indexes", () => {
    expect(pendingUserInputOptionIndexForKey("1", 3)).toBe(0);
    expect(pendingUserInputOptionIndexForKey("3", 3)).toBe(2);
    expect(pendingUserInputOptionIndexForKey("9", 12)).toBe(8);
  });

  it("ignores digits past the last option, zero and non-digits", () => {
    expect(pendingUserInputOptionIndexForKey("4", 3)).toBeNull();
    expect(pendingUserInputOptionIndexForKey("0", 3)).toBeNull();
    expect(pendingUserInputOptionIndexForKey("10", 20)).toBeNull();
    expect(pendingUserInputOptionIndexForKey("a", 3)).toBeNull();
  });
});

describe("movePendingUserInputHighlight", () => {
  it("wraps around at both ends", () => {
    expect(movePendingUserInputHighlight(2, 1, 3)).toBe(0);
    expect(movePendingUserInputHighlight(0, -1, 3)).toBe(2);
    expect(movePendingUserInputHighlight(0, 1, 3)).toBe(1);
  });

  it("recovers from an out-of-range highlight", () => {
    expect(movePendingUserInputHighlight(9, 1, 3)).toBe(0);
    expect(movePendingUserInputHighlight(0, 1, 0)).toBe(0);
  });
});

describe("initialPendingUserInputHighlight", () => {
  const question = {
    ...multiSelectQuestion,
    options: [
      { label: "A", description: "a" },
      { label: "B", description: "b", value: "b-value" },
    ],
  };

  it("starts on the selected option, matching by value before label", () => {
    expect(initialPendingUserInputHighlight(question, ["b-value"])).toBe(1);
    expect(initialPendingUserInputHighlight(question, ["B"])).toBe(0);
  });

  it("starts on the first row when nothing is selected", () => {
    expect(initialPendingUserInputHighlight(question, [])).toBe(0);
  });
});

describe("resolvePendingUserInputKey", () => {
  const options = [
    { label: "A", description: "a" },
    { label: "B", description: "b" },
    { label: "C", description: "c" },
  ];
  const single = { options, multiSelect: false } as const;
  const multi = { options, multiSelect: true } as const;
  const choiceOnly = { options, multiSelect: false, allowCustomAnswer: false } as const;

  function press(overrides: Partial<PendingUserInputKeyInput> & { key: string }) {
    return resolvePendingUserInputKey({
      hasModifier: false,
      isComposing: false,
      context: "options",
      question: single,
      highlightIndex: 0,
      canAdvance: false,
      ...overrides,
    });
  }

  it("chooses the option for a digit from the option list and from outside editors", () => {
    expect(press({ key: "2" })).toEqual({ type: "choose-option", optionIndex: 1 });
    expect(press({ key: "2", context: "outside" })).toEqual({
      type: "choose-option",
      optionIndex: 1,
    });
    expect(press({ key: "2", question: multi })).toEqual({ type: "choose-option", optionIndex: 1 });
  });

  it("never fires while the user types in the free-text field or another editor", () => {
    expect(press({ key: "1", context: "text" })).toEqual({ type: "none" });
    expect(press({ key: " ", context: "text" })).toEqual({ type: "none" });
    expect(press({ key: "1", context: "editable" })).toEqual({ type: "none" });
    expect(press({ key: "Enter", context: "editable", canAdvance: true })).toEqual({
      type: "none",
    });
  });

  it("ignores digits past the last option, modifier chords and IME composition", () => {
    expect(press({ key: "7" })).toEqual({ type: "none" });
    expect(press({ key: "1", hasModifier: true })).toEqual({ type: "none" });
    expect(press({ key: "Enter", context: "text", isComposing: true, canAdvance: true })).toEqual({
      type: "none",
    });
  });

  it("leaves arrows, Enter and Space to their owners when focus is outside the panel", () => {
    for (const key of ["ArrowDown", "ArrowUp", "Enter", " "]) {
      expect(press({ key, context: "outside", canAdvance: true })).toEqual({ type: "none" });
    }
  });

  it("moves the highlight with arrows and wraps through the free-text row", () => {
    // 3 options + the free-text row = 4 rows.
    expect(press({ key: "ArrowDown", highlightIndex: 2 })).toEqual({
      type: "move-highlight",
      index: 3,
    });
    expect(press({ key: "ArrowDown", highlightIndex: 3 })).toEqual({
      type: "move-highlight",
      index: 0,
    });
    expect(press({ key: "ArrowUp", highlightIndex: 0 })).toEqual({
      type: "move-highlight",
      index: 3,
    });
  });

  it("wraps among options only when custom answers are disabled", () => {
    expect(press({ key: "ArrowDown", question: choiceOnly, highlightIndex: 2 })).toEqual({
      type: "move-highlight",
      index: 0,
    });
    expect(press({ key: "ArrowUp", question: choiceOnly, highlightIndex: 0 })).toEqual({
      type: "move-highlight",
      index: 2,
    });
  });

  it("single-select Enter chooses the highlighted option, which selects and advances", () => {
    expect(press({ key: "Enter", highlightIndex: 1 })).toEqual({
      type: "choose-option",
      optionIndex: 1,
    });
  });

  it("single-select Space selects without advancing", () => {
    expect(press({ key: " ", highlightIndex: 1 })).toEqual({
      type: "toggle-option",
      optionIndex: 1,
    });
  });

  it("multi-select Enter submits once something is chosen", () => {
    expect(press({ key: "Enter", question: multi, highlightIndex: 1, canAdvance: true })).toEqual({
      type: "submit",
    });
  });

  it("multi-select Enter picks the highlighted option when nothing is chosen yet", () => {
    expect(press({ key: "Enter", question: multi, highlightIndex: 1 })).toEqual({
      type: "toggle-option",
      optionIndex: 1,
    });
  });

  it("multi-select Space toggles the highlighted option", () => {
    expect(press({ key: " ", question: multi, highlightIndex: 2, canAdvance: true })).toEqual({
      type: "toggle-option",
      optionIndex: 2,
    });
  });

  it("does not choose an option when the free-text row is the highlighted row", () => {
    expect(press({ key: "Enter", highlightIndex: 3 })).toEqual({ type: "none" });
    expect(press({ key: "Enter", highlightIndex: 3, canAdvance: true })).toEqual({
      type: "submit",
    });
    expect(press({ key: " ", highlightIndex: 3 })).toEqual({ type: "none" });
  });

  it("submits from the free-text field only when there is an answer", () => {
    expect(press({ key: "Enter", context: "text", highlightIndex: 3 })).toEqual({ type: "none" });
    expect(press({ key: "Enter", context: "text", highlightIndex: 3, canAdvance: true })).toEqual({
      type: "submit",
    });
  });

  it("steps out of the free-text field with arrows and Escape", () => {
    expect(press({ key: "ArrowUp", context: "text", highlightIndex: 3 })).toEqual({
      type: "move-highlight",
      index: 2,
    });
    expect(press({ key: "ArrowDown", context: "text", highlightIndex: 3 })).toEqual({
      type: "move-highlight",
      index: 0,
    });
    expect(press({ key: "Escape", context: "text", highlightIndex: 3 })).toEqual({
      type: "leave-text",
    });
  });
});

describe("shouldFocusPendingUserInputPanel", () => {
  it("takes focus unless the user was typing elsewhere a moment ago", () => {
    expect(shouldFocusPendingUserInputPanel(null)).toBe(true);
    expect(shouldFocusPendingUserInputPanel(5000)).toBe(true);
    expect(shouldFocusPendingUserInputPanel(300)).toBe(false);
  });
});

describe("pending question steps", () => {
  const questions = [
    { ...singleSelectQuestion, id: "first", header: "First" },
    {
      ...singleSelectQuestion,
      id: "second",
      header: "Second",
      options: [{ label: "Alpha", description: "x", value: "alpha" }],
    },
    { ...singleSelectQuestion, id: "third", header: "Third" },
  ];

  it("marks answered questions done with a readable summary", () => {
    const steps = derivePendingUserInputSteps(
      questions,
      { first: { selectedOptionValues: ["Orchestration-first"] } },
      1,
    );
    expect(steps.map((step) => step.status)).toEqual(["done", "current", "upcoming"]);
    expect(steps[0]?.summary).toBe("Orchestration-first");
  });

  it("describes typed answers verbatim and option values by label", () => {
    expect(describePendingUserInputAnswer(questions[0]!, { customAnswer: " my own " })).toBe(
      "my own",
    );
    expect(describePendingUserInputAnswer(questions[1]!, { selectedOptionValues: ["alpha"] })).toBe(
      "Alpha",
    );
    expect(describePendingUserInputAnswer(questions[1]!, undefined)).toBeNull();
  });
});

describe("custom answer precedence in the panel", () => {
  it("lets typed text win over a selected option, and clears the selection", () => {
    const typed = setPendingUserInputCustomAnswer({ selectedOptionValues: ["A"] }, "mine");
    expect(typed.selectedOptionValues).toBeUndefined();
    expect(resolvePendingUserInputAnswer(singleSelectQuestion, typed)).toBe("mine");
  });

  it("ignores typed text entirely when custom answers are disabled", () => {
    const choiceOnly = { ...singleSelectQuestion, allowCustomAnswer: false };
    expect(
      resolvePendingUserInputAnswer(choiceOnly, {
        customAnswer: "mine",
        selectedOptionValues: ["Orchestration-first"],
      }),
    ).toBe("Orchestration-first");
    expect(resolvePendingUserInputAnswer(choiceOnly, { customAnswer: "mine" })).toBeNull();
  });
});
