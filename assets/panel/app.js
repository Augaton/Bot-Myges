// Panel étudiant. Tout ce qui vient du serveur est inséré par h() en tant que texte :
// aucune chaîne n'est jamais interprétée comme du HTML.
const root = document.getElementById('app');

const paris = { timeZone: 'Europe/Paris' };
const timeFormat = new Intl.DateTimeFormat('fr-FR', { ...paris, hour: '2-digit', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat('fr-FR', { ...paris, weekday: 'long', day: 'numeric', month: 'long' });
const dateFormat = new Intl.DateTimeFormat('fr-FR', { ...paris, day: 'numeric', month: 'long', year: 'numeric' });
const shortFormat = new Intl.DateTimeFormat('fr-FR', { ...paris, day: 'numeric', month: 'long' });
const isoFormat = new Intl.DateTimeFormat('sv-SE', paris);
const gradeFormat = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const DAY = 86_400_000;
const time = (t) => timeFormat.format(t);
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const day = (t) => capitalize(dayFormat.format(t));
const grade = (v) => gradeFormat.format(v);
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, options) {
  let res;
  try {
    res = await fetch(path, options);
  } catch {
    throw new ApiError(0, 'Connexion au panel impossible. Vérifie ton réseau.');
  }
  if (res.ok && !res.headers.get('content-type')?.includes('json')) return res;
  const body = await res.json().catch(() => null);
  if (res.status === 401 && path !== '/api/login') {
    showLogin('Ta session a expiré. Reconnecte-toi.');
    throw new ApiError(401, '');
  }
  if (!res.ok) throw new ApiError(res.status, body?.error ?? (res.status >= 502 ? 'Le panel redémarre. Réessaie dans un instant.' : 'Une erreur est survenue.'));
  return body;
}

const post = (path, body) => api(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});

// Réponses gardées une minute : revenir sur un écran est immédiat. Tout est vidé à
// chaque retour à la connexion, pour que rien ne reste d'un compte à l'autre.
const CACHE_MS = 60_000;
const cache = new Map();

async function load(path) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const data = await api(path);
  cache.set(path, { at: Date.now(), data });
  return data;
}

/** Télécharge un fichier depuis un bouton ; une erreur s'affiche dans `zone`. */
async function downloadFile(path, fileName, button, zone, status = button) {
  const label = status.textContent;
  button.disabled = true;
  status.textContent = 'Envoi…';
  zone.querySelector('[role="alert"]')?.remove();
  try {
    const res = await api(`${path}?name=${encodeURIComponent(fileName)}`);
    const url = URL.createObjectURL(await res.blob());
    h('a', { href: url, download: fileName }).click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    if (e.status !== 401) zone.prepend(h('p', { class: 'field-error', role: 'alert' }, e.message));
  }
  button.disabled = false;
  status.textContent = label;
}

// --- Connexion ---

function showLogin(message = '') {
  cache.clear();
  const error = h('p', { class: 'field-error', role: 'alert', hidden: !message }, message);
  const username = h('input', { id: 'username', name: 'username', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true, maxlength: 100 });
  const password = h('input', { id: 'password', name: 'password', type: 'password', autocomplete: 'current-password', required: true, maxlength: 200 });
  const submit = h('button', { type: 'submit', class: 'primary' }, 'Se connecter');

  const form = h('form', {
    onsubmit: async (event) => {
      event.preventDefault();
      submit.disabled = true;
      submit.textContent = 'Connexion…';
      error.hidden = true;
      try {
        const { name } = await post('/api/login', { username: username.value, password: password.value });
        password.value = '';
        showShell(name);
      } catch (e) {
        error.textContent = e.message;
        error.hidden = false;
        password.value = '';
        password.focus();
        submit.disabled = false;
        submit.textContent = 'Se connecter';
      }
    },
  },
  h('div', {}, h('label', { for: 'username' }, 'Identifiant MyGES'), username),
  h('div', {}, h('label', { for: 'password' }, 'Mot de passe'), password, error),
  submit);

  root.replaceChildren(h('div', { class: 'login' }, h('div', { class: 'login-box' },
    h('div', {}, h('h1', {}, 'Panel étudiant'), h('p', { class: 'muted' }, 'Ton agenda, tes notes et tes documents au même endroit.')),
    form,
    h('p', { class: 'notice' }, 'Service non officiel, sans lien avec MyGES ni le Réseau GES. Ton mot de passe sert une seule fois à vérifier ton compte auprès de MyGES : il n\'est jamais enregistré.'))));
  username.focus();
}

// --- Cadre ---

const VIEWS = {
  accueil: { label: 'Accueil', render: homeView },
  agenda: { label: 'Agenda', render: agendaView },
  notes: { label: 'Notes', render: notesView },
  absences: { label: 'Absences', render: absencesView },
  projets: { label: 'Projets', render: projectsView },
  documents: { label: 'Documents', render: documentsView },
  actualites: { label: 'Actualités', render: newsView },
  projet: { label: 'Projet', render: projectView, parent: 'projets' },
};

// Sur téléphone, ces écrans sont dans la barre du bas ; les autres, sous « Plus ».
const PRIMARY = ['accueil', 'agenda', 'notes', 'projets'];
const SKELETON_DELAY_MS = 150;

let main;
let plus;
let links = {};
let userName = '';
let renderId = 0;
let currentView = '';
const scrolls = {};

const setMenu = (open) => plus?.setAttribute('aria-expanded', String(open));

function showShell(name) {
  userName = name;
  let touch = null;
  main = h('main', {
    id: 'contenu',
    ontouchstart: (e) => { touch = e.touches[0]; },
    ontouchend: (e) => {
      const end = e.changedTouches[0];
      const dx = end.clientX - (touch?.clientX ?? end.clientX);
      const dy = end.clientY - (touch?.clientY ?? end.clientY);
      // Un geste nettement horizontal : ne pas gêner le défilement de la page.
      if (currentView === 'agenda' && Math.abs(dx) > 70 && Math.abs(dx) > 2 * Math.abs(dy)) stepWeek(dx < 0 ? 7 : -7);
    },
  });
  links = Object.fromEntries(Object.entries(VIEWS).filter(([, view]) => !view.parent).map(([id, view]) => [id, h('a', { href: `#${id}` }, view.label)]));
  const logout = h('button', {
    type: 'button',
    onclick: async () => {
      await post('/api/logout').catch(() => {});
      history.replaceState(null, '', location.pathname);
      showLogin();
    },
  }, 'Déconnexion');
  plus = h('button', {
    type: 'button',
    class: 'plus',
    'aria-expanded': 'false',
    'aria-controls': 'plus-menu',
    onclick: () => setMenu(plus.getAttribute('aria-expanded') !== 'true'),
  }, 'Plus');

  root.replaceChildren(h('div', { class: 'shell' },
    h('div', { class: 'side' },
      h('header', { class: 'top' }, h('span', { class: 'brand' }, 'Panel étudiant'), h('span', { class: 'who' }, name)),
      h('nav', { 'aria-label': 'Navigation' },
        PRIMARY.map((id) => links[id]),
        plus,
        h('div', { class: 'more', id: 'plus-menu' },
          Object.keys(links).filter((id) => !PRIMARY.includes(id)).map((id) => links[id]),
          logout))),
    main));
  render();
}

