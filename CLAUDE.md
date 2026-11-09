# Astar

## "Check my notes"

The Notes page keeps lesson notes in the browser. "Save notes for checking" writes `astar-notes-YYYY-MM-DD.json` to `~/Downloads`. When the user says "check my notes":

1. Read the newest `astar-notes-*.json` in `~/Downloads`.
2. Check every note against the exam board's spec for that subject (see `SUBJECTS` in `js/data.js`) and reliable sources. Look up anything you aren't sure of. Mark a point `unsure` rather than guess.
   - `wrong` is for errors of fact: dates, names, definitions, processes, misquotations you can confirm from the text.
   - `unsure` is for things you can't confirm, or that may depend on what the teacher said. It tells the user to ask their teacher.
   - Interpretations in English, History and RS are not errors just because you would argue differently. Only flag them if the evidence contradicts them.
   - Transcribed notes may contain speech-recognition slips. Fix an obvious slip in `text` without listing it as the user's mistake.
3. Add an entry to `NOTES_CHECKED` in `js/notes-checked.js`, keyed by note `id`. Keep entries already there:

```js
"<id>": {
  hash: "<hash, copied exactly from the export>",
  checked: "YYYY-MM-DD",
  summary: "One plain sentence on what you found.",
  text: "The note with errors fixed and spelling tidied, in the user's own words. Use # headings, - bullets and Term: meaning lines.",
  issues: [{ type: "wrong", you: "what they wrote", fix: "the correct version", why: "short reason or source" },
           { type: "unsure", you: "what they wrote", fix: "what to ask", why: "short reason" }],
  cards: [["Question", "Answer", "Spec subtopic"]],
},
```

4. Cards: one specific question each, covering what the note says, using the corrected facts. Use a subtopic name that matches existing cards in `js/data.js` for that topic where one fits. Don't add content beyond the note.
5. `hash` must match exactly: the app ignores an entry if the note's text has since changed.
6. Tell the user what you corrected and what to ask about, and to reload the app.
