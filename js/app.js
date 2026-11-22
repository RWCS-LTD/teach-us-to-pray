/* Teach Us to Pray
 *
 * One small script, no dependencies. It loads two local JSON files (the
 * language file and the Scripture file) and then makes no further requests.
 * What a person writes is held in memory only, unless they switch on
 * "keep my draft on this device", which uses this browser's localStorage.
 * Words typed in "Share Jesus" are never stored, whatever that setting is.
 */
(() => {
  'use strict';

  // Languages that have a lang/<code>.json file. See README: "Adding a language".
  const LANGS = ['en'];
  const DRAFT_KEY = 'teach-us-to-pray-draft';

  let L;            // language strings
  let S;            // scripture document
  let PRAY;         // "Pray by myself": the guided prayer
  let SHARE;        // "Share Jesus": a leader guiding someone else
  let keep = false; // "keep my draft on this device" (Pray by myself only)
  let flash = '';   // one-time status message for the next render
  let prayerDay = null; // the day fixed when the person taps Begin (memory only)

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
      h('figcaption', null, cite(group)));
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

  function loadDraft() {
    try {
      let saved = JSON.parse(localStorage.getItem(DRAFT_KEY));
      if (Array.isArray(saved)) saved = { answers: saved }; // first version stored a plain list
      if (!saved || !Array.isArray(saved.answers)) return;
      const text = (v) => (typeof v === 'string' ? v : '');
      PRAY.answers = PRAY.answers.map((_, i) => text(saved.answers[i]));
      PRAY.parts = PRAY.parts.map((list, i) => list.map((_, k) => text(((saved.parts || [])[i] || [])[k])));
      keep = true;
    } catch (e) { /* storage unavailable: carry on without it */ }
  }
  function saveDraft() {
    if (!keep) return;
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ answers: PRAY.answers, parts: PRAY.parts })); } catch (e) { /* ignore */ }
  }
  function forgetDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* ignore */ }
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
        saveDraft();
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
          h('li', null, h('p', null, h('strong', null, item.text)), item.verses.map((v) => passage(v))))),
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

  function render(moveFocus) {
    const [name, arg, arg2] = location.hash.replace(/^#\/?/, '').split('/');
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
    if (!view) view = welcomeView();

    // Share Jesus is held between two people, so its text is larger.
    document.body.classList.toggle('together', name === 'share');
    main.replaceChildren(...view.nodes.flat(Infinity).filter(Boolean));
    document.title = view.title ? view.title + ' | ' + L.app.name : L.app.name;
    if (moveFocus) {
      const heading = main.querySelector('h1');
      heading.tabIndex = -1;
      heading.focus();
      window.scrollTo(0, 0);
    }
  }

  async function start() {
    const wanted = (navigator.languages || [navigator.language || '']).map((l) => l.slice(0, 2).toLowerCase());
    const lang = wanted.find((l) => LANGS.includes(l)) || LANGS[0];
    L = await (await fetch('lang/' + lang + '.json')).json();
    S = await (await fetch(L.meta.scriptureFile)).json();

    document.documentElement.lang = L.meta.lang;
    document.documentElement.dir = L.meta.dir;
    document.querySelector('meta[name="description"]').content = L.app.description;
    document.getElementById('brand').textContent = L.app.name;
    document.getElementById('about-link').textContent = L.nav.about;
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
        if (!hadWorker || reloaded || ((!keep || prayerParts(SHARE).length) && anyWords())) return;
        reloaded = true;
        location.reload();
      });
      navigator.serviceWorker.register('sw.js').then((reg) => reg.update()).catch(() => {});
    }
  }

  start();
})();
