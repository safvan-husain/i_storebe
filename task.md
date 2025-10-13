# Client Engineering Task: Per-Staff Custom Report Answers

## Overview
Custom report questions now support a per-staff answer mode. When a question is marked with the new `answerPerStaff` flag, managers must submit a separate answer for each of their active staff members. This impacts question definitions, response submission payloads, and how responses are read back from the API. Additionally, a new endpoint is available for managers to fetch the list of their active staff to drive the UI.

This document summarizes only the new/changed behaviour so you can integrate the feature without digging through Swagger.

---

## 1. Detect per-staff questions
Wherever the client consumes custom report questions (report creation, publish payloads, listing latest questions, etc.), each question object now includes:

```json
{
  "answerPerStaff": true | false
}
```

* Default is `false` and existing flows continue to work.
* Set `answerPerStaff: true` when authoring a question that requires per-staff answers.
* The flag is returned in all question payloads so the UI can decide whether to render a single answer control or per-staff controls.

Questions retain their existing `kind` values (`choice`, `choiceMultiSelect`, `textField`, `numberField`). The new flag simply toggles how answers should be captured.

---

## 2. Submitting responses with per-staff answers
The `POST /custom-report/:id/response` payload accepts a new optional `perStaffAnswers` array on each answer item:

```json
{
  "questionId": "<question ObjectId>",
  "perStaffAnswers": [
    {
      "staffId": "<staff ObjectId>",
      "textValue" | "numberValue" | "choiceValue": "..."
    }
  ]
}
```

* For questions with `answerPerStaff: true`, `perStaffAnswers` is **required** and must include an entry for every staff member you collect an answer for. The top-level `textValue`, `numberValue`, or `choiceValue` fields **must be omitted** for these questions.
* For questions with `answerPerStaff: false`, keep using the top-level answer fields and omit `perStaffAnswers`.
* `choiceValue` entries follow the existing shape with `optionIds` (array of option ObjectIds) and optional `otherText` / `otherNumber` when `allowOther` is enabled.

Validation rules from the existing question type still apply to each per-staff answer (e.g., required text length, number min/max, choice selection counts).

---

## 3. Reading submitted responses
`GET /custom-report/:id/response/:responseId` now returns per-staff answers when applicable. Each response item contains:

```json
{
  "questionId": "...",
  "kind": "textField" | "numberField" | "choice" | "choiceMultiSelect",
  "answerPerStaff": true | false,
  "answer": <single-value answer>?,
  "perStaffAnswers": [
    {
      "staffId": "...",
      "staffName": "..." | null,
      "answer": <per-staff answer>
    }
  ]?
}
```

* When `answerPerStaff` is `true`, `perStaffAnswers` is populated and `answer` is omitted.
* When `answerPerStaff` is `false`, `answer` is populated (same structure as before) and `perStaffAnswers` is omitted.
* Choice answers remain formatted as `{ options: [{ optionId, label, value }], otherText?, otherNumber? }`.

`answersCount` in list responses still counts the number of question entries, regardless of whether they contain per-staff answers.

---

## 4. Fetching a manager's active staff
Managers can now retrieve their active staff via a dedicated endpoint:

```
GET /user/manager/active-staff
```

* Requires authentication as a user with `privilege: "manager"`.
* Returns an array of staff user objects assigned to the manager where `isActive === true` and `isAccountDeleted !== true`.
* Other roles receive `403`.

Use this endpoint to populate the staff list before rendering per-staff answer inputs.

---

## 5. Implementation checklist for the client
1. When rendering report questions, inspect `answerPerStaff` to decide between single-answer UI vs per-staff UI.
2. For per-staff questions:
   * Fetch active staff via `GET /user/manager/active-staff`.
   * Collect answers keyed by staff ID.
   * Submit answers in the `perStaffAnswers` array, ensuring no top-level answer is sent.
3. When displaying responses, handle both variants (single `answer` or `perStaffAnswers`).

Following the above should enable the per-staff reporting workflow without additional backend changes.
