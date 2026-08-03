const CALENDAR_ID = 'frt.shibuya@gmail.com';
const SPREADSHEET_ID = '1WJCFJmiSZoSTCu0UQK3IBFYzpWq8H-U0gksyzScU8m8';
const INTERVIEW_SHEET_NAME = '面談リスト';

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents || '{}');
    const meeting = data.meeting || {};
    const member = data.member || {};
    console.log('received title: ' + (meeting.title || ''));
    console.log('received member: ' + (member.name || ''));

    const start = new Date(meeting.start);
    const end = new Date(meeting.end);
    const location = meeting.location || member.fixedLink || '';

    const sheetResult = safeUpdateInterviewSheet(meeting, member, start);
    const calendarResult = safeCreateCalendarEvent(meeting, member, start, end, location, sheetResult);

    return ContentService
      .createTextOutput(JSON.stringify({
        ok: sheetResult.ok && calendarResult.ok,
        sheet: sheetResult,
        calendar: calendarResult
      }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    console.error(error);
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: error.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function safeUpdateInterviewSheet(meeting, member, start) {
  try {
    return updateInterviewSheet(meeting, member, start);
  } catch (error) {
    const message = 'シート連携エラー: ' + error.message;
    console.error(message);
    return { ok: false, message: message };
  }
}

function updateInterviewSheet(meeting, member, start) {
  const title = String(meeting.title || '').replace(/\s/g, '');
  if (!title.includes('1次')) {
    const message = 'スプレッドシート入力対象外: ' + (meeting.title || '');
    console.log(message);
    return { ok: true, skipped: true, message: message };
  }

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheets().find(s => s.getName().trim() === INTERVIEW_SHEET_NAME);
  if (!sheet) throw new Error('面談リスト シートが見つかりません');

  const row = firstEmptyRowInColumn(sheet, 4);
  sheet.getRange(row, 4).setValue(formatMonthDay(start));
  sheet.getRange(row, 8).setValue(member.name || '');
  sheet.getRange(row, 10).setValue(extractCandidateName(meeting.title));
  SpreadsheetApp.flush();
  const message = '面談リスト更新: row=' + row + ', date=' + formatMonthDay(start) + ', member=' + (member.name || '') + ', candidate=' + extractCandidateName(meeting.title);
  console.log(message);
  return {
    ok: true,
    message: message,
    row: row,
    date: formatMonthDay(start),
    member: member.name || '',
    candidate: extractCandidateName(meeting.title)
  };
}

function extractCandidateName(title) {
  const match = String(title || '').match(/】\s*(.*?)\s*様/);
  return match ? match[1] : '';
}

function firstEmptyRowInColumn(sheet, column) {
  const startRow = 3;
  const maxRows = Math.max(sheet.getMaxRows() - startRow + 1, 1);
  const values = sheet.getRange(startRow, column, maxRows, 1).getValues();
  const index = values.findIndex(row => !row[0]);
  if (index >= 0) return startRow + index;
  return sheet.getLastRow() + 1;
}

function formatMonthDay(date) {
  return Utilities.formatDate(date, 'Asia/Tokyo', 'MM/dd');
}

function safeCreateCalendarEvent(meeting, member, start, end, location, sheetResult) {
  try {
    createCalendarEvent(meeting, member, start, end, location, sheetResult);
    return { ok: true, message: 'カレンダー登録済み: ' + (meeting.title || '予定') };
  } catch (error) {
    const message = 'カレンダー登録エラー: ' + error.message;
    console.error(message);
    return { ok: false, message: message };
  }
}

function createCalendarEvent(meeting, member, start, end, location, sheetResult) {
  const calendar = CalendarApp.getCalendarById(CALENDAR_ID);

  const description = [
    '担当メンバー: ' + (member.name || ''),
    '通知アドレス: ' + (member.email || ''),
    '場所・URL: ' + location,
    'シート連携: ' + ((sheetResult && sheetResult.message) || ''),
    '',
    meeting.note || ''
  ].join('\n');

  calendar.createEvent(meeting.title || '予定', start, end, {
    location: location,
    description: description,
    guests: member.email || '',
    sendInvites: Boolean(member.email)
  });
}
