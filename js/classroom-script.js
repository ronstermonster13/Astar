// Google Apps Script that Astar asks you to paste into script.google.com (see Settings → Google Classroom sync).
// It runs under your own school account and returns your upcoming Classroom work as JSON.
const CLASSROOM_SCRIPT = `/**
 * Astar ↔ Google Classroom sync.
 * Returns your Classroom assignments due from 2 weeks ago onwards, with whether you've handed them in.
 * Needs the "Google Classroom API" service (Services + → Google Classroom API → Add).
 */
function doGet() {
  var out;
  try {
    out = { updated: new Date().toISOString(), items: getHomework() };
  } catch (e) {
    out = { error: String(e && e.message || e) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function getHomework() {
  var tz = 'Europe/London';
  var since = Utilities.formatDate(new Date(Date.now() - 14 * 864e5), tz, 'yyyy-MM-dd');
  var courses = Classroom.Courses.list({ studentId: 'me', courseStates: ['ACTIVE'] }).courses || [];
  var items = [];
  courses.forEach(function (c) {
    // Which pieces of work you've handed in
    var done = {};
    var token;
    do {
      var subs = Classroom.Courses.CourseWork.StudentSubmissions.list(c.id, '-', { userId: 'me', pageToken: token, pageSize: 100 });
      (subs.studentSubmissions || []).forEach(function (s) {
        done[s.courseWorkId] = s.state === 'TURNED_IN' || s.state === 'RETURNED';
      });
      token = subs.nextPageToken;
    } while (token);
    var work = Classroom.Courses.CourseWork.list(c.id, { orderBy: 'dueDate desc', pageSize: 60 }).courseWork || [];
    work.forEach(function (w) {
      if (!w.dueDate) return;
      var t = w.dueTime || {};
      var dueAt = new Date(Date.UTC(w.dueDate.year, w.dueDate.month - 1, w.dueDate.day, t.hours || 0, t.minutes || 0));
      var due = w.dueTime ? Utilities.formatDate(dueAt, tz, 'yyyy-MM-dd')
        : w.dueDate.year + '-' + ('0' + w.dueDate.month).slice(-2) + '-' + ('0' + w.dueDate.day).slice(-2);
      if (due < since) return;
      items.push({ id: w.id, course: c.name, title: w.title, due: due, link: w.alternateLink, done: !!done[w.id] });
    });
  });
  return items;
}

/** Run this once from the editor to grant permission and check it works (see the log). */
function test() {
  Logger.log(JSON.stringify(getHomework(), null, 2));
}
`;
