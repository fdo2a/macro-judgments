// 텔레그램 보내기 — 일반 글자(parse_mode 없음)라 이스케이프 실수로 실패하지 않는다.
export async function sendMessage(fetch, token, chatId, text) {
  let r;
  try {
    r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
  } catch {
    return { ok: false, status: 0, description: 'network' };
  }
  let j = {};
  try { j = await r.json(); } catch { /* 본문 없음 */ }
  if (r.status === 200 && j.ok) return { ok: true, message_id: j.result && j.result.message_id };
  return { ok: false, status: r.status, description: j.description || '' };
}
