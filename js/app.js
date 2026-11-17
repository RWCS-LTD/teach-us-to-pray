/* Teach Us to Pray
 *
 * One small script, no dependencies. It loads two local JSON files (the
 * language file and the Scripture file) and then makes no further requests.
 * What a person writes is held in memory only, unless they switch on
 * "keep my draft on this device", which uses this browser's localStorage.
 */
(() => {
  'use strict';

  // Languages that have a lang/<code>.json file. See README: "Adding a language".
  const LANGS = ['en'];
  const DRAFT_KEY = 'teach-us-to-pray-draft';

  let L;            // language strings
  let S;            // scripture document
  let answers = []; // the person's own words, one entry per step
  let parts = [];   // the words typed under each short question, per step
  let keep = false; // "keep my draft on this device"
  let flash = '';   // one-time status message for the next render
  let prayerDay = null;     // the day fixed when the person taps Begin (memory only)
  const edited = new Set(); // steps changed on the read-through screen this visit

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
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
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
  // and touches a removed double mark, because the closing single mark is also the
  // apostrophe. tools/verify.py applies the same rule and checks every excerpt.
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
    const drop = new Set([...strayDouble].filter(atEdge));
    for (const i of [...drop]) {
      if (t[i] === '“' && straySingle.has(i + 1)) drop.add(i + 1);
      if (t[i] === '”' && straySingle.has(i - 1)) drop.add(i - 1);
    }
    return t.split('').filter((_, i) => !drop.has(i)).join('');
  }

  // A passage of Scripture with its reference. The text comes only from the Scripture file.
  function passage(group, extraClass) {
    return h('figure', { class: 'verse' + (extraClass ? ' ' + extraClass : '') },
      h('blockquote', null, h('p', null, trimQuotes(group.map((r) => S.verses[r]).join(' ')))),
      h('figcaption', null, refLabel(group) + ' · ' + S.abbreviation));
  }

  const paragraphs = (list) => list.map((t) => h('p', null, t));
  const written = () => answers.filter((a) => a.trim());

  /* ---------- optional draft on this device ---------- */

  function loadDraft() {
    try {
      let saved = JSON.parse(localStorage.getItem(DRAFT_KEY));
      if (Array.isArray(saved)) saved = { answers: saved }; // first version stored a plain list
      if (!saved || !Array.isArray(saved.answers)) return;
      const text = (v) => (typeof v === 'string' ? v : '');
      answers = answers.map((_, i) => text(saved.answers[i]));
      parts = parts.map((list, i) => list.map((_, k) => text(((saved.parts || [])[i] || [])[k])));
      keep = true;
    } catch (e) { /* storage unavailable: carry on without it */ }
  }
  function saveDraft() {
    if (!keep) return;
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ answers, parts })); } catch (e) { /* ignore */ }
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
        answers = answers.map(() => '');
        parts = parts.map((list) => list.map(() => ''));
        edited.clear();
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

  function welcomeView() {
    return {
      nodes: [
        h('h1', null, L.welcome.heading),
        L.welcome.verses.map((r) => passage([r])),
        paragraphs(L.welcome.body),
        h('div', { class: 'actions' }, beginLink('#/guide', L.welcome.begin)),
        h('p', null, h('a', { href: '#/why' }, L.welcome.whyLink)),
        draftSection(),
      ],
    };
  }

  // A Begin button. Tapping it fixes "today" for this prayer, so the passages
  // offered do not change if the prayer runs past midnight.
  const today = () => Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / 86400000);
  function beginLink(href, label) {
    return h('a', { class: 'btn primary grow', href, onclick: () => { prayerDay = today(); } }, label);
  }

  function whyView() {
    return {
      title: L.why.heading,
      nodes: [
        h('h1', null, L.why.heading),
        L.why.sections.map((s) => [h('h2', null, s.heading), passage(s.verses)]),
        h('div', { class: 'actions' },
          h('a', { class: 'btn', href: '#/' }, L.nav.back),
          h('a', { class: 'btn primary grow', href: '#/guide' }, L.nav.start)),
      ],
    };
  }

  // Which entries of a step's pool to show today. Chosen from the date alone,
  // so nothing about the person needs to be stored. The day is the one fixed at
  // Begin, or today if a step was opened directly.
  function todaysPassages(pool) {
    const perDay = Math.min(L.step.perDay, pool.length);
    if (!perDay) return [[], []];
    const day = prayerDay == null ? today() : prayerDay;
    const start = (day * perDay) % pool.length;
    const picks = [];
    const rest = [];
    pool.forEach((g, j) => (((j - start + pool.length) % pool.length) < perDay ? picks : rest).push(g));
    return [picks, rest];
  }

  const progressText = (n) => L.step.progress.replace('{n}', n).replace('{total}', L.steps.length);
  const dots = (i) => h('ol', { class: 'dots', 'aria-hidden': 'true' },
    L.steps.map((_, j) => h('li', { class: j <= i ? 'done' : '' })));
  // Each step keeps the words of its short questions; the step's words are those
  // joined with a space, so the step reads as one paragraph. Nothing is added to them.
  const joined = (i) => parts[i].filter((t) => t.trim()).join(' ');

  // "Guide me": a short start screen with the words of Jesus about praying simply.
  function guideIntroView() {
    const g = L.guide;
    return {
      title: g.introHeading,
      nodes: [
        h('h1', null, g.introHeading),
        passage(g.introVerses),
        paragraphs(g.intro),
        h('div', { class: 'actions' },
          h('a', { class: 'btn', href: '#/' }, L.nav.back),
          beginLink('#/step/1/1', g.begin)),
      ],
    };
  }

  // "Guide me": one short question on the screen at a time.
  function guideView(i, k) {
    const g = L.guide;
    const step = L.steps[i];
    const item = step.guided[k];
    const count = step.guided.length;
    const n = i + 1;
    const progress = progressText(n) + (count > 1 ? g.questionOf.replace('{k}', k + 1).replace('{count}', count) : '');
    const last = n === L.steps.length && k === count - 1;

    // If the words were changed on the read-through screen, keep them all: put them under the first question.
    if (joined(i) !== answers[i]) parts[i] = parts[i].map((_, q) => (q ? '' : answers[i]));
    const editedNote = edited.has(i) && count > 1 && h('p', { class: 'note' }, k ? g.editedFirst : g.editedHere);

    const nextHref = k + 1 < count ? '#/step/' + n + '/' + (k + 2) : last ? '#/review' : '#/step/' + (n + 1) + '/1';
    const backHref = k > 0 ? '#/step/' + n + '/' + k
      : i > 0 ? '#/step/' + i + '/' + L.steps[i - 1].guided.length : '#/guide';
    const nextLabel = () => (last ? g.toReview : parts[i][k].trim() ? L.nav.next : L.nav.skipQuestion);
    const next = h('a', { class: 'btn primary grow', href: nextHref }, nextLabel());

    // The box always starts with the person's own words or nothing at all.
    // Spell-check is off so that no browser service is sent what is typed.
    const update = () => { parts[i][k] = box.value; answers[i] = joined(i); edited.delete(i); next.textContent = nextLabel(); saveDraft(); };
    const box = h('textarea', {
      id: 'words', class: 'short', rows: '4', autocomplete: 'off', spellcheck: 'false',
      'aria-describedby': 'words-hint', oninput: update,
    });
    box.value = parts[i][k];

    // "Think about" prompts are for reflection only. Nothing is ever put in the box for the person.
    const cues = item.cues && h('div', { class: 'cues' },
      h('p', { id: 'cues-label' }, L.step.cuesLabel + ':'),
      h('ul', { 'aria-labelledby': 'cues-label' }, item.cues.map((cue) => h('li', null, cue))));
    const [picks, rest] = todaysPassages(step.related);

    return {
      title: progress + ': ' + step.name,
      nodes: [
        h('p', { class: 'progress' }, progress),
        dots(i),
        h('h1', null, step.name),
        step.verses.map((v) => passage(v, 'main')),
        step.note && h('p', { class: 'note' }, h('strong', null, L.app.ourNoteLabel + ': '), step.note),
        h('div', { class: 'ask' },
          h('label', { for: 'words' }, item.q),
          item.example && [h('h2', { class: 'small' }, g.exampleHeading), passage(item.example)],
          cues,
          editedNote,
          box,
          h('p', { class: 'hint', id: 'words-hint' }, g.hint)),
        h('div', { class: 'actions' },
          h('a', { class: 'btn', href: backHref }, L.nav.back),
          next),
        picks.length > 0 && h('details', null, h('summary', null, L.step.relatedHeading), picks.map((v) => passage(v))),
        rest.length > 0 && h('details', null, h('summary', null, L.step.moreLink), rest.map((v) => passage(v))),
      ],
    };
  }

  // The whole prayer in one place, one box per step, to read through and make one's own before praying it.
  function reviewView() {
    const g = L.guide;
    const filled = L.steps.map((st, i) => ({ st, i })).filter(({ i }) => answers[i].trim());
    if (!filled.length) return prayerView();
    const lastStep = L.steps.length;
    return {
      title: g.reviewHeading,
      nodes: [
        h('h1', null, g.reviewHeading),
        h('p', { class: 'lead', id: 'review-hint' }, g.reviewHint),
        filled.map(({ st, i }) => {
          const id = 'review-' + (i + 1);
          // Spell-check is off so that no browser service is sent what is typed.
          const box = h('textarea', {
            id, rows: '4', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'review-hint',
            oninput: (e) => { answers[i] = e.target.value; edited.add(i); saveDraft(); },
          });
          box.value = answers[i];
          return h('div', { class: 'ask' }, h('label', { for: id }, st.name), box);
        }),
        h('div', { class: 'actions' },
          h('a', { class: 'btn', href: '#/step/' + lastStep + '/' + L.steps[lastStep - 1].guided.length }, L.nav.back),
          h('a', { class: 'btn primary grow', href: '#/pray/1' }, g.toAloud)),
      ],
    };
  }

  // "Guide me" ends here: the person's own words in large text, one part at a time, to say out loud.
  function prayWalkView(n) {
    const g = L.guide;
    const said = L.steps.map((st, i) => ({ name: st.name, text: answers[i] })).filter((part) => part.text.trim());
    if (!said.length) return prayerView();
    const idx = Math.min(Math.max(n, 1), said.length) - 1;
    const progress = g.partOf.replace('{n}', idx + 1).replace('{total}', said.length);
    const lastPart = idx === said.length - 1;
    return {
      title: progress + ': ' + said[idx].name,
      nodes: [
        h('p', { class: 'progress' }, progress + ' \u00b7 ' + said[idx].name),
        h('h1', null, g.sayThis),
        h('div', { class: 'aloud' }, h('p', null, said[idx].text)),
        h('div', { class: 'actions' },
          h('a', { class: 'btn', href: idx > 0 ? '#/pray/' + idx : '#/review' }, L.nav.back),
          h('a', { class: 'btn primary grow', href: lastPart ? '#/prayer' : '#/pray/' + (idx + 2) },
            lastPart ? g.finish : L.nav.next)),
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

  function prayerView() {
    const parts = written();
    const nodes = [h('h1', null, L.prayer.heading)];
    if (!parts.length) {
      nodes.push(h('p', null, L.prayer.empty),
        h('div', { class: 'actions' }, h('a', { class: 'btn primary', href: '#/guide' }, L.guide.begin)));
    } else {
      const status = h('p', { class: 'status', role: 'status' });
      nodes.push(
        h('p', { class: 'no-print' }, L.prayer.intro),
        // Only the person's own words, exactly as typed, in step order.
        h('div', { class: 'prayer' }, paragraphs(parts)),
        h('div', { class: 'actions' },
          h('button', {
            type: 'button', class: 'btn primary',
            onclick: async () => { status.textContent = (await copyText(parts.join('\n\n'))) ? L.prayer.copied : L.prayer.copyFailed; },
          }, L.prayer.copy),
          // Share opens the device's own share sheet; the person chooses where the words go.
          navigator.share && h('button', {
            type: 'button', class: 'btn',
            onclick: () => { navigator.share({ text: parts.join('\n\n') }).catch(() => {}); },
          }, L.prayer.share),
          h('button', {
            type: 'button', class: 'btn',
            onclick: () => { saveFile(parts.join('\n\n')); status.textContent = L.prayer.saved; },
          }, L.prayer.save),
          h('button', { type: 'button', class: 'btn', onclick: () => window.print() }, L.prayer.print),
          h('a', { class: 'btn', href: '#/aloud' }, L.prayer.aloud),
          h('a', { class: 'btn', href: '#/review' }, L.prayer.edit)),
        status);
    }
    nodes.push(draftSection());
    return { title: L.prayer.heading, nodes };
  }

  function aloudView() {
    const parts = written();
    if (!parts.length) return prayerView();
    return {
      title: L.prayer.aloudHeading,
      nodes: [
        h('h1', { class: 'progress' }, L.prayer.aloudHeading),
        h('div', { class: 'aloud' }, paragraphs(parts)),
        h('div', { class: 'actions' }, h('a', { class: 'btn primary', href: '#/prayer' }, L.prayer.aloudClose)),
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

  function render(moveFocus) {
    const [name, arg, arg2] = location.hash.replace(/^#\/?/, '').split('/');
    const stepIndex = parseInt(arg, 10) - 1;
    let view;
    if (name === 'step' && L.steps[stepIndex]) {
      const count = L.steps[stepIndex].guided.length;
      view = guideView(stepIndex, Math.min(Math.max(parseInt(arg2, 10) || 1, 1), count) - 1);
    }
    else if (name === 'guide') view = guideIntroView();
    else if (name === 'review') view = reviewView();
    else if (name === 'pray') view = prayWalkView(parseInt(arg, 10) || 1);
    else if (name === 'prayer') view = prayerView();
    else if (name === 'aloud') view = aloudView();
    else if (name === 'about') view = aboutView();
    else if (name === 'why') view = whyView();
    else view = welcomeView();

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

    answers = L.steps.map(() => '');
    parts = L.steps.map((st) => (st.guided || []).map(() => ''));
    loadDraft();
    // The skip link's target is #main, which is not a screen: never route to it.
    window.addEventListener('hashchange', () => { if (location.hash !== '#main') render(true); });
    render(false);

    if ('serviceWorker' in navigator) {
      const hadWorker = !!navigator.serviceWorker.controller;
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadWorker || reloaded || (!keep && written().length)) return;
        reloaded = true;
        location.reload();
      });
      navigator.serviceWorker.register('sw.js').then((reg) => reg.update()).catch(() => {});
    }
  }

  start();
})();
