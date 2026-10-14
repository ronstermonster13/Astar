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
