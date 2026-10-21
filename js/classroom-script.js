// Google Apps Script that Astar asks you to paste into script.google.com (see Settings → Google Classroom sync).
// It runs under your own school account and returns your upcoming Classroom work as JSON.
const CLASSROOM_SCRIPT = `/**
 * Astar ↔ Google Classroom sync.
 * Returns your Classroom assignments due from 2 weeks ago onwards, with whether you've handed them in.
 * Needs the "Google Classroom API" service and the appsscript.json from Astar's Settings,
 * which asks only for student permissions (read your classes and your own work).
 */
function doGet() {
  var out;
  try {
    var hw = getHomework();
    out = { updated: new Date().toISOString(), items: hw.items, warnings: hw.warnings, courses: hw.courses, taught: hw.taught };
  } catch (e) {
    out = { error: String(e && e.message || e) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function getHomework() {
  var tz = 'Europe/London';
  var since = Utilities.formatDate(new Date(Date.now() - 14 * 864e5), tz, 'yyyy-MM-dd');
  var courses = Classroom.Courses.list({ studentId: 'me', courseStates: ['ACTIVE'] }).courses || [];
  var items = [], warnings = [], summary = [], taught = [];
  var taughtSince = Utilities.formatDate(new Date(Date.now() - 120 * 864e5), tz, 'yyyy-MM-dd');
  courses.forEach(function (c) {
    var work, info = { name: c.name, assignments: null, upcoming: 0 };
    summary.push(info);
    try {
      work = Classroom.Courses.CourseWork.list(c.id, { orderBy: 'dueDate desc', pageSize: 60 }).courseWork || [];
      info.assignments = work.length;
    } catch (e) {
      info.error = shortError(e);
      warnings.push(c.name + ': could not read assignments (' + info.error + ')');
      return; // skip classes the school doesn't let us read
    }
    // What you've been taught: assignment and material titles, descriptions and Classroom topic names (all optional)
    var topicNames = {};
    try {
      (Classroom.Courses.Topics.list(c.id).topic || []).forEach(function (t) { topicNames[t.topicId] = t.name; });
    } catch (e) { /* topics not available */ }
    var addTaught = function (x, kind) {
      var when = Utilities.formatDate(new Date(x.creationTime || x.updateTime), tz, 'yyyy-MM-dd');
      if (when < taughtSince) return;
      taught.push({ course: c.name, title: x.title || '', text: String(x.description || '').slice(0, 300), topic: topicNames[x.topicId] || '', date: when, kind: kind });
    };
    work.forEach(function (w) { addTaught(w, 'work'); });
    try {
      (Classroom.Courses.CourseWorkMaterials.list(c.id, { pageSize: 60 }).courseWorkMaterial || []).forEach(function (m) { addTaught(m, 'material'); });
    } catch (e) { /* materials not available */ }
    // Hand-in status. Some schools/classes block this, so it's optional.
    var done = {}, statusKnown = true;
    try {
      var token;
      do {
        var subs = Classroom.Courses.CourseWork.StudentSubmissions.list(c.id, '-', { userId: 'me', pageToken: token, pageSize: 100 });
        (subs.studentSubmissions || []).forEach(function (s) {
          done[s.courseWorkId] = s.state === 'TURNED_IN' || s.state === 'RETURNED';
        });
        token = subs.nextPageToken;
      } while (token);
    } catch (e) {
      statusKnown = false;
      warnings.push(c.name + ': hand-in status not available (' + shortError(e) + ')');
    }
    work.forEach(function (w) {
      if (!w.dueDate) return;
      var t = w.dueTime || {};
      var dueAt = new Date(Date.UTC(w.dueDate.year, w.dueDate.month - 1, w.dueDate.day, t.hours || 0, t.minutes || 0));
      var due = w.dueTime ? Utilities.formatDate(dueAt, tz, 'yyyy-MM-dd')
        : w.dueDate.year + '-' + ('0' + w.dueDate.month).slice(-2) + '-' + ('0' + w.dueDate.day).slice(-2);
      if (due < since) return;
      info.upcoming++;
      items.push({ id: w.id, course: c.name, title: w.title, due: due, link: w.alternateLink, done: statusKnown ? !!done[w.id] : null });
    });
  });
  return { items: items, warnings: warnings, courses: summary, taught: taught.slice(0, 400) };
}

function shortError(e) {
  var m = String(e && e.message || e);
  return m.replace(/^.*failed with error: /, '').slice(0, 120);
}

/** Run this once from the editor to grant permission and check it works (see the log). */
function test() {
  var hw = getHomework();
  Logger.log('Classes: ' + hw.courses.length);
  hw.courses.forEach(function (c) {
    Logger.log('- ' + c.name + ': ' + (c.error ? 'ERROR ' + c.error : c.assignments + ' assignments, ' + c.upcoming + ' due recently/upcoming'));
  });
  Logger.log('Found ' + hw.items.length + ' assignments to sync, and ' + hw.taught.length + ' recent posts to work out what you have been taught.');
  hw.warnings.forEach(function (w) { Logger.log('Note: ' + w); });
  Logger.log(JSON.stringify(hw.items, null, 2));
}
`;

// appsscript.json: asks only for student permissions. The default auto-detected
// permissions can include teacher-style coursework access, which Google refuses for students.
const CLASSROOM_MANIFEST = `{
  "timeZone": "Europe/London",
  "dependencies": {
    "enabledAdvancedServices": [
      { "userSymbol": "Classroom", "version": "v1", "serviceId": "classroom" }
    ]
  },
  "oauthScopes": [
    "https://www.googleapis.com/auth/classroom.courses.readonly",
    "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
    "https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly",
    "https://www.googleapis.com/auth/classroom.topics.readonly"
  ],
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8"
}
`;
