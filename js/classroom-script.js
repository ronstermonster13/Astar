// Google Apps Script that Astar asks you to paste into script.google.com (see Settings → Google Classroom sync).
// It runs under your own school account and returns your upcoming Classroom work as JSON.
const CLASSROOM_SCRIPT = `/**
 * Astar ↔ Google Classroom sync.
 * Returns your Classroom assignments due from 2 weeks ago onwards, with whether you've handed them in.
 * Needs the "Google Classroom API" service and the appsscript.json from Astar's Settings,
 * which asks only for student permissions (read your classes and your own work).
 */
function doGet(e) {
  var out;
  try {
    if (e && e.parameter && e.parameter.slides) {
      // Text of the Google Slides / Docs attached to your Classroom posts, so Claude can turn them into flashcards
      // Big batches are read in parts: Astar calls again with start=next until next is null
      var sl = getSlidesText(Number(e.parameter.start) || 0);
      out = { updated: new Date().toISOString(), version: 2, files: sl.files, skipped: sl.skipped, courses: sl.courses, next: sl.next };
      return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
    }
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

/** Text from slides/docs/PDFs attached to Classroom posts in the last 120 days, up to 80 files or 2½ minutes per part (a single big PowerPoint can take a
 * minute to convert, so this keeps well inside Google's 6-minute limit).
 * Google Slides/Docs are exported directly. PowerPoint, Word and PDF files are converted via a
 * temporary Google copy in your Drive, which is deleted straight after reading. */
function getSlidesText(start) {
  start = start || 0;
  var tz = 'Europe/London';
  var since = Utilities.formatDate(new Date(Date.now() - 120 * 864e5), tz, 'yyyy-MM-dd');
  var courses = Classroom.Courses.list({ studentId: 'me', courseStates: ['ACTIVE'] }).courses || [];
  var seen = {}, files = [], skipped = [], started = Date.now(), n = 0, next = null;
  var token = ScriptApp.getOAuthToken();
  var CONVERT = {
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'application/vnd.google-apps.presentation',
    'application/vnd.ms-powerpoint': 'application/vnd.google-apps.presentation',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'application/vnd.google-apps.document',
    'application/msword': 'application/vnd.google-apps.document',
    'application/pdf': 'application/vnd.google-apps.document'
  };
  // Uses the built-in Drive service (Services → Drive API), which also switches the Drive API on for this script
  var errText = function (e) { return String(e && e.message || e).replace(/^.*failed with error: /, '').replace(/^GoogleJsonResponseException: /, '').slice(0, 140); };
  var exportText = function (id) {
    var r = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + id + '/export?mimeType=text/plain',
      { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) {
      var msg = r.getContentText(); try { msg = JSON.parse(msg).error.message; } catch (e) {}
      throw new Error('export ' + r.getResponseCode() + ': ' + String(msg).slice(0, 120));
    }
    return r.getContentText();
  };
  var readText = function (id) {
    var meta;
    try { meta = Drive.Files.get(id, { fields: 'mimeType,name', supportsAllDrives: true }); }
    catch (e) { return { skip: 'no access: ' + errText(e) }; }
    var mime = meta.mimeType;
    if (mime === 'application/vnd.google-apps.presentation' || mime === 'application/vnd.google-apps.document') {
      try { return { text: exportText(id) }; } catch (e) { return { skip: errText(e) }; }
    }
    if (!CONVERT[mime]) return { skip: 'not a slide/doc/PDF: ' + mime };
    var copy;
    try { copy = Drive.Files.copy({ name: 'Astar temp copy', mimeType: CONVERT[mime] }, id, { supportsAllDrives: true }); }
    catch (e) { return { skip: 'could not convert ' + mime.split('.').pop() + ': ' + errText(e) }; }
    try { return { text: exportText(copy.id) }; }
    catch (e) { return { skip: 'converted copy unreadable: ' + errText(e) }; }
    finally { try { Drive.Files.remove(copy.id); } catch (e) {} } // delete the temporary copy
  };
  courses.forEach(function (c) {
    var posts = [];
    try { posts = posts.concat(Classroom.Courses.CourseWorkMaterials.list(c.id, { pageSize: 60 }).courseWorkMaterial || []); } catch (e) {}
    try { posts = posts.concat(Classroom.Courses.CourseWork.list(c.id, { pageSize: 60 }).courseWork || []); } catch (e) {}
    posts.forEach(function (p) {
      var when = Utilities.formatDate(new Date(p.creationTime || p.updateTime), tz, 'yyyy-MM-dd');
      if (when < since) return;
      (p.materials || []).forEach(function (m) {
        var id = null, title = '';
        if (m.driveFile && m.driveFile.driveFile) { id = m.driveFile.driveFile.id; title = m.driveFile.driveFile.title || ''; }
        else if (m.link && m.link.url) {
          var mm = m.link.url.match(new RegExp('docs[.]google[.]com/(presentation|document)/d/([A-Za-z0-9_-]+)'));
          if (mm) { id = mm[2]; title = m.link.title || m.link.url; }
        }
        if (!id || seen[id]) return;
        seen[id] = true;
        n++;
        if (n <= start || next !== null) return; // read in an earlier part, or left for the next one
        if (files.length >= 80 || Date.now() - started > 150000) { next = n - 1; return; }
        try {
          var res = readText(id);
          if (res.text) files.push({ course: c.name, post: p.title || '', date: when, file: title, text: res.text.slice(0, 20000) });
          else skipped.push({ course: c.name, file: title, reason: res.skip });
        } catch (e) { skipped.push({ course: c.name, file: title, reason: String(e.message || e).slice(0, 100) }); }
      });
    });
  });
  return { files: files, skipped: skipped, courses: courses.length, next: next };
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

/** Run this once to allow reading your class slides, and check how many it can read. */
function testSlides() {
  var r = getSlidesText();
  Logger.log('Classes: ' + r.courses + '. Read text from ' + r.files.length + ' files; skipped ' + r.skipped.length + '.' + (r.next !== null ? ' More files left: Astar reads them in further parts.' : ''));
  r.files.slice(0, 10).forEach(function (f) { Logger.log('OK ' + f.course + ': ' + f.file + ' (' + f.text.length + ' characters)'); });
  r.skipped.slice(0, 15).forEach(function (f) { Logger.log('SKIPPED ' + f.course + ': ' + f.file + ' (' + f.reason + ')'); });
}
`;

// appsscript.json: asks only for student permissions. The default auto-detected
// permissions can include teacher-style coursework access, which Google refuses for students.
const CLASSROOM_MANIFEST = `{
  "timeZone": "Europe/London",
  "dependencies": {
    "enabledAdvancedServices": [
      { "userSymbol": "Classroom", "version": "v1", "serviceId": "classroom" },
      { "userSymbol": "Drive", "version": "v3", "serviceId": "drive" }
    ]
  },
  "oauthScopes": [
    "https://www.googleapis.com/auth/classroom.courses.readonly",
    "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
    "https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly",
    "https://www.googleapis.com/auth/classroom.topics.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/script.external_request"
  ],
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8"
}
`;
