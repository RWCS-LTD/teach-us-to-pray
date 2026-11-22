/* Teach Us to Pray
 *
 * One small script, no dependencies. It loads its own files only, from the place
 * the app comes from: the language file, the Scripture file, and the Bible study
 * files (bible/index.json, then each book the first time it is opened). It never
 * sends anything about the person, and it uses no other website.
 *
 * What is kept, and where:
 * - Pray by myself: the words are kept for this visit in sessionStorage (erased when
 *   the tab closes), and in localStorage only if "keep my draft on this device" is on.
 * - Share Jesus: words are held in memory only and never stored, whatever that setting is.
 * - Bible study: the last chapter read and the translators' notes setting (localStorage),
 *   and books opened or downloaded (the Cache Storage named after the Bible version).
 */
(() => {
  'use strict';

  // Languages that have a lang/<code>.json file. See README: "Adding a language".
  const LANGS = ['en'];
  const DRAFT_KEY = 'teach-us-to-pray-draft';
  const VISIT_KEY = 'teach-us-to-pray-visit';   // sessionStorage: this visit only
  const PLACE_KEY = 'teach-us-to-pray-place';   // the last chapter read, e.g. "JHN/3"
  const HIDE_NOTES_KEY = 'teach-us-to-pray-hide-notes';

  let L;            // language strings
  let S;            // scripture document
  let PRAY;         // "Pray by myself": the guided prayer
  let SHARE;        // "Share Jesus": a leader guiding someone else
  let keep = false; // "keep my draft on this device" (Pray by myself only)
  let flash = '';   // one-time status message for the next render
  let prayerDay = null; // the day fixed when the person taps Begin (memory only)
  let IDX;          // bible/index.json: the books, their shelves and sizes
  const BOOKS = new Map(); // books opened this visit, by code
  let refLinks = true;  // Scripture references link to their chapter (not during Share Jesus)
  let visitKept = false; // the words of this visit are safe in sessionStorage
  let downloading = false;

  const main = document.getElementById('main');

  /* ---------- small helpers ---------- */

  // Create an element. Text is always added as text, never as HTML.
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid);
    return el;
  }

  // ['MAT 18:21', 'MAT 18:22'] -> 'Matthew 18:21-22'
  function refLabel(group) {
    const [book, first] = group[0].split(' ');
    const last = group[group.length - 1].split(':')[1];
    return L.books[book] + ' ' + first + (group.length > 1 ? '-' + last : '');
  }

  // An excerpt can begin or end partway through a speech. An unmatched quotation mark at
  // the very start or very end of the excerpt is not shown. An unmatched opening mark
  // further in (after "said,") stays, so the reader sees where the speaker begins.
  // Only marks are removed, never words. A single mark goes only when it is unmatched
  // and is at the very edge, or touches a removed double mark, because the closing
  // single mark is also the apostrophe. tools/verify.py applies the same rule.
  function trimQuotes(t) {
    const letter = (c) => /\p{L}/u.test(c || '');
    const strayDouble = new Set();
    const straySingle = new Set();
    const openD = [];
    const openS = [];
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (c === '“') openD.push(i);
      else if (c === '”') { if (openD.length) openD.pop(); else strayDouble.add(i); }
      else if (c === '‘') openS.push(i);
      else if (c === '’' && !(letter(t[i - 1]) && letter(t[i + 1]))) {
        if (openS.length) openS.pop(); else straySingle.add(i);
      }
    }
    openD.forEach((i) => strayDouble.add(i));
    openS.forEach((i) => straySingle.add(i));
    const atEdge = (i) => i === 0 || i === t.length - 1;
    const drop = new Set([...strayDouble, ...straySingle].filter(atEdge));
    for (const i of [...drop]) {
      if (t[i] === '“' && straySingle.has(i + 1)) drop.add(i + 1);
      if (t[i] === '”' && straySingle.has(i - 1)) drop.add(i - 1);
    }
    return t.split('').filter((_, i) => !drop.has(i)).join('');
  }

  // The text of a group of verses, exactly as shown. It comes only from the Scripture file.
  const scripture = (group) => trimQuotes(group.map((r) => S.verses[r]).join(' '));
  const cite = (group) => refLabel(group) + ' · ' + S.abbreviation;

  // A passage of Scripture with its reference.
  function passage(group, extraClass) {
    return h('figure', { class: 'verse' + (extraClass ? ' ' + extraClass : '') },
      h('blockquote', null, h('p', null, scripture(group))),
      h('figcaption', null, refLinks ? h('a', { href: chapterHref(group[0]) }, cite(group)) : cite(group)));
  }
  // 'MAT 6:9a' -> '#/bible/MAT/6/9': the whole chapter, at that verse.
  function chapterHref(ref) {
    const [book, cv] = ref.split(' ');
    const [ch, v] = cv.split(':');
    return '#/bible/' + book + '/' + ch + '/' + parseInt(v, 10);
  }

  const paragraphs = (list) => list.map((t) => h('p', null, t));
  const ourNote = (text) => text && h('p', { class: 'note' }, h('strong', null, L.app.ourNoteLabel + ': '), text);

  /* ---------- the two ways through the app ---------- */

  // A flow holds one set of steps, the words typed for them, and where its screens live.
  function makeFlow(steps, opts) {
    return Object.assign({
      steps,
      answers: steps.map(() => ''),               // one entry per step, the person's own words
      parts: steps.map((st) => st.guided.map(() => '')), // the words typed under each question
      edited: new Set(),                          // steps changed on the read-through this visit
      borrowed: [],                               // Scripture prayers chosen to pray (Share Jesus)
    }, opts);
  }

  function resetFlow(F) {
    F.answers = F.steps.map(() => '');
    F.parts = F.steps.map((st) => st.guided.map(() => ''));
    F.edited.clear();
    F.borrowed = [];
  }

  // The prayer in order: each answered step, then any Scripture prayer chosen to borrow.
  // Nothing else is added: no opening, no closing, no "Amen".
  function prayerParts(F) {
    const own = F.steps.map((st, i) => ({ name: st.name, text: F.answers[i] })).filter((p) => p.text.trim());
    const lent = F.borrowed.map((r) => ({ name: refLabel([r]), text: scripture([r]), ref: [r] }));
    return own.concat(lent);
  }
  const anyWords = () => prayerParts(PRAY).length > 0 || prayerParts(SHARE).length > 0;
  // Plain text of the prayer, for Copy, Share and Save. Borrowed Scripture keeps its reference.
  const plain = (list) => list.map((p) => (p.ref ? p.text + '\n(' + cite(p.ref) + ')' : p.text)).join('\n\n');

  // Split only where the words already have punctuation (. , ; ? !) or a line break.
  // The words themselves are not changed; only the spaces between phrases are left out.
  function phrases(text) {
    return text.split(/\n+/)
      .flatMap((line) => line.split(/(?<=[.,;?!]["'”’)]*)\s+/))
      .map((s) => s.trim()).filter(Boolean);
  }

  /* ---------- optional draft on this device (Pray by myself only) ---------- */

  // The kept draft (localStorage, only when switched on) comes first; otherwise the words
  // of this visit (sessionStorage), which the browser erases when the tab is closed.
  function loadDraft() {
    const text = (v) => (typeof v === 'string' ? v : '');
    const use = (saved) => {
      PRAY.answers = PRAY.answers.map((_, i) => text(saved.answers[i]));
      PRAY.parts = PRAY.parts.map((list, i) => list.map((_, k) => text(((saved.parts || [])[i] || [])[k])));
    };
    try {
      let saved = JSON.parse(localStorage.getItem(DRAFT_KEY));
      if (Array.isArray(saved)) saved = { answers: saved }; // first version stored a plain list
      if (saved && Array.isArray(saved.answers)) { use(saved); keep = true; return; }
    } catch (e) { /* storage unavailable: carry on without it */ }
    try {
      const visit = JSON.parse(sessionStorage.getItem(VISIT_KEY));
      if (visit && Array.isArray(visit.answers)) use(visit);
    } catch (e) { /* ignore */ }
  }
  function saveDraft() {
    const words = JSON.stringify({ answers: PRAY.answers, parts: PRAY.parts });
    try { sessionStorage.setItem(VISIT_KEY, words); visitKept = true; } catch (e) { visitKept = false; }
    if (!keep) return;
    try { localStorage.setItem(DRAFT_KEY, words); } catch (e) { /* ignore */ }
  }
  function forgetDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* ignore */ }
  }
  function forgetVisit() {
    try { sessionStorage.removeItem(VISIT_KEY); } catch (e) { /* ignore */ }
  }

  function draftSection() {
    const box = h('input', {
      type: 'checkbox', id: 'keep', 'aria-describedby': 'keep-hint', checked: keep,
      onchange: (e) => { keep = e.target.checked; if (keep) saveDraft(); else forgetDraft(); },
    });
    const erase = h('button', {
      type: 'button', class: 'btn danger',
      onclick: () => {
        if (!window.confirm(L.draft.eraseConfirm)) return;
        resetFlow(PRAY);
        forgetDraft();
        forgetVisit();
        flash = L.draft.erased;
        render(true);
      },
    }, L.draft.erase);
    const section = h('section', { class: 'draft', 'aria-labelledby': 'draft-heading' },
      h('h2', { id: 'draft-heading' }, L.draft.heading),
      h('label', { class: 'check', for: 'keep' }, box, h('span', null, L.draft.toggle)),
      h('p', { class: 'hint', id: 'keep-hint' }, L.draft.explain),
      erase,
      h('p', { class: 'status', role: 'status' }, flash));
    flash = '';
    return section;
  }

  /* ---------- screens ---------- */

  // A large button on the welcome screen that starts one of the two ways.
  function choice(href, label, hint, extraClass, onclick) {
    return h('a', { class: 'btn choice ' + extraClass, href, onclick },
      h('strong', null, label), h('span', null, hint));
  }

  // Tapping Begin fixes "today" for this prayer, so the passages offered
  // do not change if the prayer runs past midnight.
  const today = () => Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / 86400000);
  const fixDay = () => { prayerDay = today(); };
  function beginLink(href, label) {
    return h('a', { class: 'btn primary grow', href, onclick: fixDay }, label);
  }

  function welcomeView() {
    const w = L.welcome;
    return {
      nodes: [
        h('h1', null, w.heading),
        w.verses.map((r) => passage([r])),
        paragraphs(w.body),
        h('h2', null, w.choose),
        h('div', { class: 'choices' },
          choice('#/guide', w.byMyself, w.byMyselfHint, 'primary', fixDay),
          choice('#/share', L.share.name, w.shareHint, '')),
        h('p', null, h('a', { href: '#/why' }, w.whyLink)),
        h('h2', null, w.studyHeading),
        h('div', { class: 'choices' }, choice('#/bible', w.study, w.studyHint, '')),
        draftSection(),
      ],
    };
  }

  function whyView() {
    return {
      title: L.why.heading,
      nodes: [
        h('h1', null, L.why.heading),
        L.why.sections.map((s) => [h('h2', null, s.heading), passage(s.verses)]),
        h('div', { class: 'actions nav' },
          h('a', { class: 'btn', href: '#/' }, L.nav.back),
          h('a', { class: 'btn primary grow', href: '#/guide' }, L.nav.start)),
      ],
    };
  }

  // Which entries of a step's pool to show today. Chosen from the date alone,
  // so nothing about the person needs to be stored. The day is the one fixed at
  // Begin, or today if a step was opened directly.
  function todaysPassages(pool) {
    const perDay = Math.min(L.step.perDay, (pool || []).length);
    if (!perDay) return [[], []];
    const day = prayerDay == null ? today() : prayerDay;
    const start = (day * perDay) % pool.length;
    const picks = [];
    const rest = [];
    pool.forEach((g, j) => (((j - start + pool.length) % pool.length) < perDay ? picks : rest).push(g));
    return [picks, rest];
  }

  const progressText = (F, n) => L.step.progress.replace('{n}', n).replace('{total}', F.steps.length);
  // Where the person is: a bar of the steps, which opens to show the names of all of them.
  const stepMap = (F, i, progress) => h('details', { class: 'map' },
    h('summary', null,
      h('span', { class: 'progress' }, progress),
      h('span', { class: 'dots', 'aria-hidden': 'true' }, F.steps.map((_, j) => h('span', { class: j <= i ? 'done' : '' })))),
    h('ol', { class: 'names' }, F.steps.map((st, j) => h('li', { 'aria-current': j === i ? 'step' : null }, st.name))));
  // Each step keeps the words of its short questions; the step's words are those
  // joined with a space, so the step reads as one paragraph. Nothing is added to them.
  const joined = (F, i) => F.parts[i].filter((t) => t.trim()).join(' ');

  // "Pray by myself": a short start screen with the words of Jesus about praying simply.
  function guideIntroView() {
    const g = L.guide;
    return {
      title: g.introHeading,
      nodes: [
        h('h1', null, g.introHeading),
        passage(g.introVerses),
        paragraphs(g.intro),
        h('div', { class: 'actions nav' },
          h('a', { class: 'btn', href: '#/' }, L.nav.back),
          beginLink(PRAY.q(1, 1), g.begin)),
      ],
    };
  }

  // One short question on the screen at a time. Used by both ways through the app.
  function guideView(F, i, k) {
    const g = L.guide;
    const step = F.steps[i];
    const item = step.guided[k];
    const count = step.guided.length;
    const n = i + 1;
    const progress = progressText(F, n) + (count > 1 ? g.questionOf.replace('{k}', k + 1).replace('{count}', count) : '');
    const last = n === F.steps.length && k === count - 1;

    // If the words were changed on the read-through screen, keep them all: put them under the first question.
    if (joined(F, i) !== F.answers[i]) F.parts[i] = F.parts[i].map((_, q) => (q ? '' : F.answers[i]));
    const editedNote = F.edited.has(i) && count > 1 && h('p', { class: 'note' }, k ? g.editedFirst : g.editedHere);

    const nextHref = k + 1 < count ? F.q(n, k + 2) : last ? F.review : F.q(n + 1, 1);
    const backHref = k > 0 ? F.q(n, k) : i > 0 ? F.q(i, F.steps[i - 1].guided.length) : F.first;
    const nextLabel = () => (last ? F.toReview : F.parts[i][k].trim() ? L.nav.next : L.nav.skipQuestion);
    const next = h('a', { class: 'btn primary grow', href: nextHref }, nextLabel());

    // The box always starts with the person's own words or nothing at all.
    // Spell-check is off so that no browser service is sent what is typed.
    const update = () => {
      F.parts[i][k] = box.value; F.answers[i] = joined(F, i); F.edited.delete(i);
      next.textContent = nextLabel(); F.save();
    };
    const box = h('textarea', {
      id: 'words', class: 'short', rows: '4', autocomplete: 'off', spellcheck: 'false',
      'aria-describedby': 'words-hint', oninput: update,
    });
    box.value = F.parts[i][k];

    // Prompts are for reflection only. Nothing is ever put in the box for the person.
    const cues = item.cues && h('div', { class: 'cues' },
      h('p', { id: 'cues-label' }, F.cuesLabel + ':'),
      h('ul', { 'aria-labelledby': 'cues-label' }, item.cues.map((cue) => h('li', null, cue))));
    const [picks, rest] = todaysPassages(step.related);

    return {
      title: progress + ': ' + step.name,
      nodes: [
        stepMap(F, i, progress),
        h('h1', null, step.name),
        step.verses.map((v) => passage(v, 'main')),
        ourNote(step.note),
        h('div', { class: 'ask' },
          h('label', { for: 'words' }, item.q),
          item.example && [h('h2', { class: 'small' }, g.exampleHeading), passage(item.example)],
          cues,
          editedNote,
          box,
          h('p', { class: 'hint', id: 'words-hint' }, F.hint)),
        F.needHelp && h('p', null, h('a', { href: F.needHelp }, L.share.needHelp)),
        h('div', { class: 'actions nav' },
          h('a', { class: 'btn', href: backHref }, L.nav.back),
          next),
        picks.length > 0 && h('details', null, h('summary', null, L.step.relatedHeading), picks.map((v) => passage(v))),
        rest.length > 0 && h('details', null, h('summary', null, L.step.moreLink), rest.map((v) => passage(v))),
      ],
    };
  }

  // The whole prayer in one place, one box per step, to read through and make one's own before praying it.
  function reviewView(F) {
    const s = F.reviewText;
    const filled = F.steps.map((st, i) => ({ st, i })).filter(({ i }) => F.answers[i].trim());
    const backHref = F.q(F.steps.length, F.steps[F.steps.length - 1].guided.length);
    if (!filled.length && !F.borrowed.length) {
      if (!F.needHelp) return prayerView(F);
      // A prayer with no words cannot be prayed: offer the prayers from Scripture.
      return {
        title: s.heading,
        nodes: [
          h('h1', null, s.heading),
          h('p', { class: 'standout' }, s.empty),
          h('div', { class: 'actions nav' },
            h('a', { class: 'btn', href: backHref }, L.nav.back),
            h('a', { class: 'btn primary grow', href: F.needHelp }, s.toBorrow)),
        ],
      };
    }
    return {
      title: s.heading,
      nodes: [
        h('h1', null, s.heading),
        h('p', { class: 'standout', id: 'review-hint' }, s.hint),
        s.lineHint && h('p', { class: 'hint' }, s.lineHint),
        filled.map(({ st, i }) => {
          const id = 'review-' + (i + 1);
          // Spell-check is off so that no browser service is sent what is typed.
          const box = h('textarea', {
            id, rows: '4', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'review-hint',
            oninput: (e) => { F.answers[i] = e.target.value; F.edited.add(i); F.save(); },
          });
          box.value = F.answers[i];
          return h('div', { class: 'ask' }, h('label', { for: id }, st.name), box);
        }),
        // Scripture chosen to borrow is shown as it is, with its reference. It is not edited.
        F.borrowed.length > 0 && [
          h('h2', null, s.borrowedHeading),
          F.borrowed.map((r) => h('div', { class: 'borrowed' },
            passage([r]),
            h('button', {
              type: 'button', class: 'btn',
              onclick: () => { F.borrowed = F.borrowed.filter((x) => x !== r); render(true); },
            }, s.remove + ': ' + refLabel([r])))),
        ],
        h('div', { class: 'actions nav' },
          h('a', { class: 'btn', href: backHref }, L.nav.back),
          h('a', { class: 'btn primary grow', href: F.walk + '1' }, s.toWalk)),
      ],
    };
  }

  // Praying out loud. Pray by myself: one part at a time. Share Jesus: one phrase at a time,
  // for the leader to read and the other person to repeat.
  function prayWalkView(F, n) {
    const g = L.guide;
    const units = F.perPhrase
      ? prayerParts(F).flatMap((p) => phrases(p.text).map((t) => ({ name: p.name, text: t, ref: p.ref })))
      : prayerParts(F);
    if (!units.length) return F.perPhrase ? reviewView(F) : prayerView(F);
    const idx = Math.min(Math.max(n, 1), units.length) - 1;
    const u = units[idx];
    const lastPart = idx === units.length - 1;
    const progress = (F.perPhrase ? L.share.walk.progress : g.partOf).replace('{n}', idx + 1).replace('{total}', units.length);
    return {
      title: progress + ': ' + u.name,
      nodes: [
        h('p', { class: 'progress' }, progress + ' · ' + u.name),
        h('h1', { class: F.perPhrase ? 'visually-hidden' : null }, F.perPhrase ? progress : g.sayThis),
        h('div', { class: F.perPhrase ? 'aloud phrase' : 'aloud' }, h('p', null, u.text),
          u.ref && h('p', { class: 'cite' }, cite(u.ref))),
        F.perPhrase && h('p', { class: 'leader-line' }, L.share.walk.leaderLine),
        h('div', { class: 'actions nav' },
          h('a', { class: 'btn', href: idx > 0 ? F.walk + idx : F.review }, L.nav.back),
          h('a', { class: 'btn primary grow', href: lastPart ? F.prayer : F.walk + (idx + 2) },
            lastPart ? F.finish : L.nav.next)),
      ],
    };
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall back below */ }
    const t = h('textarea', { class: 'offscreen', readonly: true });
    t.value = text;
    document.body.append(t);
    t.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ }
    t.remove();
    return ok;
  }

  // Save the prayer as a dated text file. The file is made in the browser; nothing is sent anywhere.
  function saveFile(text) {
    const d = new Date();
    const two = (n) => String(n).padStart(2, '0');
    const name = L.prayer.fileName + '-' + d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + '.txt';
    const url = URL.createObjectURL(new Blob([text.replace(/\r?\n/g, '\r\n')], { type: 'text/plain;charset=utf-8' }));
    const link = h('a', { href: url, download: name, class: 'offscreen' });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function prayerView(F) {
    const list = prayerParts(F);
    const nodes = [h('h1', null, F.prayerText.heading)];
    if (!list.length) {
      nodes.push(h('p', null, L.prayer.empty),
        h('div', { class: 'actions' }, h('a', { class: 'btn primary', href: F.first }, L.guide.begin)));
    } else {
      const status = h('p', { class: 'status', role: 'status' });
      const text = plain(list);
      nodes.push(
        h('p', { class: 'no-print' }, F.prayerText.intro),
        // Only the person's own words, exactly as typed, in order, and any Scripture they chose.
        h('div', { class: 'prayer' }, list.map((p) => [h('p', null, p.text), p.ref && h('p', { class: 'cite' }, cite(p.ref))])),
        h('div', { class: 'actions' },
          h('button', {
            type: 'button', class: 'btn primary',
            onclick: async () => { status.textContent = (await copyText(text)) ? L.prayer.copied : L.prayer.copyFailed; },
          }, L.prayer.copy),
          // Share opens the device's own share sheet; the person chooses where the words go.
          navigator.share && h('button', {
            type: 'button', class: 'btn',
            onclick: () => { navigator.share({ text }).catch(() => {}); },
          }, L.prayer.share),
          h('button', {
            type: 'button', class: 'btn',
            onclick: () => { saveFile(text); status.textContent = L.prayer.saved; },
          }, L.prayer.save),
          h('button', { type: 'button', class: 'btn', onclick: () => window.print() }, L.prayer.print),
          F === PRAY && h('a', { class: 'btn', href: '#/aloud' }, L.prayer.aloud),
          h('a', { class: 'btn', href: F.review }, L.prayer.edit)),
        status,
        F === SHARE && h('div', { class: 'actions' }, h('a', { class: 'btn primary grow', href: '#/share/after' }, L.share.prayer.next)));
    }
    if (F === PRAY) nodes.push(draftSection());
    return { title: F.prayerText.heading, nodes };
  }

  function aloudView() {
    const list = prayerParts(PRAY);
    if (!list.length) return prayerView(PRAY);
    return {
      title: L.prayer.aloudHeading,
      nodes: [
        h('h1', { class: 'progress' }, L.prayer.aloudHeading),
        h('div', { class: 'aloud' }, paragraphs(list.map((p) => p.text))),
        h('div', { class: 'actions' }, h('a', { class: 'btn primary', href: '#/prayer' }, L.prayer.aloudClose)),
      ],
    };
  }

  /* ---------- Share Jesus: the screens that are not questions ---------- */

  // Leaving Share Jesus forgets what was typed, so the next person starts with nothing.
  const homeLink = (label) => h('a', { class: 'btn primary grow', href: '#/', onclick: () => resetFlow(SHARE) }, label);

  // Screen 1, for the leader. Starting here always begins with empty boxes.
  function shareStartView() {
    const s = L.share.start;
    return {
      title: s.name + ' | ' + L.share.name,
      nodes: [
        h('p', { class: 'progress' }, L.share.name),
        h('h1', null, s.name),
        s.verses.map((v) => passage(v)),
        ourNote(s.note),
        h('div', { class: 'ask' }, h('p', { class: 'small-label' }, s.askLabel + ':'), h('p', { class: 'say-aloud' }, s.ask)),
        h('div', { class: 'actions nav' },
          h('a', { class: 'btn', href: '#/' }, L.nav.back),
          h('a', { class: 'btn primary grow', href: '#/share/cost', onclick: () => resetFlow(SHARE) }, s.next)),
      ],
    };
  }

  // Screen 2, read together. Nothing said here is typed or put in the prayer.
  function shareCostView() {
    const s = L.share.cost;
    return {
      title: s.name + ' | ' + L.share.name,
      nodes: [
        h('p', { class: 'progress' }, L.share.name),
        h('h1', null, s.name),
        h('p', null, s.intro),
        s.verses.map((v) => passage(v)),
        ourNote(s.extraNote),
        s.extraVerses.map((v) => passage(v)),
        h('div', { class: 'ask' }, h('p', { class: 'small-label' }, L.share.start.askLabel + ':'), h('p', { class: 'say-aloud' }, s.ask)),
        h('div', { class: 'actions nav' },
          h('a', { class: 'btn', href: '#/share/not-today' }, s.no),
          h('a', { class: 'btn primary grow', href: SHARE.q(1, 1) }, s.yes)),
      ],
    };
  }

  function shareNotTodayView() {
    const s = L.share.notToday;
    resetFlow(SHARE);
    return {
      title: s.heading,
      nodes: [
        h('h1', null, s.heading),
        ourNote(s.note),
        h('div', { class: 'actions' }, homeLink(s.home)),
      ],
    };
  }

  // Screen 7: prayers from Scripture, for someone who cannot find words.
  function shareBorrowView() {
    const s = L.share.borrow;
    return {
      title: s.name + ' | ' + L.share.name,
      nodes: [
        h('p', { class: 'progress' }, L.share.name),
        h('h1', null, s.name),
        ourNote(s.note),
        s.prayers.map((r, j) => {
          const id = 'use-' + (j + 1);
          const box = h('input', {
            type: 'checkbox', id, checked: SHARE.borrowed.includes(r),
            onchange: (e) => {
              // Keep the order they are listed in, whatever order they are ticked.
              const on = new Set(SHARE.borrowed.filter((x) => x !== r));
              if (e.target.checked) on.add(r);
              SHARE.borrowed = s.prayers.filter((x) => on.has(x));
            },
          });
          return h('div', { class: 'borrowed' }, passage([r]),
            h('label', { class: 'check', for: id }, box, h('span', null, s.use + ': ' + refLabel([r]))));
        }),
        h('div', { class: 'actions nav' },
          h('button', { type: 'button', class: 'btn', onclick: () => history.back() }, L.nav.back),
          h('a', { class: 'btn primary grow', href: SHARE.review }, s.done)),
      ],
    };
  }

  // After the prayer: Scripture's assurance and honest warning, and next steps.
  // Nothing here says what the person's standing is. The Scripture is shown and left there.
  function shareAfterView() {
    const s = L.share.after;
    return {
      title: s.heading,
      nodes: [
        h('h1', null, s.heading),
        s.sections.map((sec) => [h('h2', null, sec.heading), sec.verses.map((v) => passage(v)), ourNote(sec.note)]),
        h('h2', null, s.nextHeading),
        h('ol', { class: 'next-steps' }, s.next.map((item) =>
          h('li', null, h('p', null, h('strong', null, item.link ? h('a', { href: '#/bible/' + item.link }, item.text) : item.text)),
            item.verses.map((v) => passage(v))))),
        ourNote(s.leaderNote),
        h('div', { class: 'actions' }, homeLink(s.home)),
      ],
    };
  }

  function aboutView() {
    const a = L.about;
    return {
      title: a.heading,
      nodes: [
        h('h1', null, a.heading),
        h('h2', null, a.whoHeading), paragraphs(a.who),
        h('h2', null, a.howHeading), paragraphs(a.how),
        h('h2', null, a.privacyHeading), paragraphs(a.privacy),
        h('h2', null, a.sourcesHeading), paragraphs(a.sources),
        h('h2', null, a.doxologyHeading), h('p', null, a.doxology),
        h('h2', null, a.licenseHeading), h('p', null, a.license),
        a.sourceCodeUrl && h('p', null, h('a', { href: a.sourceCodeUrl, rel: 'noopener noreferrer' }, a.sourceCodeLabel)),
        h('div', { class: 'actions' }, h('a', { class: 'btn', href: '#/' }, L.nav.back)),
      ],
    };
  }

  /* ---------- Bible study ---------- */

  // Books live in bible/<CODE>.json, made from the WEB files by tools/build_bible.py.
  // A book is kept on the device (Cache Storage) the first time it is opened.
  const B = () => L.bible;
  const bookInfo = (code) => IDX.books.find((b) => b.code === code);
  // "John 3", "Psalm 23": the source gives Psalms its own word for one chapter.
  const chapterTitle = (info, ch) => (info.chapterName || info.name) + ' ' + ch;
  const bibleCacheName = () => 'teach-us-to-pray-bible-' + IDX.version;
  const fill = (text, values) => Object.entries(values).reduce((t, [k, v]) => t.split('{' + k + '}').join(v), text);
  const mb = (bytes) => (bytes / 1e6).toFixed(1);
  const sizes = () => ({
    download: mb(IDX.books.reduce((n, b) => n + b.download, 0)),
    stored: mb(IDX.books.reduce((n, b) => n + b.size, 0)),
  });
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  };

  // Opening a cache creates it, so only open it to store something; to read, ask without opening.
  async function openCache() {
    try { return window.caches ? await caches.open(bibleCacheName()) : null; } catch (e) { return null; }
  }
  async function keptHere(url) {
    try { return window.caches && await caches.has(bibleCacheName()) ? await caches.match(url, { cacheName: bibleCacheName() }) : null; } catch (e) { return null; }
  }

  // Open a book: from this device if it is kept here, otherwise download it and keep it.
  async function getBook(code) {
    if (BOOKS.has(code)) return BOOKS.get(code);
    const url = 'bible/' + code + '.json';
    let res = await keptHere(url);
    let saved = !!res;
    if (!res) {
      res = await fetch(url);
      if (!res.ok) throw new Error('not found');
      const cache = await openCache();
      if (cache) { try { await cache.put(url, res.clone()); saved = true; } catch (e) { /* storage full */ } }
    }
    const book = await res.json();
    book.saved = saved;
    BOOKS.set(code, book);
    return book;
  }

  async function savedCount() {
    try { if (!window.caches || !(await caches.has(bibleCacheName()))) return 0; } catch (e) { return 0; }
    const cache = await openCache();
    if (!cache) return 0;
    const files = new Set((await cache.keys()).map((r) => r.url.split('/').pop()));
    return IDX.books.filter((b) => files.has(b.code + '.json')).length;
  }

  // "Keep the whole Bible on this device": download every book not yet kept here.
  async function keepWholeBible(status) {
    if (downloading) return false;
    downloading = true;
    const cache = await openCache();
    let ok = !!cache;
    try {
      const have = new Set((await cache.keys()).map((r) => r.url.split('/').pop()));
      let n = 0;
      for (const b of IDX.books) {
        const url = 'bible/' + b.code + '.json';
        if (!have.has(b.code + '.json')) {
          const res = await fetch(url);
          if (!res.ok) throw new Error('download');
          await cache.put(url, res);
        }
        n += 1;
        status.textContent = fill(B().downloading, { n, total: IDX.books.length });
      }
      BOOKS.forEach((book) => { book.saved = true; });
      try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* ignore */ }
      status.textContent = B().allHere;
    } catch (e) {
      ok = false;
      status.textContent = B().stopped;
    }
    downloading = false;
    return ok;
  }

  // The offline section of the Bible study screen. It fills in once it knows what is kept here.
  function offlineSection(after) {
    const status = h('p', { class: 'status', role: 'status' });
    const body = h('div');
    const section = h('section', { class: 'offline-section', 'aria-labelledby': 'offline-heading' },
      h('h2', { id: 'offline-heading' }, B().offlineHeading),
      h('p', null, B().offlineText), body, status);
    if (!window.caches) return section;
    savedCount().then((n) => {
      if (n >= IDX.books.length) {
        body.replaceChildren(
          h('p', { class: 'saved-line' }, B().allHere),
          h('button', {
            type: 'button', class: 'btn danger',
            onclick: async () => { await caches.delete(bibleCacheName()); BOOKS.clear(); render(false); },
          }, B().remove),
          h('p', { class: 'hint' }, B().removeHint));
      } else {
        const keepBtn = h('button', {
          type: 'button', class: 'btn primary',
          onclick: async () => { keepBtn.disabled = true; if (await keepWholeBible(status)) { if (after) after(); else render(false); } else keepBtn.disabled = false; },
        }, B().keepAll);
        body.replaceChildren(keepBtn, h('p', { class: 'hint' }, fill(B().keepAllSize, sizes())));
      }
    });
    return section;
  }

  // "John 3:16", "Ps 23", "1 John 1:9", "Psalm 151", "Romans" -> { code, ch, v }
  function findPassage(query) {
    const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]/g, '');
    const findBook = (name) => {
      const q = norm(name);
      if (!q) return null;
      return IDX.books.find((b) => norm(b.name) === q) || IDX.books.find((b) => norm(b.code) === q)
        || IDX.books.find((b) => norm(b.name).startsWith(q)) || null;
    };
    const m = query.trim().match(/^(.+?)\s*(\d+)(?:\s*[:.]\s*(\d+))?\s*$/);
    if (m) {
      const book = findBook(m[1]);
      const ch = parseInt(m[2], 10);
      // A chapter the book does not have opens the book's list of chapters.
      if (book && ch >= 1 && ch <= book.chapters) return { code: book.code, ch, v: m[3] ? parseInt(m[3], 10) : null };
      if (book && !findBook(query)) return { code: book.code, ch: null, v: null };
    }
    const whole = findBook(query);
    return whole ? { code: whole.code, ch: null, v: null } : null;
  }
  const passageHref = (p) => '#/bible/' + p.code + (p.ch ? '/' + p.ch + (p.v ? '/' + p.v : '') : '');

  function searchForm(q, shelf) {
    const input = h('input', { type: 'search', id: 'bible-q', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search' });
    input.value = q || '';
    const select = h('select', { id: 'bible-shelf' },
      h('option', { value: 'all' }, B().allBooks),
      Object.entries(B().shelves).map(([k, name]) => h('option', { value: k }, name)));
    select.value = shelf || 'all';
    return h('form', {
      class: 'bible-form', role: 'search',
      onsubmit: (e) => {
        e.preventDefault();
        if (input.value.trim()) location.hash = '#/bible/search/' + encodeURIComponent(input.value.trim()) + '/' + select.value;
      },
    },
    h('label', { for: 'bible-q' }, B().searchLabel), input,
    h('label', { for: 'bible-shelf', class: 'small-label' }, B().searchIn), select,
    h('button', { type: 'submit', class: 'btn' }, B().search));
  }

  function bibleHomeView() {
    const place = store.get(PLACE_KEY);
    const [pCode, pCh] = (place || '').split('/');
    const placeBook = pCode && bookInfo(pCode);
    const goInput = h('input', { type: 'text', id: 'bible-go', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'bible-go-hint', enterkeyhint: 'go' });
    const goStatus = h('p', { class: 'status', role: 'status' });
    return {
      title: B().heading,
      nodes: [
        h('h1', null, B().heading),
        placeBook && h('p', null, h('a', { class: 'btn primary', href: '#/bible/' + pCode + '/' + pCh },
          fill(B().continue, { ref: chapterTitle(placeBook, pCh) }))),
        h('form', {
          class: 'bible-form',
          onsubmit: (e) => {
            e.preventDefault();
            const found = findPassage(goInput.value);
            if (found) location.hash = passageHref(found);
            else goStatus.textContent = B().notFound;
          },
        },
        h('label', { for: 'bible-go' }, B().goLabel), goInput,
        h('p', { class: 'hint', id: 'bible-go-hint' }, B().goHint),
        h('button', { type: 'submit', class: 'btn' }, B().go), goStatus),
        searchForm('', 'all'),
        Object.entries(B().shelves).map(([shelf, name]) => h('section', { class: 'shelf-section', 'aria-labelledby': 'shelf-' + shelf },
          h('h2', { id: 'shelf-' + shelf }, name),
          shelf === 'ap' && [h('p', { class: 'hint' }, B().apLine), h('p', { class: 'hint' }, B().greekLine)],
          h('ul', { class: 'book-list' }, IDX.books.filter((b) => b.shelf === shelf).map((b) =>
            h('li', null, h('a', { href: '#/bible/' + b.code }, b.name)))))),
        offlineSection(),
      ],
    };
  }

  function bookView(info) {
    if (info.chapters === 1) return chapterView(info, 1, null);
    return {
      title: info.name,
      nodes: [
        h('p', { class: 'shelf' }, B().shelves[info.shelf]),
        h('h1', null, info.name),
        h('h2', null, B().chapters),
        h('ul', { class: 'chapter-grid' }, Array.from({ length: info.chapters }, (_, i) =>
          h('li', null, h('a', { href: '#/bible/' + info.code + '/' + (i + 1), 'aria-label': fill(B().chapterLabel, { n: i + 1 }) }, String(i + 1))))),
        h('div', { class: 'actions nav' }, h('a', { class: 'btn', href: '#/bible' }, B().books)),
      ],
    };
  }

  // The chapter before or after, across books, in shelf order.
  function neighbour(info, ch, step) {
    const i = IDX.books.indexOf(info);
    if (ch + step >= 1 && ch + step <= info.chapters) return { info, ch: ch + step };
    const other = IDX.books[i + step];
    return other ? { info: other, ch: step > 0 ? 1 : other.chapters } : null;
  }

  // A small numbered button for a translators' note. The note opens just below its paragraph.
  function noteButton(n, ref, text, para) {
    const btn = h('button', {
      type: 'button', class: 'fn', 'aria-expanded': 'false', 'aria-label': fill(B().noteMarker, { n }),
      onclick: () => {
        const open = main.querySelector('aside.tnote');
        const wasMine = open && open.dataset.n === String(n);
        if (open) { open.remove(); main.querySelectorAll('.fn[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false')); }
        if (wasMine) return;
        const close = h('button', { type: 'button', class: 'btn small', onclick: () => { aside.remove(); btn.setAttribute('aria-expanded', 'false'); btn.focus(); } }, B().close);
        const aside = h('aside', { class: 'tnote', 'data-n': String(n) },
          h('p', { class: 'tnote-label' }, fill(B().noteHeading, { ref })),
          h('p', null, text), close);
        para.after(aside);
        btn.setAttribute('aria-expanded', 'true');
        close.focus();
      },
    }, String(n));
    return btn;
  }

  const HEADING_KINDS = new Set(['d', 's', 's1', 's2', 'ms', 'ms1', 'ms2', 'mr', 'sp', 'is', 'is1']);

  function chapterText(book, chapter) {
    const showNotes = store.get(HIDE_NOTES_KEY) !== '1';
    const wrap = h('div', { class: 'text' });
    let n = 0;
    let verse = null;
    for (const [kind, ...tokens] of chapter.b) {
      if (kind === 'b') { wrap.append(h('div', { class: 'gap', 'aria-hidden': 'true' })); continue; }
      const para = h('p', { class: 'k-' + kind + (HEADING_KINDS.has(kind) ? ' heading' : '') });
      for (const t of tokens) {
        if (typeof t === 'string') para.append(t);
        else if (typeof t === 'number' || t.v) {
          verse = typeof t === 'number' ? t : t.v;
          para.append(h('sup', { class: 'vn', id: 'v' + String(verse).split('-')[0] }, String(verse)));
        } else if (t.f != null && showNotes) {
          n += 1;
          para.append(noteButton(n, chapterTitle(bookInfo(book.code), chapter.n) + (verse ? ':' + verse : ''), t.f, para));
        }
      }
      wrap.append(para);
    }
    return wrap;
  }

  function chapterView(info, ch, verse) {
    const ready = BOOKS.get(info.code);
    const build = (book) => {
      const chapter = book.chapters[ch - 1];
      if (!chapter) return null;
      store.set(PLACE_KEY, info.code + '/' + ch);
      const status = h('p', { class: 'status', role: 'status' });
      const prev = neighbour(info, ch, -1);
      const next = neighbour(info, ch, 1);
      const link = (x) => x && h('a', { class: 'btn' + (x === next ? ' primary grow' : ''), href: '#/bible/' + x.info.code + '/' + x.ch }, chapterTitle(x.info, x.ch));
      const notesBox = h('input', {
        type: 'checkbox', id: 'show-notes', 'aria-describedby': 'show-notes-hint', checked: store.get(HIDE_NOTES_KEY) !== '1',
        onchange: (e) => { store.set(HIDE_NOTES_KEY, e.target.checked ? null : '1'); render(false); },
      });
      return {
        title: chapterTitle(info, ch),
        verse,
        nodes: [
          h('p', { class: 'shelf' }, B().shelves[info.shelf]),
          h('h1', null, chapterTitle(info, ch)),
          book.saved && h('p', { class: 'saved-line' }, B().saved),
          chapterText(book, chapter),
          h('div', { class: 'actions' },
            h('a', { class: 'btn', href: '#/bible' }, B().books),
            info.chapters > 1 && h('a', { class: 'btn', href: '#/bible/' + info.code }, B().chapters),
            h('button', {
              type: 'button', class: 'btn',
              onclick: async () => { status.textContent = (await copyText(location.href)) ? B().linkCopied : L.prayer.copyFailed; },
            }, B().copyLink)),
          status,
          h('div', { class: 'reader-settings' },
            h('label', { class: 'check', for: 'show-notes' }, notesBox, h('span', null, B().showNotes)),
            h('p', { class: 'hint', id: 'show-notes-hint' }, B().showNotesHint)),
          h('div', { class: 'actions nav' }, link(prev), link(next)),
        ],
      };
    };
    if (ready) return build(ready);
    const later = getBook(info.code).then(build, () => ({
      title: info.name,
      nodes: [
        h('p', { class: 'shelf' }, B().shelves[info.shelf]),
        h('h1', null, chapterTitle(info, ch)),
        h('p', { class: 'standout' }, fill(B().notHere, { book: info.name })),
        h('div', { class: 'actions nav' }, h('a', { class: 'btn', href: '#/bible' }, B().books)),
      ],
    }));
    later.loading = { title: info.name, nodes: [h('p', { class: 'status', role: 'status' }, fill(B().opening, { book: info.name }))] };
    return later;
  }

  // Every verse of a book as plain text, for searching. Headings and notes are left out.
  function versesOf(book) {
    if (book.verses) return book.verses;
    const out = [];
    for (const chapter of book.chapters) {
      let cur = null;
      for (const [kind, ...tokens] of chapter.b) {
        if (HEADING_KINDS.has(kind)) continue;
        for (const t of tokens) {
          if (typeof t === 'number' || (t && t.v)) { cur = { ch: chapter.n, v: typeof t === 'number' ? t : t.v, text: '' }; out.push(cur); }
          else if (typeof t === 'string' && cur) cur.text += t;
        }
        if (cur) cur.text += ' ';
      }
    }
    out.forEach((x) => { x.text = x.text.replace(/\s+/g, ' ').trim(); });
    book.verses = out;
    return out;
  }

  function searchView(query, shelf) {
    const q = decodeURIComponent(query || '');
    const books = IDX.books.filter((b) => shelf === 'all' || !B().shelves[shelf] || b.shelf === shelf);
    const head = [h('h1', null, B().searchLabel), searchForm(q, shelf)];
    const words = q.toLowerCase().replace(/’/g, "'").split(/\s+/).filter(Boolean);
    const run = async () => {
      if (window.caches && (await savedCount()) < IDX.books.length) {
        return {
          title: B().searchLabel,
          nodes: [head, h('p', { class: 'standout' }, fill(B().needAll, sizes())), offlineSection(() => render(false))],
        };
      }
      const found = [];
      for (const info of books) {
        const book = await getBook(info.code);
        for (const x of versesOf(book)) {
          const t = x.text.toLowerCase().replace(/’/g, "'");
          if (words.every((w) => t.includes(w))) found.push({ info, x });
        }
      }
      const shown = found.slice(0, 200);
      const pattern = new RegExp('(' + words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['’]")).join('|') + ')', 'gi');
      const marked = (text) => text.split(pattern).map((part, i) => (i % 2 ? h('mark', null, part) : part));
      return {
        title: B().searchLabel,
        nodes: [
          head,
          h('p', { class: 'standout', role: 'status' }, found.length
            ? fill(found.length === 1 ? B().foundOne : B().found, { n: found.length, q })
            : fill(B().none, { q })),
          found.length > 200 && h('p', { class: 'hint' }, B().first200),
          h('ol', { class: 'results' }, shown.map(({ info, x }) => h('li', null,
            h('a', { href: '#/bible/' + info.code + '/' + x.ch + '/' + String(x.v).split('-')[0] }, chapterTitle(info, x.ch) + ':' + x.v),
            h('p', null, marked(x.text))))),
        ],
      };
    };
    if (!words.length) return { title: B().searchLabel, nodes: head };
    const later = run().catch(() => ({ title: B().searchLabel, nodes: [head, h('p', { class: 'standout' }, B().stopped)] }));
    later.loading = { title: B().searchLabel, nodes: head };
    return later;
  }

  function bibleView(a, b, c) {
    if (a === 'search') return searchView(b, c || 'all');
    const info = a && bookInfo(a);
    if (!info) return bibleHomeView();
    const ch = parseInt(b, 10);
    if (!ch) return bookView(info);
    if (ch < 1 || ch > info.chapters) return bookView(info);
    return chapterView(info, ch, parseInt(c, 10) || null);
  }

  /* ---------- router ---------- */

  function questionView(F, a, b) {
    const i = parseInt(a, 10) - 1;
    if (!F.steps[i]) return null;
    const count = F.steps[i].guided.length;
    return guideView(F, i, Math.min(Math.max(parseInt(b, 10) || 1, 1), count) - 1);
  }

  function shareView(sub, a) {
    if (sub === 'cost') return shareCostView();
    if (sub === 'not-today') return shareNotTodayView();
    if (sub === 'q') return questionView(SHARE, a, 1);
    if (sub === 'borrow') return shareBorrowView();
    if (sub === 'review') return reviewView(SHARE);
    if (sub === 'pray') return prayWalkView(SHARE, parseInt(a, 10) || 1);
    if (sub === 'prayer') return prayerView(SHARE);
    if (sub === 'after') return shareAfterView();
    return shareStartView();
  }

  let renderToken = 0;
  function render(moveFocus) {
    const token = ++renderToken;
    const [name, arg, arg2, arg3] = location.hash.replace(/^#\/?/, '').split('/');
    // References link to their chapter everywhere except while leading someone in Share Jesus.
    refLinks = name !== 'share';
    let view = null;
    if (name === 'step') view = questionView(PRAY, arg, arg2);
    else if (name === 'share') view = shareView(arg, arg2);
    else if (name === 'guide') view = guideIntroView();
    else if (name === 'review') view = reviewView(PRAY);
    else if (name === 'pray') view = prayWalkView(PRAY, parseInt(arg, 10) || 1);
    else if (name === 'prayer') view = prayerView(PRAY);
    else if (name === 'aloud') view = aloudView();
    else if (name === 'about') view = aboutView();
    else if (name === 'why') view = whyView();
    else if (name === 'bible') view = bibleView(arg, arg2, arg3);
    if (!view) view = welcomeView();

    // Share Jesus is held between two people, so its text is larger.
    document.body.classList.toggle('together', name === 'share');
    document.body.classList.toggle('reading', name === 'bible');
    // A book that is not open yet: show "Opening…" until it is ready.
    if (typeof view.then === 'function') {
      show(view.loading, moveFocus);
      view.then((ready) => { if (token === renderToken) show(ready, moveFocus); });
      return;
    }
    show(view, moveFocus);
  }

  function show(view, moveFocus) {
    main.replaceChildren(...[view.nodes].flat(Infinity).filter(Boolean));
    document.title = view.title ? view.title + ' | ' + L.app.name : L.app.name;
    const target = view.verse && document.getElementById('v' + view.verse);
    if (moveFocus) {
      const heading = main.querySelector('h1');
      if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
      window.scrollTo(0, 0);
    }
    if (target) {
      target.classList.add('hit');
      target.scrollIntoView({ block: 'center' });
    }
  }

  async function start() {
    const wanted = (navigator.languages || [navigator.language || '']).map((l) => l.slice(0, 2).toLowerCase());
    const lang = wanted.find((l) => LANGS.includes(l)) || LANGS[0];
    L = await (await fetch('lang/' + lang + '.json')).json();
    S = await (await fetch(L.meta.scriptureFile)).json();
    IDX = await (await fetch('bible/index.json')).json();

    document.documentElement.lang = L.meta.lang;
    document.documentElement.dir = L.meta.dir;
    document.querySelector('meta[name="description"]').content = L.app.description;
    document.getElementById('brand').textContent = L.app.name;
    document.getElementById('about-link').textContent = L.nav.about;
    document.getElementById('bible-link').textContent = L.nav.bible;
    document.getElementById('credit').textContent = L.app.translationCredit;
    const skip = document.getElementById('skip');
    skip.textContent = L.app.skipToContent;
    skip.addEventListener('click', (e) => { e.preventDefault(); main.focus(); });

    PRAY = makeFlow(L.steps, {
      q: (n, k) => '#/step/' + n + '/' + k, first: '#/guide', review: '#/review', walk: '#/pray/', prayer: '#/prayer',
      save: saveDraft, cuesLabel: L.step.cuesLabel, hint: L.guide.hint, toReview: L.guide.toReview, finish: L.guide.finish,
      reviewText: { heading: L.guide.reviewHeading, hint: L.guide.reviewHint, toWalk: L.guide.toAloud },
      prayerText: L.prayer,
    });
    // Share Jesus words are held in memory only: save() never writes them anywhere.
    SHARE = makeFlow(L.share.steps, {
      q: (n) => '#/share/q/' + n, first: '#/share/cost', review: '#/share/review', walk: '#/share/pray/', prayer: '#/share/prayer',
      save: () => {}, cuesLabel: L.share.ideasLabel, hint: L.share.hint, toReview: L.share.review.heading, finish: L.share.walk.finish,
      needHelp: '#/share/borrow', perPhrase: true, reviewText: L.share.review, prayerText: L.share.prayer,
    });
    loadDraft();
    // The skip link's target is #main, which is not a screen: never route to it.
    window.addEventListener('hashchange', () => { if (location.hash !== '#main') render(true); });
    render(false);

    if ('serviceWorker' in navigator) {
      const hadWorker = !!navigator.serviceWorker.controller;
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        // Never reload while there are words on the screen that are not kept anywhere.
        // Pray by myself words survive a reload in sessionStorage; Share Jesus words would not.
        if (!hadWorker || reloaded || downloading || prayerParts(SHARE).length || (!visitKept && !keep && anyWords())) return;
        reloaded = true;
        location.reload();
      });
      navigator.serviceWorker.register('sw.js').then((reg) => reg.update()).catch(() => {});
    }
  }

  start();
})();
