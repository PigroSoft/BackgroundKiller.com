/* The one place to change the version. Edit these two lines, then add an entry to CHANGELOG.md and public/CHANGELOG.txt. */
var BK_VERSION = '1.0.12';
var BK_UPDATED = '2026-11-08';

(function () {
  var el = document.getElementById('bkVersion'); if (!el) return;
  var d = new Date(BK_UPDATED + 'T12:00:00Z'), text = BK_UPDATED;
  try { text = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }); } catch (e) {}
  el.textContent = 'Version ' + BK_VERSION + ', updated ' + text;
})();
