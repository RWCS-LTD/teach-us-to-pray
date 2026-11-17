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
  let keep = false; // "keep my draft on this device"
  let flash = '';   // one-time status message for the next render

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

  // A passage of Scripture with its reference. The text comes only from the Scripture file.
  function passage(group, extraClass) {
    return h('figure', { class: 'verse' + (extraClass ? ' ' + extraClass : '') },
      h('blockquote', null, h('p', null, group.map((r) => S.verses[r]).join(' '))),
      h('figcaption', null, refLabel(group) + ' · ' + S.abbreviation));
  }

  const paragraphs = (list) => list.map((t) => h('p', null, t));
  const written = () => answers.filter((a) => a.trim());

  /* ---------- optional draft on this device ---------- */

  function loadDraft() {
    try {
      const saved = JSON.parse(localStorage.getItem(DRAFT_KEY));
      if (!Array.isArray(saved)) return;
      answers = answers.map((_, i) => (typeof saved[i] === 'string' ? saved[i] : ''));
      keep = true;
    } catch (e) { /* storage unavailable: carry on without it */ }
  }
  function saveDraft() {
    if (!keep) return;
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(answers)); } catch (e) { /* ignore */ }
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
        h('div', { class: 'actions' },
          h('a', { class: 'btn primary grow', href: '#/step/1' }, L.nav.start)),
        h('p', null, h('a', { href: '#/why' }, L.welcome.whyLink)),
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
        h('div', { class: 'actions' },
          h('a', { class: 'btn', href: '#/' }, L.nav.back),
          h('a', { class: 'btn primary grow', href: '#/step/1' }, L.nav.start)),
      ],
    };
  }

  // Which entries of a step's pool to show today. Chosen from the date alone,
  // so nothing about the person needs to be stored.
  function todaysPassages(pool) {
    const perDay = Math.min(L.step.perDay, pool.length);
    if (!perDay) return [[], []];
    const day = Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / 86400000);
    const start = (day * perDay) % pool.length;
    const today = [];
    const rest = [];
    pool.forEach((g, j) => (((j - start + pool.length) % pool.length) < perDay ? today : rest).push(g));
    return [today, rest];
  }

  function stepView(i) {
    const step = L.steps[i];
    const n = i + 1;
    const total = L.steps.length;
    const progress = L.step.progress.replace('{n}', n).replace('{total}', total);
    const [today, rest] = todaysPassages(step.related);

    const nextLabel = () => (n === total ? L.nav.finish : answers[i].trim() ? L.nav.next : L.nav.skip);
    const next = h('a', { class: 'btn primary grow', href: n < total ? '#/step/' + (n + 1) : '#/prayer' }, nextLabel());

    // The box always starts with the person's own words or nothing at all.
    // Spell-check is off so that no browser service is sent what is typed.
    const box = h('textarea', {
      id: 'words', rows: '6', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'words-hint',
      oninput: (e) => { answers[i] = e.target.value; next.textContent = nextLabel(); saveDraft(); },
    });
    box.value = answers[i];

    return {
      title: progress + ': ' + step.name,
      nodes: [
        h('p', { class: 'progress' }, progress),
        h('ol', { class: 'dots', 'aria-hidden': 'true' },
          L.steps.map((_, j) => h('li', { class: j <= i ? 'done' : '' }))),
        h('h1', null, step.name),
        h('h2', null, L.step.jesusWords),
        step.verses.map((g) => passage(g, 'main')),
        step.note && h('p', { class: 'note' }, h('strong', null, L.app.ourNoteLabel + ': '), step.note),
        today.length > 0 && [h('h2', null, L.step.relatedHeading), today.map((g) => passage(g))],
        rest.length > 0 && h('details', null, h('summary', null, L.step.moreLink), rest.map((g) => passage(g))),
        h('div', { class: 'ask' },
          h('label', { for: 'words' }, step.prompt),
          h('p', { class: 'hint', id: 'words-hint' }, L.step.inputHint),
          box),
        h('div', { class: 'actions' },
          h('a', { class: 'btn', href: n > 1 ? '#/step/' + (n - 1) : '#/' }, L.nav.back),
          next),
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

  function prayerView() {
    const parts = written();
    const nodes = [h('h1', null, L.prayer.heading)];
    if (!parts.length) {
      nodes.push(h('p', null, L.prayer.empty),
        h('div', { class: 'actions' }, h('a', { class: 'btn primary', href: '#/step/1' }, L.prayer.edit)));
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
          h('button', { type: 'button', class: 'btn', onclick: () => window.print() }, L.prayer.print),
          h('a', { class: 'btn', href: '#/aloud' }, L.prayer.aloud),
          h('a', { class: 'btn', href: '#/step/1' }, L.prayer.edit)),
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
    const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
    const stepIndex = parseInt(arg, 10) - 1;
    let view;
    if (name === 'step' && L.steps[stepIndex]) view = stepView(stepIndex);
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
    loadDraft();
    window.addEventListener('hashchange', () => render(true));
    render(false);

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  start();
})();
