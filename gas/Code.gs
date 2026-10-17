/**
 * Reo AI ⇔ Google カレンダー / Gmail 連携スクリプト
 * 1. https://script.google.com で「新しいプロジェクト」→ このコードを全部貼り付け
 * 2. 下の TOKEN を Reo AI の設定画面に表示された合言葉に書き換え（コピーした場合は設定済み）
 * 3. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *    実行ユーザー: 自分 / アクセスできるユーザー: 全員 → デプロイ → アクセスを承認
 * 4. 表示された「ウェブアプリのURL」（…/exec）を Reo AI の設定に貼る
 * メールの送信機能はありません（下書きのみ）。
 */
const TOKEN = '__TOKEN__';

function doPost(e) {
  let req = {};
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out({ error: 'bad request' }); }
  if (!TOKEN || TOKEN.indexOf('__') === 0 || req.token !== TOKEN) return out({ error: 'token mismatch' });
  try {
    switch (req.action) {
      case 'ping': return out({ ok: true, email: Session.getActiveUser().getEmail(), tz: Session.getScriptTimeZone() });
      case 'calendar_events': return out(calendarEvents(req));
      case 'calendar_create': return out(calendarCreate(req));
      case 'gmail_search': return out(gmailSearch(req));
      case 'gmail_read': return out(gmailRead(req));
      case 'gmail_draft': return out(gmailDraft(req));
      default: return out({ error: 'unknown action' });
    }
  } catch (err) { return out({ error: String(err) }); }
}
function doGet() { return out({ ok: true, app: 'Reo AI bridge' }); }
function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function fmt(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ssXXX"); }

function calendarEvents(r) {
  const start = new Date(r.start), end = new Date(r.end);
  const q = (r.query || '').toLowerCase();
  const list = [];
  CalendarApp.getAllCalendars().forEach(function (cal) {
    cal.getEvents(start, end).forEach(function (ev) {
      const t = ev.getTitle();
      if (q && t.toLowerCase().indexOf(q) < 0) return;
      list.push({ title: t, start: fmt(ev.getStartTime()), end: fmt(ev.getEndTime()), allDay: ev.isAllDayEvent(), location: ev.getLocation(), calendar: cal.getName() });
    });
  });
  list.sort(function (a, b) { return a.start < b.start ? -1 : 1; });
  return { events: list.slice(0, 100) };
}
function calendarCreate(r) {
  const ev = CalendarApp.getDefaultCalendar().createEvent(r.title, new Date(r.start), new Date(r.end), { location: r.location || '', description: r.description || '' });
  return { created: true, title: ev.getTitle(), start: fmt(ev.getStartTime()), end: fmt(ev.getEndTime()) };
}
function gmailSearch(r) {
  const threads = GmailApp.search(r.query || 'in:inbox', 0, Math.min(r.max || 10, 25));
  return { results: threads.map(function (th) {
    const m = th.getMessages().pop();
    return { id: m.getId(), from: m.getFrom(), subject: m.getSubject(), date: fmt(m.getDate()), unread: th.isUnread(), snippet: m.getPlainBody().replace(/\s+/g, ' ').slice(0, 200) };
  }) };
}
function gmailRead(r) {
  const m = GmailApp.getMessageById(r.id);
  return { from: m.getFrom(), to: m.getTo(), subject: m.getSubject(), date: fmt(m.getDate()), body: m.getPlainBody().slice(0, 8000) };
}
function gmailDraft(r) {
  const d = GmailApp.createDraft(r.to, r.subject, r.body);
  return { drafted: true, id: d.getId(), to: r.to, subject: r.subject };
}
