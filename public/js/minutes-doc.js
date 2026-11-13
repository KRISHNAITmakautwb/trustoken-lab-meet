/**
 * TrusMeet: meeting minutes in the Indian official (Government / institute) format.
 * The minutes are edited as fields and signed as one plain-text document in a
 * fixed layout. The text depends only on the fields (no locale formatting), so
 * everyone who approves the same minutes signs exactly the same text.
 */
(function () {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  const NONE = 'Nil.';

  function parseDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    return m ? { y: m[1], m: Number(m[2]), d: Number(m[3]) } : null;
  }

  // "13 November 2026"
  function formatDate(iso) {
    const p = parseDate(iso);
    return p ? `${p.d} ${MONTHS[p.m - 1] || ''} ${p.y}` : (iso || '').trim();
  }

  // "13.11.2026", as on official letters
  function formatShortDate(iso) {
    const p = parseDate(iso);
    return p ? `${String(p.d).padStart(2, '0')}.${String(p.m).padStart(2, '0')}.${p.y}` : (iso || '').trim();
  }

  // One entry per line; leading bullets or numbers people type are dropped.
  function listItems(text) {
    return String(text || '').split('\n')
      .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)]|\d+\.\d+)\s*/, '').trim())
      .filter(Boolean);
  }

  const oneLine = (s) => String(s || '').replace(/\s*\n\s*/g, ', ').trim();
  const names = (s) => String(s || '').split(/\s*[,\n]\s*/).map((n) => n.trim()).filter(Boolean);
  const withDesignation = (name, designation) => [oneLine(name), oneLine(designation)].filter(Boolean).join(', ');

  // "Crypto Lab Weekly" -> "Crypto Lab Weekly meeting"; a title ending in "meeting" is kept as is.
  function meetingName(d) {
    const title = oneLine(d.title);
    if (!title) return 'meeting';
    return /\bmeeting$/i.test(title) ? title : `${title} meeting`;
  }

  function heldSentence(d) {
    const when = formatDate(d.date) || 'the scheduled date';
    const hrs = (t) => (t ? `${t} hrs` : '');
    const time = d.startTime && d.endTime ? ` from ${hrs(d.startTime)} to ${hrs(d.endTime)}`
      : (d.startTime ? ` at ${hrs(d.startTime)}` : '');
    const tz = time && d.timeZone ? ` (${oneLine(d.timeZone)})` : '';
    const venue = oneLine(d.venue);
    const where = venue ? (/(online|video|virtual|trusmeet)/i.test(venue) ? ` through ${venue}` : ` at ${venue}`) : '';
    const chair = withDesignation(d.chair, d.chairDesignation);
    const under = chair ? ` under the chairmanship of ${chair}` : '';
    return `The ${meetingName(d)} was held on ${when}${time}${tz}${where}${under}. The list of participants is at Annexure-I.`;
  }

  function renderMinutesText(doc, meetingId) {
    const d = doc || {};
    const lines = [];
    if (oneLine(d.organisation)) lines.push(oneLine(d.organisation));
    if (oneLine(d.department)) lines.push(oneLine(d.department));
    lines.push(`No.: ${oneLine(d.refNo) || `TrusMeet/${meetingId || ''}`}`);
    lines.push(`Dated: ${formatShortDate(d.date) || 'Not recorded'}`);
    lines.push('', 'MINUTES OF THE MEETING', '');
    lines.push(`Subject: Minutes of the ${meetingName(d)} held on ${formatDate(d.date) || 'the scheduled date'}.`, '');

    let n = 1;
    lines.push(`${n}. ${heldSentence(d)}`, '');

    const numbered = (items) => (items.length ? items.map((t, i) => `${n}.${i + 1} ${t}`) : [NONE]);
    n += 1;
    lines.push(`${n}. AGENDA`, ...numbered(listItems(d.agenda)), '');
    n += 1;
    lines.push(`${n}. DISCUSSION`, String(d.discussion || '').replace(/\r/g, '').trim() || NONE, '');
    n += 1;
    lines.push(`${n}. DECISIONS TAKEN`, ...numbered(listItems(d.decisions)), '');
    n += 1;
    const actions = (Array.isArray(d.actions) ? d.actions : []).filter((a) => a && String(a.task || '').trim());
    lines.push(`${n}. ACTION POINTS`);
    if (actions.length) {
      actions.forEach((a, i) => {
        lines.push(`${n}.${i + 1} ${oneLine(a.task)} | Action by: ${oneLine(a.owner) || 'To be assigned'} | Timeline: ${formatShortDate(a.due) || 'As early as possible'}`);
      });
    } else {
      lines.push(NONE);
    }
    lines.push('');
    n += 1;
    lines.push(`${n}. NEXT MEETING`, oneLine(d.nextMeeting) || 'Will be intimated separately.', '');
    n += 1;
    lines.push(`${n}. The meeting ended with a vote of thanks to the Chair.`, '');

    lines.push(`Minutes recorded by: ${withDesignation(d.minuteTaker, d.minuteTakerDesignation) || 'Not recorded'} (Member Secretary / Convener)`);
    lines.push(`Approved by: ${withDesignation(d.chair, d.chairDesignation) || 'Not recorded'} (Chairperson)`, '');
    lines.push('To: All participants');
    lines.push(`Copy to: ${oneLine(d.copyTo) || 'Nil'}`, '');

    lines.push('ANNEXURE-I: LIST OF PARTICIPANTS');
    const present = names(d.present);
    lines.push(...(present.length ? present.map((name, i) => `${i + 1}) ${name}`) : ['Not recorded']));
    const absent = names(d.absent);
    lines.push(`Leave of absence: ${absent.length ? absent.join(', ') : 'Nil'}`);
    return lines.join('\n');
  }

  // Is there anything worth approving beyond the header?
  function hasContent(doc) {
    const d = doc || {};
    return Boolean(listItems(d.agenda).length || String(d.discussion || '').trim()
      || listItems(d.decisions).length
      || (Array.isArray(d.actions) && d.actions.some((a) => a && String(a.task || '').trim())));
  }

  window.MinutesDoc = { renderMinutesText, hasContent, formatDate, formatShortDate };
})();
