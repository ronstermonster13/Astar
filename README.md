# Astar ★

An A level revision app built around the strongest evidence on how people learn. It covers English Literature, History, Biology and Religious Studies, set up for the Latymer School's exam boards.

| Subject | Board |
|---|---|
| English Literature | Eduqas A720QS |
| History | AQA 7042 (Russia 1855–1964, English Revolution 1625–60, NEA Ireland 1798–1921) |
| Biology | AQA 7402 |
| Religious Studies | OCR H573 |

## Run it

Open `index.html` in a browser. There is nothing to install. Progress is saved in that browser, and you can export a backup from **Settings**.

## Features and the research behind them

- **Planner:** a month calendar showing homework on its due date (synced from Classroom), exams, holidays, rest days and planned revision time. Tap a day to see and edit its plan.
  - A realistic daily plan runs up to your Year 12 exams.
  - Study time per day: 45 minutes on school days, 90 on weekends, 120 in holidays, plus a weekly rest day. Christmas Eve, Christmas Day, Boxing Day and New Year's Day are rest days.
  - Three phases:
    - **Build & consolidate:** blurts, making cards from class notes, essay plans.
    - **Exam practice** (from 8 weeks before): timed answers.
    - **Exam prep** (final 3 weeks, about a third more time): full past papers.
  - Tick tasks off, delete them, add your own, and mark any day as school, weekend, holiday or rest.
- **Homework:**
  - **Automatic Google Classroom sync.** A small Google Apps Script (`js/classroom-script.js`; the setup steps are in Settings) runs under your school account. Each time Astar opens, it pulls in new assignments and ticks off work you've handed in.
  - Or add homework with a quick form, or import Google Classroom due dates. Export Google Calendar as `.ics` files and the app reads them; re-importing skips anything already added.
  - Each piece lands in the planner the day before it's due (skipping rest days), and you can move it to another day.
  - On heavy homework nights, revision is cut back to flashcards only.
- **Covered in class:** topics are ticked automatically from what Google Classroom shows you've been taught (assignments, posted materials and topic names, matched to the spec by keyword). You can tick or untick them by hand on the Topics page. New flashcards only come from covered topics, and planner tasks focus on what you've been taught in the last 3 weeks.
- **My activities:** add weekly or one-off commitments (sport, clubs, a job). They show on the calendar. Busy days get less revision, and homework is scheduled for a quieter day before it's due.
- **Flashcards:** organised as subject › topic › subtopic, with subtopics named after the official spec headings (checked against the AQA 7402, AQA 7042 and OCR H573 spec PDFs). For example: Biology › 3.1.4.2 Many proteins are enzymes; History › 1894–1917 · Opposition; RS › The falsification symposium; English › C2 Section A · Shakespeare: Act 3. Every question is listed under its subtopic and can be studied on its own.
  - Your typed answer is checked against the key words in the model answer (looks right / partly / doesn't match). It's a hint; you have the final say.
  - A green tick animation for right answers and a red shake for wrong ones, with a score ring at the end of each session (reduced if your device asks for less motion).
  - Studying a subtopic with nothing due gives a practice round that doesn't change your review schedule.
- **Review:** spaced-repetition flashcards using SM-2.
  - You commit to an answer and rate your confidence before you see the answer.
  - Mixed mode interleaves topics.
  - Review gaps are capped at about 15% of the days left until your exam.
  - New cards stop 14 days before an exam.
  - If you were sure but got it wrong, the card is flagged and comes back in the same session (hypercorrection).
- **Blurt:** write everything you know about a topic from memory, then tick off the key points you got. The points you missed become cards.
- **Timed practice:** each board's real paper timings, plan templates and a question bank. You then mark yourself against each assessment objective, and an AO profile shows your weakest one.
- **Past papers:** log your marks, and turn lost marks into cards.
- **Topics:** a red, amber and green rating for every spec topic.
- **Timeline:** put History events in date order.
- **Coursework:** word counts, milestones and deadlines for both pieces of coursework.
- **Focus timer:** 25 minutes on, 5 minutes off, with a long break after 4 rounds.
- **Sleep nudge** late at night, and a **weekly reflection** prompt.
- **Why it works:** a page showing the evidence behind each feature.

All the content is in `js/data.js`. Add cards there or in the app. Check set texts and quotations against your own editions.