const skeleton = () => h('div', { class: 'skeleton', 'aria-label': 'Chargement' }, h('div'), h('div'), h('div'));

async function render() {
  const [route, param] = location.hash.slice(1).split('/');
  const id = VIEWS[route] ? route : 'accueil';
  const active = VIEWS[id].parent ?? id;
  const current = ++renderId;
  if (currentView) scrolls[currentView] = window.scrollY;
  currentView = id;
  setMenu(false);
  for (const [key, link] of Object.entries(links)) {
    if (key === active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (PRIMARY.includes(active)) plus.removeAttribute('data-current');
  else plus.setAttribute('data-current', 'true');

  const title = h('h1', { tabindex: '-1' }, VIEWS[id].label);
  document.title = `${VIEWS[id].label} | Panel étudiant`;
  // L'écran précédent reste affiché un instant : une réponse rapide ne clignote pas.
  const waiting = setTimeout(() => {
    if (current === renderId) main.replaceChildren(title, skeleton());
  }, SKELETON_DELAY_MS);
  try {
    const content = await VIEWS[id].render(title, param);
    if (current !== renderId) return; // l'étudiant a changé de page entre-temps
    clearTimeout(waiting);
    main.replaceChildren(title, ...[content].flat().filter(Boolean));
    window.scrollTo(0, scrolls[id] ?? 0);
    title.focus({ preventScroll: true });
  } catch (e) {
    clearTimeout(waiting);
    if (current !== renderId || e.status === 401) return;
    main.replaceChildren(title, h('div', { class: 'error', role: 'alert' },
      h('p', {}, e.message),
      h('button', { type: 'button', onclick: render }, 'Réessayer')));
  }
}

const section = (title, ...content) => h('section', { class: 'stack' }, h('h2', {}, title), ...content);
const empty = (text) => h('p', { class: 'empty' }, text);
const unavailable = () => empty('Indisponible pour le moment.');

function courseRow(c, now = Date.now()) {
  const live = c.start <= now && now < c.end;
  return h('li', {}, h('button', { type: 'button', class: 'course', onclick: () => showCourse(c) },
    h('span', { class: 'time' }, h('span', { class: 'line' }, time(c.start)), h('span', { class: 'line muted small' }, time(c.end))),
    h('span', { class: 'grow' },
      h('span', { class: 'line name' }, c.name),
      c.place && h('span', { class: 'line small' }, c.place),
      c.teacher && h('span', { class: 'line muted small' }, c.teacher)),
    live ? h('span', { class: 'tag' }, 'En cours') : c.type === 'Examen' && h('span', { class: 'tag' }, 'Examen')));
}

/** Fenêtre de détail : se ferme avec Échap, le bouton Fermer ou un clic à côté. */
function showDialog(title, ...content) {
  const body = h('div', { class: 'sheet-body' }, content);
  const dialog = h('dialog', {
    class: 'sheet',
    'aria-labelledby': 'dialog-title',
    onclose: () => dialog.remove(),
    onclick: (e) => {
      if (e.target === dialog) dialog.close();
    },
  },
  h('div', { class: 'sheet-head' },
    h('h2', { id: 'dialog-title' }, title),
    h('button', { type: 'button', onclick: () => dialog.close() }, 'Fermer')),
  body);
  root.append(dialog);
  dialog.showModal();
  return { dialog, body };
}

const facts = (rows) => h('dl', { class: 'facts' }, rows.filter(([, value]) => value).flatMap(([label, value]) => [h('dt', {}, label), h('dd', {}, value)]));

function duration(ms) {
  const total = Math.round(ms / 60_000);
  const hours = Math.floor(total / 60);
  return `${hours ? `${hours} h ` : ''}${total % 60 ? `${total % 60} min` : ''}`.trim();
}

function showCourse(c) {
  const rooms = c.rooms?.filter((r) => r.name) ?? [];
  const { dialog, body } = showDialog(c.name, facts([
    ['Date', day(c.start)],
    ['Horaire', `${time(c.start)} à ${time(c.end)} (${duration(c.end - c.start)})`],
    ['Lieu', c.place],
    ['Étage', [...new Set(rooms.map((r) => r.floor).filter(Boolean))].join(', ')],
    ['Intervenant', c.teacher],
    ['Type', c.type],
    ['Modalité', c.modality],
    ['Période', c.period],
    ['Groupe', c.group],
    ['Effectif', c.students && `${c.students} étudiants`],
    ['Présence', c.signature && 'Signature électronique'],
  ]), c.comment && h('p', { class: 'body-text' }, c.comment));
  if (c.rcId) addCourseExtras(c.rcId, dialog, body);
}

/** Supports et syllabus de la matière, ajoutés dès qu'ils sont là : la fenêtre s'ouvre sans attendre. */
async function addCourseExtras(rcId, dialog, body) {
  const [sources, syllabus] = await Promise.all([
    load('/api/documents').catch(() => []),
    load(`/api/courses/${rcId}/syllabus`).catch(() => null),
  ]);
  if (!dialog.isConnected) return;
  if (sources.some((source) => source.id === rcId)) {
    body.append(h('button', {
      type: 'button',
      onclick: () => {
        openFolder = rcId;
        dialog.close();
        location.hash = '#documents';
      },
    }, 'Voir les supports de cours'));
  }
  if (!syllabus) return;
  const parts = [
    syllabus.evaluation.length > 0 && section('Évaluation', h('p', {}, syllabus.evaluation.join(', '))),
    syllabus.criteria && section('Critères', h('p', { class: 'body-text' }, syllabus.criteria)),
    syllabus.prerequisite && section('Prérequis', h('p', { class: 'body-text' }, syllabus.prerequisite)),
    syllabus.plan && section('Programme', h('p', { class: 'body-text' }, syllabus.plan)),
    syllabus.sessions.length > 0 && h('details', {}, h('summary', {}, plural(syllabus.sessions.length, 'séance')),
      h('ol', { class: 'sessions' }, syllabus.sessions.map((text) => h('li', {}, text)))),
  ].filter(Boolean);
  body.append(...parts);
}

function relative(date) {
  const days = Math.ceil((date - Date.now()) / DAY);
  if (days <= 0) return 'aujourd\'hui';
  return days === 1 ? 'demain' : `dans ${days} jours`;
}

/** Barre d'avancement. Le nombre d'étapes est toujours écrit à côté. */
const progressBar = (done, total) => withVars(h('span', { class: 'bar plain', 'aria-hidden': 'true' }, h('span', { class: 'bar-fill' })), { '--value': total ? done / total : 0 });

function deadlineRow(p) {
  const soon = p.date !== null && p.date - Date.now() <= 3 * DAY;
  return h('li', {}, h('a', { class: 'course', href: `#projet/${p.id}` },
    h('span', { class: 'grow' },
      h('span', { class: 'line name' }, p.practical && h('span', { class: 'tag' }, 'TP'), p.practical && ' ', p.name),
      p.course && h('span', { class: 'line small muted' }, p.course),
      p.date !== null && p.stepsTotal > 0 && h('span', { class: 'line muted small' }, `Étape ${p.stepsDone} sur ${p.stepsTotal}`),
      p.date !== null && p.stepsTotal > 0 && progressBar(p.stepsDone, p.stepsTotal),
      p.date !== null && p.group === null && h('span', { class: 'line small danger' }, 'Pas encore de groupe')),
    h('span', { class: 'end small' },
      p.date === null
        ? [h('span', { class: 'line muted' }, 'Terminé'), p.last > 0 && h('span', { class: 'line muted' }, shortFormat.format(p.last))]
        : [h('span', { class: `line ${soon ? 'danger' : ''}` }, relative(p.date)), h('span', { class: 'line muted' }, shortFormat.format(p.date))])));
}

/** Carte d'un projet en cours : mêmes zones, à la même place, d'une carte à l'autre. */
function projectCard(p) {
  const soon = p.date - Date.now() <= 3 * DAY;
  return h('li', {}, h('a', { class: 'project-card', href: `#projet/${p.id}` },
    h('span', { class: 'card-top small' },
      h('span', { class: 'muted' }, p.practical ? 'Travail pratique' : 'Projet'),
      h('span', { class: soon ? 'danger' : '' }, capitalize(relative(p.date)))),
    h('span', { class: 'card-title' }, p.name),
    p.course && h('span', { class: 'card-course muted small' }, p.course),
    h('span', { class: 'card-foot' },
      p.stepsTotal > 0 && h('span', { class: 'line small' }, `Étape ${p.stepsDone} sur ${p.stepsTotal}`),
      p.stepsTotal > 0 && progressBar(p.stepsDone, p.stepsTotal),
      h('span', { class: 'line small muted' }, `${p.type}, ${shortFormat.format(p.date)}`),
      p.group === null
        ? h('span', { class: 'line small danger' }, 'Pas encore de groupe')
        : h('span', { class: 'line small muted' }, p.group))));
}

// --- Écrans ---

/** Lignes d'un bloc de l'accueil ; un bloc en panne le dit au lieu de disparaître. */
const homeBlock = (title, items, row, emptyText, link) => section(title,
  !items ? unavailable() : items.length ? h('ul', { class: 'rows' }, items.map(row)) : empty(emptyText),
  items?.length > 0 && link);

function showEvent(event) {
  showDialog(event.title, facts([
    ['Date', day(event.date)],
    ['Heure', time(event.date)],
    ['Lieu', event.location],
    ['Type', event.type],
    ['Organisateur', event.organizer],
  ]), event.description && h('p', { class: 'body-text' }, event.description));
}

async function homeView(title) {
  const data = await load('/api/home');
  title.textContent = `Bonjour ${userName.split(' ')[0]}`;
  const now = Date.now();
  const todayKey = isoFormat.format(now);
  const courses = data.courses?.filter((c) => c.end > now) ?? null;
  const next = courses?.[0];
  const isToday = (t) => isoFormat.format(t) === todayKey;

  const hero = !courses
    ? unavailable()
    : next
      ? h('button', { type: 'button', class: 'next', onclick: () => showCourse(next) },
        h('span', { class: 'small' }, next.start <= now ? 'Cours en cours' : `Prochain cours, ${relative(next.start)}`),
        h('span', { class: 'name' }, next.name),
        h('span', {}, `${isToday(next.start) ? 'Aujourd\'hui' : day(next.start)} à ${time(next.start)}`),
        next.place && h('span', { class: 'small' }, next.place))
      : h('p', { class: 'next' }, 'Aucun cours dans les 6 prochaines semaines.');

  const stat = (value, label, href, danger) => h('div', {}, h('dd', {}, h('a', { href, class: danger ? 'danger' : '' }, value)), h('dt', {}, label));
  const semester = data.semester;
  const average = semester?.average ?? semester?.provisional ?? null;
  const stats = [
    average !== null && stat(grade(average), semester.average === null ? 'Moyenne provisoire' : 'Moyenne', '#notes'),
    data.absences && stat(String(data.absences.unjustified), 'Absences non justifiées', '#absences', data.absences.unjustified > 0),
    data.deadlines && stat(String(data.deadlines.length), 'Projets en cours', '#projets'),
    courses && stat(String(courses.length), 'Cours à venir', '#agenda'),
  ].filter(Boolean);

  const days = new Map();
  for (const c of courses?.slice(next?.start <= now ? 1 : 1, 7) ?? []) {
    const key = isoFormat.format(c.start);
    days.set(key, [...(days.get(key) ?? []), c]);
  }

  return [
    h('p', { class: 'muted' }, day(now)),
    hero,
    stats.length > 0 && h('dl', { class: 'metrics stats' }, stats),
    h('div', { class: 'home' },
      h('div', { class: 'column' },
        days.size > 0 && section('Ensuite',
          [...days.values()].map((list) => h('div', { class: 'stack' },
            h('h3', { class: 'day-title' }, isToday(list[0].start) ? 'Aujourd\'hui' : day(list[0].start)),
            h('ul', { class: 'rows' }, list.map((c) => courseRow(c, now)))))),
        homeBlock('À rendre', data.deadlines?.slice(0, 3), deadlineRow, 'Rien à rendre pour le moment.', h('a', { href: '#projets', class: 'small' }, 'Tous les projets'))),
      h('div', { class: 'column' },
        homeBlock('Événements', data.events, (event) => h('li', {}, h('button', { type: 'button', class: 'course', onclick: () => showEvent(event) },
          h('span', { class: 'grow' }, h('span', { class: 'line name' }, event.title), event.location && h('span', { class: 'line muted small' }, event.location)),
          h('span', { class: 'end small' }, shortFormat.format(event.date)))), 'Aucun événement à venir.'),
        homeBlock('Actualités', data.news, (n) => h('li', {}, h('a', { class: 'course', href: '#actualites' },
          h('span', { class: 'grow' }, h('span', { class: 'line name' }, n.title), n.date && h('span', { class: 'line muted small' }, dateFormat.format(n.date))))), 'Aucune actualité.', h('a', { href: '#actualites', class: 'small' }, 'Toutes les actualités')))),
  ];
}

let agendaWeek = '';
let agendaStart = 0;

// Midi le lundi : ajouter 7 jours reste dans la bonne semaine au changement d'heure.
const weekAt = (days) => isoFormat.format(agendaStart + days * DAY + DAY / 2);

function goToWeek(week) {
  agendaWeek = week;
  scrolls.agenda = 0;
  render();
}

const stepWeek = (days) => goToWeek(weekAt(days));

async function agendaView() {
  const data = await load(`/api/agenda${agendaWeek ? `?week=${agendaWeek}` : ''}`);
  agendaStart = data.start;
  load(`/api/agenda?week=${weekAt(7)}`).catch(() => {}); // la semaine suivante sera immédiate
  const days = new Map();
  for (const c of data.courses) {
    const key = isoFormat.format(c.start);
    days.set(key, [...(days.get(key) ?? []), c]);
  }
  const content = [
    !days.size && h('div', { class: 'toolbar' },
      h('p', { class: 'muted' }, 'Aucun cours cette semaine.'),
      data.next && h('button', { type: 'button', onclick: () => goToWeek(isoFormat.format(data.next)) }, `Prochain cours : ${shortFormat.format(data.next)}`)),
    weekGrid(data, days),
    days.size > 0 && h('div', { class: 'only-narrow stack' }, [...days.values()].map((courses) => section(day(courses[0].start), h('ul', { class: 'rows' }, courses.map((c) => courseRow(c)))))),
  ];
  return [
    section(`Semaine du ${shortFormat.format(data.start + DAY / 2)} au ${shortFormat.format(data.start + 6 * DAY + DAY / 2)}`,
      h('div', { class: 'toolbar' },
        h('button', { type: 'button', onclick: () => stepWeek(-7) }, 'Précédente'),
        h('button', { type: 'button', onclick: () => goToWeek('') }, 'Cette semaine'),
        h('button', { type: 'button', onclick: () => stepWeek(7) }, 'Suivante'))),
    ...content,
  ];
}

const clockFormat = new Intl.DateTimeFormat('fr-FR', { ...paris, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
const weekdayFormat = new Intl.DateTimeFormat('fr-FR', { ...paris, weekday: 'short', day: 'numeric' });

/** Minutes écoulées depuis minuit, heure de Paris. */
function minutes(t) {
  const parts = Object.fromEntries(clockFormat.formatToParts(t).map((p) => [p.type, p.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

const withVars = (el, vars) => {
  for (const [name, value] of Object.entries(vars)) el.style.setProperty(name, String(value));
  return el;
};

/** Répartit les cours simultanés côte à côte, chacun sur une « voie » de la colonne. */
function laneLayout(courses) {
  const placed = [];
  let group = [];
  let groupEnd = 0;
  const flush = () => {
    const lanes = Math.max(...group.map((item) => item.lane)) + 1;
    placed.push(...group.map((item) => ({ ...item, lanes })));
    group = [];
    groupEnd = 0;
  };
  for (const course of [...courses].sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (group.length && course.start >= groupEnd) flush();
    const taken = new Set(group.filter((item) => item.course.end > course.start).map((item) => item.lane));
    let lane = 0;
    while (taken.has(lane)) lane++;
    group.push({ course, lane });
    groupEnd = Math.max(groupEnd, course.end);
  }
  if (group.length) flush();
  return placed;
}

// Échelle en pixels par minute : assez haute pour que le cours le plus court reste
// lisible, sans étirer inutilement une semaine de longs cours.
const DEFAULT_FIRST_HOUR = 8;
const DEFAULT_LAST_HOUR = 18;
const MIN_SCALE = 0.8;
const MAX_SCALE = 1.5;
const READABLE_HEIGHT = 90; // deux lignes de nom, l'horaire et la salle

/** Grille de la semaine, pour les grands écrans : une colonne par jour, cours placés selon l'heure. */
function weekGrid(data, days) {
  const noon = (i) => data.start + i * DAY + DAY / 2;
  const keys = Array.from({ length: 7 }, (_, i) => isoFormat.format(noon(i)));
  const shown = keys.map((key, i) => ({ key, i })).filter(({ key, i }) => i < 5 || days.has(key));
  // La grille s'arrête aux heures de cours réelles : la hauteur sert au texte, pas au vide.
  const hasCourses = data.courses.length > 0;
  const first = hasCourses ? Math.min(...data.courses.map((c) => Math.floor(minutes(c.start) / 60))) : DEFAULT_FIRST_HOUR;
  const last = hasCourses ? Math.max(...data.courses.map((c) => Math.ceil(minutes(c.end) / 60))) : DEFAULT_LAST_HOUR;
  const shortest = Math.min(...data.courses.map((c) => (c.end - c.start) / 60_000));
  const scale = hasCourses ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, READABLE_HEIGHT / shortest)) : MIN_SCALE;
  const now = Date.now();
  const today = isoFormat.format(now);
  const nowMinutes = minutes(now);
  const hours = Array.from({ length: last - first }, (_, i) => first + i);

  const block = ({ course: c, lane, lanes }) => withVars(
    h('button', {
      type: 'button',
      class: `event${c.type === 'Examen' ? ' exam' : ''}${c.place === 'Distanciel' ? ' remote' : ''}`,
      title: [c.name, c.place, c.teacher].filter(Boolean).join(', '),
      onclick: () => showCourse(c),
    },
    h('span', { class: 'name' }, c.name),
    h('span', { class: 'meta hours' }, `${time(c.start)} à ${time(c.end)}`),
    c.place && h('span', { class: 'meta place' }, c.place),
    c.type === 'Examen' && h('span', { class: 'meta' }, 'Examen')),
    { '--start': minutes(c.start) - first * 60, '--length': (c.end - c.start) / 60_000, '--lane': lane, '--lanes': lanes },
  );

  const column = ({ key }) => h('div', { class: 'week-day', 'data-today': key === today ? 'true' : null },
    laneLayout(days.get(key) ?? []).map(block),
    key === today && nowMinutes >= first * 60 && nowMinutes <= last * 60
      && withVars(h('div', { class: 'now', 'aria-hidden': 'true' }), { '--start': nowMinutes - first * 60 }));

  return withVars(h('div', { class: 'only-wide week' },
    h('div'),
    shown.map(({ key, i }) => h('div', { class: 'week-head', 'aria-current': key === today ? 'date' : null }, capitalize(weekdayFormat.format(noon(i))))),
    h('div', { class: 'week-hours' }, hours.map((hour) => h('div', { class: 'small muted num' }, `${hour} h`))),
    shown.map(column)),
  { '--days': shown.length, '--hours': hours.length, '--scale': scale });
}

const gradeText = (v) => String(v).replace('.', ',');

/** Moyenne affichée : la définitive, sinon celle du contrôle continu. */
const subjectValue = (subject) => subject.average ?? subject.ccAverage;

/** Barre sur 20, avec un repère à 10. La note est toujours écrite à côté : la couleur n'est qu'un appui. */
function gradeBar(value, provisional) {
  const state = `${provisional ? ' provisional' : ''}${value < 10 ? ' low' : ''}`;
  return withVars(h('span', { class: `bar${state}`, 'aria-hidden': 'true' }, h('span', { class: 'bar-fill' })), { '--value': Math.min(value, 20) / 20 });
}

const NOTE_SORTS = {
  matiere: { label: 'Matière, de A à Z', compare: (a, b) => a.name.localeCompare(b.name, 'fr') },
  haute: { label: 'Meilleures moyennes', compare: (a, b) => (subjectValue(b) ?? -1) - (subjectValue(a) ?? -1) },
  basse: { label: 'Moyennes les plus basses', compare: (a, b) => (subjectValue(a) ?? 21) - (subjectValue(b) ?? 21) },
  ects: { label: 'Plus de crédits ECTS', compare: (a, b) => (b.ects ?? 0) - (a.ects ?? 0) },
};

let noteSort = 'matiere';

function showSubject(subject) {
  const { dialog, body } = showDialog(subject.name, facts([
    ['Moyenne', subject.average !== null && `${grade(subject.average)} / 20`],
    ['Contrôle continu', subject.ccAverage !== null && `${grade(subject.ccAverage)} / 20`],
    ['Examen', subject.exam && `${gradeText(subject.exam)} / 20`],
    ['Notes', subject.notes.length ? subject.notes.map(gradeText).join(' ; ') : 'Aucune pour le moment'],
    // Sans note, MyGes renvoie la même lettre partout : une valeur par défaut, pas un résultat.
    ['Mention', subjectValue(subject) !== null && subject.letter],
    ['ECTS', subject.ects !== null && String(subject.ects)],
    ['Coefficient', subject.coef !== null && String(subject.coef)],
    ['Absences', subject.absences > 0 && String(subject.absences)],
    ['Retards', subject.lates > 0 && String(subject.lates)],
    ['Intervenant', subject.teacher],
  ]));
  if (subject.rcId) addCourseExtras(subject.rcId, dialog, body);
}

function subjectRow(subject) {
  const value = subjectValue(subject);
  const provisional = subject.average === null;
  return h('li', {}, h('button', { type: 'button', class: 'course', onclick: () => showSubject(subject) },
    h('span', { class: 'grow' },
      h('span', { class: 'line name' }, subject.name),
      subject.teacher && h('span', { class: 'line muted small' }, subject.teacher),
      subject.notes.length > 0 && h('span', { class: 'line small num' }, `Notes : ${subject.notes.map(gradeText).join(' ; ')}`),
      value !== null && gradeBar(value, provisional)),
    h('span', { class: 'end num' },
      h('span', { class: 'line name' }, value === null ? 'Pas de note' : grade(value)),
      value !== null && provisional && h('span', { class: 'line muted small' }, 'Provisoire'))));
}

function gradesTable(subjects) {
  const line = (subject) => {
    const value = subjectValue(subject);
    const provisional = subject.average === null;
    return h('tr', {},
      h('th', { scope: 'row' },
        h('button', { type: 'button', class: 'link', onclick: () => showSubject(subject) }, subject.name),
        subject.teacher && h('div', { class: 'muted small' }, subject.teacher)),
      h('td', { class: 'num' }, subject.notes.map(gradeText).join(' ; ')),
      h('td', { class: 'num' }, subject.exam ? gradeText(subject.exam) : ''),
      h('td', { class: 'num average' },
        value !== null && h('div', {}, grade(value), provisional && h('span', { class: 'muted small' }, ' provisoire')),
        value !== null && gradeBar(value, provisional)),
      h('td', { class: 'num end' }, subject.ects === null ? '' : String(subject.ects)),
      h('td', { class: 'num end' }, subject.absences ? String(subject.absences) : ''));
  };
  return h('div', { class: 'only-wide table-frame' }, h('table', {},
    h('thead', {}, h('tr', {}, ['Matière', 'Notes', 'Examen', 'Moyenne', 'ECTS', 'Absences'].map((label) => h('th', { scope: 'col' }, label)))),
    h('tbody', {}, subjects.map(line))));
}

function semesterSummary(semester) {
  const final = semester.average !== null;
  const value = final ? semester.average : semester.provisional;
  const done = semester.subjects.filter((subject) => subject.average !== null).length;
  const progress = `${done} matière${done > 1 ? 's' : ''} sur ${semester.subjects.length} avec une moyenne définitive`;
  if (value === null) return h('p', { class: 'muted' }, 'Pas encore de note sur cette période.');
  return h('div', { class: 'summary' },
    h('dl', { class: 'metrics' }, h('div', {}, h('dd', {}, grade(value)), h('dt', {}, final ? 'Moyenne générale' : 'Moyenne provisoire, contrôle continu'))),
    gradeBar(value, !final),
    h('p', { class: 'muted small' }, progress));
}

async function notesView() {
  const semesters = await load('/api/notes');
  if (!semesters.length) return empty('Aucune note pour le moment.');

  let selected = semesters.at(-1);
  const holder = h('div', { class: 'stack' });
  const show = () => {
    const subjects = [...selected.subjects].sort(NOTE_SORTS[noteSort].compare);
    holder.replaceChildren(semesterSummary(selected), h('ul', { class: 'rows only-narrow' }, subjects.map(subjectRow)), gradesTable(subjects));
  };
  const field = (id, label, control) => h('div', {}, h('label', { for: id }, label), control);
  const period = h('select', {
    id: 'semestre',
    onchange: (e) => {
      selected = semesters[Number(e.target.value)];
      show();
    },
  }, semesters.map((s, i) => h('option', { value: String(i), selected: s === selected }, s.name)));
  const sort = h('select', {
    id: 'tri',
    onchange: (e) => {
      noteSort = e.target.value;
      show();
    },
  }, Object.entries(NOTE_SORTS).map(([id, option]) => h('option', { value: id, selected: id === noteSort }, option.label)));
  show();
  return [h('div', { class: 'filters' }, semesters.length > 1 && field('semestre', 'Période', period), field('tri', 'Trier par', sort)), holder];
}

const monthFormat = new Intl.DateTimeFormat('fr-FR', { ...paris, month: 'long', year: 'numeric' });
let absenceTab = 'toutes';

/** Boutons de filtre : largeur de leur texte, jamais étirés. */
function filterChips(label, options, selected, onChange) {
  const buttons = new Map();
  const mark = (value) => {
    for (const [id, button] of buttons) button.setAttribute('aria-pressed', String(id === value));
  };
  for (const [id, text] of options) {
    buttons.set(id, h('button', { type: 'button', class: 'tab', onclick: () => { mark(id); onChange(id); } }, text));
  }
  mark(selected);
  return h('div', { class: 'chips', role: 'group', 'aria-label': label }, [...buttons.values()]);
}

function absenceHistory(items, total, unjustified) {
  if (!total) return empty('Aucune absence enregistrée cette année.');
  const list = h('div', { class: 'stack' });
  const show = () => {
    const shown = absenceTab === 'toutes' ? items : items.filter((a) => !a.justified);
    const months = new Map();
    for (const a of shown) {
      const key = capitalize(monthFormat.format(a.date));
      months.set(key, [...(months.get(key) ?? []), a]);
    }
    list.replaceChildren(...(shown.length
      ? [...months].map(([month, entries]) => h('section', { class: 'stack' },
        h('h3', { class: 'day-title' }, `${month} (${entries.length})`),
        h('ul', { class: 'rows' }, entries.map((a) => h('li', {},
          h('div', { class: 'grow' }, h('div', { class: 'name' }, a.course), h('div', { class: 'muted small' }, dateFormat.format(a.date))),
          h('span', { class: `status small ${a.justified ? 'ok' : 'danger'}` }, a.justified ? 'Justifiée' : 'Non justifiée'))))))
      : [empty('Toutes tes absences sont justifiées.')]));
  };
  show();
  return h('div', { class: 'stack' },
    filterChips('Filtrer les absences', [['toutes', `Toutes (${total})`], ['injustifiees', `Non justifiées (${unjustified})`]], absenceTab, (id) => { absenceTab = id; show(); }),
    list);
}

async function absencesView() {
  const { total, unjustified, lates, items, subjects } = await load('/api/absences');
  const stat = (value, label, danger) => h('div', {}, h('dd', { class: danger ? 'danger' : '' }, String(value)), h('dt', {}, label));
  return [
    h('dl', { class: 'metrics stats' },
      stat(unjustified, 'Non justifiées', unjustified > 0),
      stat(total - unjustified, 'Justifiées'),
      stat(lates, 'Retards')),
    h('div', { class: 'home' },
      section('Historique', absenceHistory(items, total, unjustified)),
      subjects.length > 0 && section('Par matière', h('div', { class: 'table-frame' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Matière'), h('th', { scope: 'col', class: 'end' }, 'Absences'), h('th', { scope: 'col', class: 'end' }, 'Retards'))),
        h('tbody', {}, subjects.map((subject) => h('tr', {},
          h('th', { scope: 'row' }, subject.name),
          h('td', { class: 'num end' }, String(subject.absences)),
          h('td', { class: 'num end' }, String(subject.lates))))))))),
  ];
}

async function projectsView() {
  const items = await load('/api/projets');
  if (!items.length) return empty('Aucun projet ni TP pour le moment.');

  const running = items.filter((p) => p.date !== null);
  const finished = items.filter((p) => p.date === null);
  const holder = h('div', { class: 'column' });
  const show = (query = '') => {
    const needle = query.trim().toLocaleLowerCase('fr');
    const match = (p) => `${p.name} ${p.course}`.toLocaleLowerCase('fr').includes(needle);
    const active = running.filter(match);
    const done = finished.filter(match);
    holder.replaceChildren(...[
      section(`En cours (${active.length})`, active.length
        ? h('ul', { class: 'project-grid' }, active.map(projectCard))
        : empty(needle ? 'Aucun projet en cours ne correspond.' : 'Aucun projet en cours.')),
      done.length > 0 && section(`Terminés (${done.length})`, h('ul', { class: 'rows' }, done.map(deadlineRow))),
    ].filter(Boolean));
  };
  show();
  const search = h('input', { id: 'recherche-projet', type: 'search', oninput: (e) => show(e.target.value) });
  return [
    items.length > 5 && h('div', { class: 'narrow-field' }, h('label', { for: 'recherche-projet' }, 'Rechercher un projet'), search),
    holder,
  ];
}

function stepState(step, nextDate) {
  if (step.date === nextDate) return { name: 'next', label: 'Prochaine étape' };
  return step.date < Date.now() ? { name: 'past', label: 'Terminée' } : { name: 'future', label: 'À venir' };
}

/** Demande confirmation avant une vraie action sur MyGES. */
function confirmAction(title, text, label, run) {
  const { dialog, body } = showDialog(title, h('p', { class: 'body-text' }, text));
  const error = h('p', { class: 'field-error', role: 'alert', hidden: true });
  const accept = h('button', {
    type: 'button',
    class: 'primary',
    onclick: async () => {
      accept.disabled = true;
      try {
        await run();
        dialog.close();
      } catch (e) {
        if (e.status === 401) return;
        error.textContent = e.message;
        error.hidden = false;
        accept.disabled = false;
      }
    },
  }, label);
  body.append(error, accept);
}

function teamsSection(p) {
  const change = async (team, action) => {
    await post(`/api/projets/${p.id}/equipes/${team.id}/${action}`);
    cache.clear(); // projets, accueil : tout ce qui citait l'ancienne équipe
    render();
  };
  const row = (team) => {
    const size = p.groupSize.max ? `${team.members.length} / ${p.groupSize.max}` : String(team.members.length);
    const action = team.mine
      ? p.canLeave && h('button', {
        type: 'button',
        'aria-label': `Quitter ${team.name}`,
        onclick: () => confirmAction(`Quitter ${team.name} ?`, 'Tu quitteras vraiment cette équipe sur MyGES, et l\'action apparaîtra dans son journal.', 'Quitter l\'équipe', () => change(team, 'quitter')),
      }, 'Quitter')
      : p.canJoin && !team.full && h('button', {
        type: 'button',
        'aria-label': `Rejoindre ${team.name}`,
        onclick: () => confirmAction(`Rejoindre ${team.name} ?`, 'Tu rejoindras vraiment cette équipe sur MyGES, et l\'action apparaîtra dans son journal.', 'Rejoindre l\'équipe', () => change(team, 'rejoindre')),
      }, 'Rejoindre');
    return h('li', {},
      h('div', { class: 'grow' },
        h('div', { class: 'name' }, team.name, team.mine && ' ', team.mine && h('span', { class: 'tag' }, 'Mon équipe')),
        h('div', { class: 'small' }, team.members.join(', ') || 'Aucun membre')),
      h('div', { class: 'end team-side' }, h('span', { class: 'small muted num' }, team.full ? `Complet, ${size}` : size), action));
  };

  const list = h('ul', { class: 'rows' });
  const show = (query = '') => {
    const needle = query.trim().toLocaleLowerCase('fr');
    const found = p.teams.filter((team) => `${team.name} ${team.members.join(' ')}`.toLocaleLowerCase('fr').includes(needle));
    list.replaceChildren(...found.map(row));
    if (!found.length) list.replaceChildren(h('li', { class: 'muted' }, 'Aucune équipe ne correspond.'));
  };
  show();
  const search = h('input', { id: 'recherche-equipe', type: 'search', oninput: (e) => show(e.target.value) });
  return h('details', { open: p.canJoin },
    h('summary', {}, `Équipes (${p.teams.length})`),
    h('div', { class: 'stack' },
      p.teams.length > 5 && h('div', {}, h('label', { for: 'recherche-equipe' }, 'Chercher une équipe ou un étudiant'), search),
      list));
}

async function projectView(title, id) {
  const p = await load(`/api/projets/${encodeURIComponent(id ?? '')}`);
  title.textContent = p.name;
  const zone = h('div', { class: 'column' });
  const fileButton = (kind, file) => {
    const button = h('button', {
      type: 'button',
      'aria-label': `Télécharger ${file.title}`,
      onclick: () => downloadFile(`/api/projets/${p.id}/${kind}/${file.id}`, file.fileName, button, zone),
    }, 'Télécharger');
    return button;
  };
  const fileRow = (kind, file) => h('li', {},
    h('div', { class: 'grow' }, h('div', { class: 'name' }, file.title), file.date && h('div', { class: 'muted small' }, dateFormat.format(file.date))),
    fileButton(kind, file));

  const nextDate = p.steps.find((step) => step.date >= Date.now())?.date;
  const timeline = h('ol', { class: 'timeline' }, p.steps.map((step) => {
    const state = stepState(step, nextDate);
    return h('li', { class: state.name },
      h('h3', {}, step.type),
      h('p', { class: 'small' }, `${dateFormat.format(step.date)}, ${state.label.toLowerCase()}${state.name === 'past' ? '' : ` (${relative(step.date)})`}`),
      step.desc && h('p', { class: 'body-text small' }, step.desc),
      step.files.length
        ? h('ul', { class: 'rows' }, step.files.map((file) => fileRow('depots', file)))
        : p.group && h('p', { class: 'muted small' }, 'Aucun dépôt de ton groupe.'));
  }));

  const size = p.groupSize.min && p.groupSize.max
    ? (p.groupSize.min === p.groupSize.max ? plural(p.groupSize.min, 'personne') : `${p.groupSize.min} à ${p.groupSize.max} personnes`)
    : '';
  const group = p.group
    ? section('Mon groupe',
      facts([
        ['Nom', p.group.name],
        ['Membres', p.group.members.join(', ')],
        ['Sujet', p.group.subjectValidated ? 'Validé' : 'Pas encore validé'],
        ['Soutenance', p.group.presentation && dateFormat.format(p.group.presentation)],
      ]),
      p.group.teacherComment && section('Commentaire de l\'enseignant', h('p', { class: 'body-text' }, p.group.teacherComment)))
    : section('Mon groupe', h('p', { class: 'danger' }, 'Tu n\'es dans aucun groupe pour ce projet.'), p.canJoin && h('p', { class: 'muted small' }, 'Choisis une équipe dans la liste.'));

  zone.append(...[
    p.teams.length > 0 && teamsSection(p),
    p.goal && section('Objectif', h('p', { class: 'body-text' }, p.goal)),
    p.plan && section('Programme', h('p', { class: 'body-text' }, p.plan)),
    section('Étapes', p.steps.length ? timeline : empty('Aucune étape annoncée.')),
    p.files.length > 0 && section('Fichiers du projet', h('ul', { class: 'rows' }, p.files.map((file) => fileRow('consignes', file)))),
  ].filter(Boolean));

  return [
    h('a', { href: '#projets', class: 'small' }, 'Tous les projets'),
    h('div', { class: 'project-page' },
      zone,
      h('div', { class: 'column' },
        section('Informations', facts([
          ['Matière', p.course],
          ['Nature', p.practical ? 'Travail pratique' : 'Projet'],
          ['Enseignant', p.teacher],
          ['Sujet', p.subjectType],
          ['Groupes', p.groupType],
          ['Taille', size],
          ['Outils', p.tools],
          ['Bibliographie', p.books],
        ])),
        group,
        p.activity.length > 0 && h('details', {}, h('summary', {}, `Activité du groupe (${p.activity.length})`),
          h('ul', { class: 'activity' }, p.activity.map((event) => h('li', {},
            h('span', { class: 'small' }, [event.author, event.text].filter(Boolean).join(' ')),
            event.date && h('span', { class: 'muted small line' }, dateFormat.format(event.date)))))))),
  ];
}

async function newsView() {
  const items = await load('/api/news');
  if (!items.length) return empty('Aucune actualité.');
  return h('ul', { class: 'rows' }, items.map((n) => h('li', {}, h('article', { class: 'grow' },
    h('h2', {}, n.title),
    n.date && h('p', { class: 'muted small' }, dateFormat.format(n.date)),
    n.body && h('p', { class: 'body-text clamp' }, n.body),
    n.body.length > 220 && h('button', { type: 'button', class: 'link', onclick: () => showDialog(n.title, n.date && h('p', { class: 'muted small' }, dateFormat.format(n.date)), h('p', { class: 'body-text' }, n.body)) }, 'Lire la suite')))));
}

let openFolder = '';

const fileExtension = (file) => file.fileName.match(/\.([a-z0-9]{1,5})$/i)?.[1].toUpperCase() ?? 'Fichier';

async function documentsView() {
  const sources = await load('/api/documents');
  // Tous les dossiers à la fois : leurs effectifs, les derniers ajouts et la recherche en ont besoin.
  const folders = await Promise.all(sources.map(async (source) => ({ ...source, files: await load(`/api/documents/${source.id}`).catch((e) => (e.status === 401 ? Promise.reject(e) : null)) })));
  const explorer = h('div', { class: 'explorer' });
  const pane = h('div', { class: 'files stack' });
  const buttons = {};
  let category = '';

  const fileRow = (folder, file, showFolder) => {
    const action = h('span', { class: 'file-action small' }, 'Télécharger');
    const row = h('button', {
      type: 'button',
      class: 'file',
      'aria-label': `Télécharger ${file.title}`,
      onclick: () => downloadFile(`/api/documents/${folder.id}/${file.id}`, file.fileName, row, pane, action),
    },
    h('span', { class: 'tag file-type' }, fileExtension(file)),
    h('span', { class: 'file-info' },
      h('span', { class: 'line name' }, file.title),
      h('span', { class: 'line muted small' }, [showFolder && folder.name, file.date && dateFormat.format(file.date)].filter(Boolean).join(', '))),
    action);
    return h('li', { class: 'flush' }, row);
  };
  const flat = () => folders.flatMap((folder) => (folder.files ?? []).map((file) => ({ folder, file })));
  const markOpen = (id) => {
    for (const [key, button] of Object.entries(buttons)) {
      if (key === id) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    }
  };

  const showRecent = () => {
    openFolder = '';
    markOpen('');
    explorer.removeAttribute('data-open');
    const recent = flat().filter(({ file }) => file.date).sort((a, b) => b.file.date - a.file.date).slice(0, 6);
    pane.replaceChildren(h('h2', {}, 'Derniers ajouts'), recent.length
      ? h('ul', { class: 'rows' }, recent.map(({ folder, file }) => fileRow(folder, file, true)))
      : empty('Choisis un dossier.'));
  };

  const showFolder = (folder) => {
    openFolder = folder.id;
    markOpen(folder.id);
    explorer.setAttribute('data-open', 'true');
    const back = h('button', { type: 'button', class: 'only-narrow', onclick: showRecent }, 'Tous les dossiers');
    const heading = h('h2', {}, folder.name);
    if (!folder.files) return pane.replaceChildren(back, heading, h('p', { class: 'field-error', role: 'alert' }, 'Ce dossier est indisponible pour le moment.'));

    const categories = [...new Set(folder.files.map((file) => file.category).filter(Boolean))];
    const list = h('div', { class: 'stack' });
    const showCategory = () => {
      const shown = folder.files.filter((file) => !category || file.category === category);
      const groups = new Map();
      for (const file of shown) groups.set(file.category, [...(groups.get(file.category) ?? []), file]);
      list.replaceChildren(...(shown.length
        ? [...groups].map(([name, items]) => h('section', { class: 'stack' }, name && h('h3', { class: 'day-title' }, `${name} (${items.length})`), h('ul', { class: 'rows' }, items.map((file) => fileRow(folder, file, false)))))
        : [empty('Aucun document ici.')]));
    };
    category = '';
    showCategory();
    const filters = categories.length > 1 && filterChips('Filtrer par catégorie', [['', 'Tout'], ...categories.map((name) => [name, name])], '', (id) => { category = id; showCategory(); });
    pane.replaceChildren(...[back, heading, filters, list].filter(Boolean));
  };

  const showResults = (query) => {
    const needle = query.trim().toLocaleLowerCase('fr');
    if (!needle) return openFolder ? showFolder(folders.find((f) => f.id === openFolder)) : showRecent();
    const found = flat().filter(({ file }) => file.title.toLocaleLowerCase('fr').includes(needle)).slice(0, 40);
    explorer.setAttribute('data-open', 'true');
    pane.replaceChildren(h('h2', {}, plural(found.length, 'résultat')), found.length
      ? h('ul', { class: 'rows' }, found.map(({ folder, file }) => fileRow(folder, file, true)))
      : empty('Aucun fichier ne correspond.'));
  };

  const search = h('input', { id: 'recherche', type: 'search', oninput: (e) => showResults(e.target.value) });
  explorer.append(
    h('div', { class: 'stack' },
      h('div', {}, h('label', { for: 'recherche' }, 'Rechercher un document'), search),
      h('ul', { class: 'folders rows' }, folders.map((folder) => {
        const count = folder.files ? plural(folder.files.length, 'fichier') : 'Indisponible';
        buttons[folder.id] = h('button', { type: 'button', onclick: () => showFolder(folder) },
          h('span', { class: 'name' }, folder.name),
          h('span', { class: 'muted small' }, [folder.hint, count].filter(Boolean).join(', ')));
        return h('li', { class: 'flush' }, buttons[folder.id]);
      }))),
    pane);

  const previous = folders.find((folder) => folder.id === openFolder);
  if (previous) showFolder(previous);
  else showRecent();
  return explorer;
}

// --- Démarrage ---

window.addEventListener('hashchange', () => {
  if (main?.isConnected) render();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setMenu(false);
  if (!main?.isConnected || currentView !== 'agenda' || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target?.tagName)) return;
  if (e.key === 'ArrowLeft') stepWeek(-7);
  if (e.key === 'ArrowRight') stepWeek(7);
});

api('/api/session').then(({ name }) => showShell(name), (e) => {
  if (e.status !== 401) showLogin(e.message);
});
