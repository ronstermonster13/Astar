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

## On your phone

Astar is online at https://ronstermonster13.github.io/Astar/ (GitHub Pages, updated each time a release is pushed).

- **iPhone:** open the link in Safari, tap Share, then **Add to Home Screen**.
- **Android:** open it in Chrome, tap ⋮, then **Install app** (or **Add to Home screen**).

Once installed it opens full screen and works offline. Progress is saved on each device separately: use **Settings → Export backup** on one and **Import backup** on the other to move it across.

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
  - **Past-paper cards** (📄) come from real exam questions, each citing its paper. Answers are based on the mark scheme: 45 Biology (AQA 7402, 2017–24), 37 History (AQA 7042 1H/2E, 2020–23), 40 RS (OCR H573, 2021–24) and 31 English (Eduqas A720QS, 2017–25, your set texts only).
  - Only content you'll be examined on: Paradise Lost cards cover Book IX only (the only Book Eduqas sets), and History cards cover only components 1H and 2E.
  - **Cards from your class slides:** Settings → Google Classroom sync → *Export class slides for Claude* saves the text of the Google Slides and Docs attached to your Classroom posts to a file in Downloads. Big batches are read in parts (about 3 minutes each) to stay inside Google's time limit. Claude turns the file into spec-aligned cards: so far 302 cards, each citing its lesson: 98 Biology (biological molecules, cells, membrane transport), 116 History (Russia 1855–94 and the English Revolution 1625–29), 57 English (Ted Hughes and the context for Loot) and 31 RS (Plato and Aristotle).
  - Your typed answer is checked against the key words in the model answer (looks right / partly / doesn't match). It's a hint; you have the final say.
  - A green tick animation for right answers and a red shake for wrong ones, with a score ring at the end of each session (reduced if your device asks for less motion).
  - Studying a subtopic with nothing due gives a practice round that doesn't change your review schedule.
- **Notes ✍️:** write or dictate your own notes in lessons, filed by subject and topic, with search.
  - Each note makes draft flashcards as you type, and it's saved as you go.
  - *Save notes for checking* puts unchecked notes in a file in Downloads. Tell Claude "check my notes" and reload when it's done (the steps Claude follows are in `CLAUDE.md`, and the results go in `js/notes-checked.js`).
  - The Notes page then shows the corrected note, what was changed, and anything to ask your teacher. Your original stays underneath.
  - Only checked cards join your reviews, ahead of other new cards. Changing a note's text takes its cards out until it's checked again.
  - Dictation needs a browser with speech recognition. Chrome sends the audio to Google to transcribe.
- **Subjects you might switch to 🔭:** in Settings, tick Business (AQA 7138), PE (AQA 7582) or Psychology (AQA 7182, board unconfirmed) to add their flashcards, topics, blurts and timed practice. Business and PE match the A levels at Barnet & Southgate College's Borehamwood campus (the PASE Academy). They stay out of the daily plan and mixed review.
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
