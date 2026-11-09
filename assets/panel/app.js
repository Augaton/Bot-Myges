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
// MyGES enregistre parfois une échéance sans heure, à minuit (UTC ou Paris) : date seule alors.
const hasTime = (t) => t % DAY !== 0 && time(t) !== '00:00';
const deadline = (t, format = shortFormat) => (hasTime(t) ? `${format.format(t)} à ${time(t)}` : format.format(t));
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
let cacheEpoch = 0;

/** Vide le cache. Une réponse encore en route à cet instant ne sera pas gardée. */
function clearCache() {
  cacheEpoch++;
  cache.clear();
}

async function load(path) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const epoch = cacheEpoch;
  const data = await api(path);
  if (epoch === cacheEpoch) cache.set(path, { at: Date.now(), data });
  return data;
}

/** Télécharge un fichier depuis un bouton ; une erreur s'affiche dans `zone`. */
async function downloadFile(path, fileName, button, zone, status = button) {
  const label = status.textContent;
  button.disabled = true;
  status.textContent = 'Envoi…';
  zone.querySelector('[role="alert"]')?.remove();
  try {
    const res = await api(`${path}${path.includes('?') ? '&' : '?'}name=${encodeURIComponent(fileName)}`);
    const url = URL.createObjectURL(await res.blob());
    h('a', { href: url, download: fileName }).click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    if (e.status !== 401) {
      const notice = h('p', { class: 'field-error', role: 'alert' }, e.message);
      zone.prepend(notice);
      notice.scrollIntoView({ block: 'nearest' });
    }
  }
  button.disabled = false;
  status.textContent = label;
}

// --- Connexion ---

function showLogin(message = '') {
  clearCache();
  setSchoolYear('');
  const error = h('p', { class: 'field-error', role: 'alert', hidden: !message }, message);
  const username = h('input', { id: 'username', name: 'username', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true, maxlength: 100 });
  const password = h('input', { id: 'password', name: 'password', type: 'password', autocomplete: 'current-password', required: true, maxlength: 200 });
  const remember = h('input', { id: 'remember', name: 'remember', type: 'checkbox' });
  const submit = h('button', { type: 'submit', class: 'primary' }, 'Se connecter');

  const form = h('form', {
    onsubmit: async (event) => {
      event.preventDefault();
      submit.disabled = true;
      submit.textContent = 'Connexion…';
      error.hidden = true;
      try {
        const { name } = await post('/api/login', { username: username.value, password: password.value, remember: remember.checked === true });
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
  h('div', {},
    h('label', { class: 'check', for: 'remember' }, remember, h('span', {}, 'Rester connecté sur cet appareil')),
    h('p', { class: 'muted small' }, 'À éviter sur un ordinateur partagé.')),
  submit);

  root.replaceChildren(h('div', { class: 'login' }, h('div', { class: 'login-box' },
    h('div', {}, h('h1', {}, 'Panel étudiant'), h('p', { class: 'muted' }, 'Ton agenda, tes notes et tes documents au même endroit.')),
    form,
    h('p', { class: 'notice' }, 'Service non officiel, sans lien avec MyGES ni le Réseau GES. Ton mot de passe sert une seule fois à vérifier ton compte auprès de MyGES : il n\'est jamais enregistré. Si tu restes connecté, seul un jeton chiffré est gardé sur le serveur, jusqu\'à son expiration.'))));
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
  annuaire: { label: 'Annuaire', render: directoryView },
  evenements: { label: 'Événements', render: eventsScreen },
  projet: { label: 'Projet', render: projectView, parent: 'projets' },
  profil: { label: 'Mon profil', render: profileView, parent: 'accueil' },
};

// Sur téléphone, ces écrans sont dans la barre du bas ; les autres, sous « Plus ».
const PRIMARY = ['accueil', 'agenda', 'notes', 'projets'];
const SKELETON_DELAY_MS = 150;

let main;
let plus;
let links = {};
let userName = '';
let renderId = 0;
// Chrome et Edge proposent l'installation par cet évènement, à garder pour un clic de l'utilisateur.
let installPrompt = null;
let currentView = '';
let currentPage = '';
// Position de défilement de chaque page : deux projets n'ont pas la même.
const scrolls = {};
// Partie de l'écran à montrer à la première visite d'une page, choisie par sa vue.
let scrollTarget = null;

const setMenu = (open) => plus?.setAttribute('aria-expanded', String(open));

function showShell(name) {
  userName = name;
  let touch = null;
  main = h('main', {
    id: 'contenu',
    onclick: () => setMenu(false),
    ontouchstart: (e) => { touch = e.touches[0]; },
    ontouchend: (e) => {
      const end = e.changedTouches[0];
      const dx = end.clientX - (touch?.clientX ?? end.clientX);
      const dy = end.clientY - (touch?.clientY ?? end.clientY);
      // Un geste nettement horizontal : ne pas gêner le défilement de la page.
      if (currentView === 'agenda' && Math.abs(dx) > 70 && Math.abs(dx) > 2 * Math.abs(dy)) stepAgenda(dx < 0 ? 1 : -1);
    },
  });
  links = Object.fromEntries(Object.entries(VIEWS).filter(([, view]) => !view.parent).map(([id, view]) => [id, h('a', { href: `#${id}` }, view.label)]));
  const logout = h('button', {
    type: 'button',
    onclick: async () => {
      let failure = null;
      await post('/api/logout').catch((e) => { if (e.status !== 401) failure = e; });
      if (failure) {
        // Le cookie ne s'efface que côté serveur : surtout ne pas faire croire que c'est fait.
        main.querySelector('[role="alert"]')?.remove();
        main.prepend(h('p', { class: 'field-error', role: 'alert' }, `La déconnexion a échoué, ta session reste ouverte. ${failure.message}`));
        window.scrollTo(0, 0);
        return;
      }
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
      h('header', { class: 'top' }, h('span', { class: 'brand' }, 'Panel étudiant'), h('a', { class: 'who', href: '#profil', 'aria-label': `Mon profil, ${name}` }, avatar({ id: 'moi', name }), h('span', {}, name))),
      h('nav', { 'aria-label': 'Navigation' },
        PRIMARY.map((id) => links[id]),
        plus,
        h('div', { class: 'more', id: 'plus-menu' },
          Object.keys(links).filter((id) => !PRIMARY.includes(id)).map((id) => links[id]),
          logout))),
    main));
  render();
}

/**
 * Pastille d'une personne : ses initiales, recouvertes par sa photo si elle se charge.
 * Le nom est toujours écrit à côté : l'image n'apporte rien aux lecteurs d'écran.
 */
function avatar(person) {
  const initials = person.name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join('').toUpperCase();
  const photo = person.id && h('img', { src: `/api/photos/${person.id}`, alt: '', loading: 'lazy', decoding: 'async', onerror: () => photo.remove() });
  return h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials, photo);
}

const peopleList = (members) => h('ul', { class: 'people' }, members.map((person) => h('li', {}, avatar(person), h('span', {}, person.name))));

const skeleton = () => h('div', { class: 'skeleton', 'aria-label': 'Chargement' }, h('div'), h('div'), h('div'));

async function render() {
  const [route, param, tab] = location.hash.slice(1).split('/');
  const id = VIEWS[route] ? route : 'accueil';
  const active = VIEWS[id].parent ?? id;
  const current = ++renderId;
  if (currentView) scrolls[currentPage] = window.scrollY;
  currentView = id;
  currentPage = location.hash;
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
    const content = await VIEWS[id].render(title, param, tab);
    if (current !== renderId) return; // l'étudiant a changé de page entre-temps
    clearTimeout(waiting);
    main.replaceChildren(title, ...[content].flat().filter(Boolean));
    const saved = scrolls[currentPage];
    window.scrollTo(0, saved ?? 0);
    title.focus({ preventScroll: true });
    if (saved === undefined) scrollTarget?.scrollIntoView({ block: 'start' });
    scrollTarget = null;
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
async function addCourseExtras(rcId, dialog, body, year = '') {
  const [sources, syllabus] = await Promise.all([
    load(year ? `/api/documents?year=${year}` : '/api/documents').catch(() => []),
    load(`/api/courses/${rcId}/syllabus`).catch(() => null),
  ]);
  if (!dialog.isConnected) return;
  if (sources.some((source) => source.id === rcId)) {
    body.append(h('button', {
      type: 'button',
      onclick: () => {
        setSchoolYear(year); // les supports de l'année de ce cours
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

// En jours de calendrier, heure de Paris : un cours à 14 h vu à 10 h a lieu aujourd'hui.
const calendarDay = (t) => Date.parse(isoFormat.format(t)) / DAY;

function relative(date) {
  const days = calendarDay(date) - calendarDay(Date.now());
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
        : [h('span', { class: `line ${soon ? 'danger' : ''}` }, relative(p.date)), h('span', { class: 'line muted' }, deadline(p.date))])));
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
      h('span', { class: 'line small muted' }, `${p.type}, ${deadline(p.date)}`),
      p.group === null
        ? h('span', { class: 'line small danger' }, 'Pas encore de groupe')
        : h('span', { class: 'line small muted' }, p.group))));
}

// --- Écrans ---

/** Lignes d'un bloc de l'accueil ; un bloc en panne le dit au lieu de disparaître. */
const homeBlock = (title, items, row, emptyText, link) => section(title,
  !items ? unavailable() : items.length ? h('ul', { class: 'rows' }, items.map(row)) : empty(emptyText),
  items && link);

function showEvent(event) {
  const open = event.subscribeUntil && event.subscribeUntil >= Date.now();
  showDialog(event.title, facts([
    ['Date', day(event.date)],
    ['Heure', time(event.date)],
    ['Lieu', event.location],
    ['Type', event.type],
    ['Organisateur', event.organizer],
    ['Inscription', event.subscribed ? 'Tu es inscrit' : open ? `Sur MyGES, jusqu'au ${shortFormat.format(event.subscribeUntil)}` : ''],
  ]), event.description && h('p', { class: 'body-text' }, event.description));
}

const eventRow = (event) => h('li', {}, h('button', { type: 'button', class: 'course', onclick: () => showEvent(event) },
  h('span', { class: 'grow' },
    h('span', { class: 'line name' }, event.title),
    event.location && h('span', { class: 'line muted small' }, event.location),
    event.subscribed && h('span', { class: 'line small ok' }, 'Tu es inscrit')),
  h('span', { class: 'end small' }, h('span', { class: 'line' }, shortFormat.format(event.date)), h('span', { class: 'line muted' }, time(event.date)))));

let eventTab = 'avenir';

async function eventsScreen() {
  const { upcoming, past } = await load('/api/evenements');
  if (!upcoming.length && !past.length) return empty('Aucun événement pour le moment.');
  const list = h('div', { class: 'stack' });
  const show = () => {
    const events = eventTab === 'avenir' ? upcoming : past;
    const months = new Map();
    for (const event of events) {
      const key = capitalize(monthFormat.format(event.date));
      months.set(key, [...(months.get(key) ?? []), event]);
    }
    list.replaceChildren(...(events.length
      ? [...months].map(([month, items]) => h('section', { class: 'stack' }, h('h3', { class: 'day-title' }, `${month} (${items.length})`), h('ul', { class: 'rows' }, items.map(eventRow))))
      : [empty(eventTab === 'avenir' ? 'Aucun événement à venir.' : 'Aucun événement passé.')]));
  };
  show();
  return [
    filterChips('Filtrer les événements', [['avenir', `À venir (${upcoming.length})`], ['passes', `Passés (${past.length})`]], eventTab, (id) => { eventTab = id; show(); }),
    list,
  ];
}

async function homeView(title) {
  const data = await load('/api/home');
  title.textContent = `Bonjour ${userName.split(' ')[0]}`;
  const now = Date.now();
  const todayKey = isoFormat.format(now);
  const courses = data.courses?.filter((c) => c.end > now) ?? null;
  const next = courses?.[0];
  const exam = courses?.find((c) => c.type === 'Examen');
  const isToday = (t) => isoFormat.format(t) === todayKey;

  const hero = !courses
    ? unavailable()
    : next
      ? h('button', { type: 'button', class: 'next', onclick: () => showCourse(next) },
        h('span', { class: 'small' }, next.start <= now ? 'Cours en cours' : isToday(next.start) ? 'Prochain cours' : `Prochain cours, ${relative(next.start)}`),
        h('span', { class: 'name' }, next.name),
        h('span', {}, next.start <= now ? `Jusqu'à ${time(next.end)}` : `${isToday(next.start) ? 'Aujourd\'hui' : day(next.start)} à ${time(next.start)}`),
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
  for (const c of courses?.slice(1, 7) ?? []) {
    const key = isoFormat.format(c.start);
    days.set(key, [...(days.get(key) ?? []), c]);
  }

  return [
    h('p', { class: 'muted' }, day(now)),
    hero,
    stats.length > 0 && h('dl', { class: 'metrics stats' }, stats),
    h('div', { class: 'home' },
      h('div', { class: 'column' },
        exam && section(`Prochain examen : ${day(exam.start)}, ${relative(exam.start)}`, h('ul', { class: 'rows' }, courseRow(exam, now))),
        days.size > 0 && section('Ensuite',
          [...days.values()].map((list) => h('div', { class: 'stack' },
            h('h3', { class: 'day-title' }, isToday(list[0].start) ? 'Aujourd\'hui' : day(list[0].start)),
            h('ul', { class: 'rows' }, list.map((c) => courseRow(c, now)))))),
        homeBlock('À rendre', data.deadlines?.slice(0, 3), deadlineRow, 'Rien à rendre pour le moment.', h('a', { href: '#projets', class: 'small' }, 'Tous les projets'))),
      h('div', { class: 'column' },
        homeBlock('Événements', data.events, eventRow, 'Aucun événement à venir.', h('a', { href: '#evenements', class: 'small' }, 'Tous les événements')),
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
  delete scrolls[currentPage];
  render();
}

const stepWeek = (days) => goToWeek(weekAt(days));

let agendaMode = 'semaine';
let agendaMonth = '';

function shiftMonth(month, delta) {
  const [year, index] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, index - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function goToMonth(month) {
  agendaMonth = month;
  delete scrolls[currentPage];
  render();
}

function stepAgenda(direction) {
  if (agendaMode === 'mois') goToMonth(shiftMonth(agendaMonth, direction));
  else stepWeek(7 * direction);
}

/** Calculs en UTC : un mois de calendrier ne dépend ni du fuseau ni du changement d'heure. */
const monthTitle = new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', month: 'long', year: 'numeric' });
const dayTitle = new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
const WEEKDAYS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

async function monthView() {
  const month = agendaMonth || isoFormat.format(Date.now()).slice(0, 7);
  agendaMonth = month;
  const data = await load(`/api/agenda?month=${month}`);
  const [year, index] = month.split('-').map(Number);
  const first = new Date(Date.UTC(year, index - 1, 1));
  const total = new Date(Date.UTC(year, index, 0)).getUTCDate();
  const offset = (first.getUTCDay() + 6) % 7;
  const today = isoFormat.format(Date.now());
  const count = Object.values(data.days).reduce((sum, day) => sum + day.count, 0);

  const cell = (number) => {
    const key = `${month}-${String(number).padStart(2, '0')}`;
    const info = data.days[key];
    const label = `${dayTitle.format(new Date(Date.UTC(year, index - 1, number)))}, ${info ? `${info.count} cours${info.exam ? ', avec examen' : ''}` : 'aucun cours'}`;
    return h('td', {}, h('button', {
      type: 'button',
      class: `day${info ? ' has-courses' : ''}${key === today ? ' today' : ''}`,
      'aria-label': label,
      onclick: () => {
        agendaMode = 'semaine';
        goToWeek(key);
      },
    },
    h('span', { class: 'day-number' }, String(number)),
    info && h('span', { class: 'day-count' }, `${info.count} cours`),
    info?.exam && h('span', { class: 'day-exam' }, 'Examen')));
  };

  const cells = [...Array.from({ length: offset }, () => h('td', {})), ...Array.from({ length: total }, (_, i) => cell(i + 1))];
  while (cells.length % 7) cells.push(h('td', {}));
  const rows = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(h('tr', {}, cells.slice(i, i + 7)));

  return [
    section(capitalize(monthTitle.format(first)),
      h('div', { class: 'toolbar' },
        h('button', { type: 'button', onclick: () => goToMonth(shiftMonth(month, -1)) }, 'Précédent'),
        h('button', { type: 'button', onclick: () => goToMonth(isoFormat.format(Date.now()).slice(0, 7)) }, 'Ce mois-ci'),
        h('button', { type: 'button', onclick: () => goToMonth(shiftMonth(month, 1)) }, 'Suivant'))),
    h('p', { class: 'muted' }, count ? `${count} cours ce mois-ci. Choisis un jour pour voir sa semaine.` : 'Aucun cours ce mois-ci.'),
    !count && data.next && h('div', { class: 'toolbar' }, h('button', { type: 'button', onclick: () => goToMonth(isoFormat.format(data.next).slice(0, 7)) }, `Prochain cours : ${shortFormat.format(data.next)}`)),
    h('table', { class: 'month' },
      h('thead', {}, h('tr', {}, WEEKDAYS.map((name) => h('th', { scope: 'col' }, name)))),
      h('tbody', {}, rows)),
  ];
}

/** Export vers le calendrier du téléphone ou de Google Agenda. */
function agendaExport() {
  const zone = h('section', { class: 'stack' });
  const button = h('button', { type: 'button', onclick: () => downloadFile('/api/agenda.ics', 'emploi-du-temps.ics', button, zone) }, 'Télécharger le fichier .ics');
  zone.append(
    h('h2', {}, 'Dans ton calendrier'),
    h('p', { class: 'muted small body-text' }, 'Les 12 prochaines semaines, à importer dans Google Agenda ou le calendrier de ton téléphone. C\'est une copie : réimporte-la si ton agenda change.'),
    h('p', { class: 'muted small body-text' }, 'Pour un calendrier qui se met à jour tout seul : la commande /abonnement sur Discord.'),
    h('div', { class: 'toolbar' }, button));
  return zone;
}

async function agendaView() {
  const switcher = filterChips('Affichage de l\'agenda', [['semaine', 'Semaine'], ['mois', 'Mois']], agendaMode, (id) => {
    agendaMode = id;
    // Le mois suit la semaine affichée : on ne perd pas sa place en changeant de vue.
    if (id === 'mois' && agendaStart) agendaMonth = isoFormat.format(agendaStart + DAY / 2).slice(0, 7);
    delete scrolls[currentPage];
    render();
  });
  const content = agendaMode === 'mois' ? await monthView() : await weekView();
  return [switcher, ...content, agendaExport()];
}

async function weekView() {
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
    days.size > 0 && h('div', { class: 'only-narrow stack' }, [...days].map(([key, courses]) => {
      const isToday = key === isoFormat.format(Date.now());
      const block = section(isToday ? 'Aujourd\'hui' : day(courses[0].start), h('ul', { class: 'rows' }, courses.map((c) => courseRow(c))));
      if (isToday) scrollTarget = block;
      return block;
    })),
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
  if (subject.rcId) addCourseExtras(subject.rcId, dialog, body, schoolYear);
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

// Année consultée dans Notes, Absences, Documents et Projets ; vide pour l'année en cours.
// Gardée dans l'onglet : recharger la page ne la perd pas. Oubliée à la déconnexion.
const YEAR_KEY = 'annee';
let schoolYear = (() => {
  try {
    const stored = sessionStorage.getItem(YEAR_KEY) ?? '';
    return /^\d{4}$/.test(stored) ? stored : '';
  } catch {
    return ''; // stockage refusé (navigation privée…) : l'année reste en mémoire
  }
})();

function setSchoolYear(year) {
  schoolYear = year;
  try {
    if (year) sessionStorage.setItem(YEAR_KEY, year);
    else sessionStorage.removeItem(YEAR_KEY);
  } catch {
    /* stockage refusé : sans conséquence */
  }
}
const yearLabel = (year) => `${year}-${Number(year) + 1}`;
const withYear = (path) => (schoolYear ? `${path}${path.includes('?') ? '&' : '?'}year=${schoolYear}` : path);

/** Choix de l'année ; absent quand MyGES n'en connaît qu'une. */
async function yearField() {
  const { current, years } = await load('/api/annees').catch((e) => (e.status === 401 ? Promise.reject(e) : { current: '', years: [] }));
  // Une liste connue qui ne contient plus l'année choisie : retour à l'année en cours.
  // Une liste indisponible ne doit pas, elle, changer en silence l'année affichée.
  if (schoolYear && years.length && !years.includes(schoolYear)) setSchoolYear('');
  if (years.length < 2) return schoolYear ? h('p', { class: 'muted small' }, `Année ${yearLabel(schoolYear)}`) : null;
  const select = h('select', {
    id: 'annee',
    onchange: (e) => {
      setSchoolYear(e.target.value === current ? '' : e.target.value);
      render();
    },
  }, years.map((year) => h('option', { value: year, selected: year === (schoolYear || current) }, year === current ? `${yearLabel(year)} (en cours)` : yearLabel(year))));
  return h('div', {}, h('label', { for: 'annee' }, 'Année'), select);
}

async function notesView() {
  const picker = await yearField();
  const semesters = await load(withYear('/api/notes'));
  if (!semesters.length) return [picker && h('div', { class: 'filters' }, picker), empty(schoolYear ? `Aucune note en ${yearLabel(schoolYear)}.` : 'Aucune note pour le moment.')];

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
  return [h('div', { class: 'filters' }, picker, semesters.length > 1 && field('semestre', 'Période', period), field('tri', 'Trier par', sort)), holder];
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
  if (!total) return empty(schoolYear ? `Aucune absence enregistrée en ${yearLabel(schoolYear)}.` : 'Aucune absence enregistrée cette année.');
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
  const picker = await yearField();
  const { total, unjustified, lates, items, subjects } = await load(withYear('/api/absences'));
  const stat = (value, label, danger) => h('div', {}, h('dd', { class: danger ? 'danger' : '' }, String(value)), h('dt', {}, label));
  return [
    picker && h('div', { class: 'filters' }, picker),
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
  const picker = await yearField();
  const items = await load(withYear('/api/projets'));
  if (!items.length) return [picker && h('div', { class: 'filters' }, picker), empty(schoolYear ? `Aucun projet ni TP en ${yearLabel(schoolYear)}.` : 'Aucun projet ni TP pour le moment.')];

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
    picker && h('div', { class: 'filters' }, picker),
    items.length > 5 && h('div', { class: 'narrow-field' }, h('label', { for: 'recherche-projet' }, 'Rechercher un projet'), search),
    holder,
  ];
}

function stepState(step, nextDate) {
  if (step.date === null) return { name: 'future', label: 'Date non fixée' };
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

let teamFilter = 'toutes';

/** Page « Équipes » d'un projet : qui est où, et où il reste de la place. */
function teamsPage(p) {
  const change = async (team, action) => {
    await post(`/api/projets/${p.id}/equipes/${team.id}/${action}`);
    clearCache(); // projets, accueil : tout ce qui citait l'ancienne équipe
    render();
  };
  const card = (team) => {
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
    return h('li', { class: `team-card${team.mine ? ' mine' : ''}` },
      h('div', { class: 'card-top' },
        h('span', { class: 'name' }, team.name),
        h('span', { class: 'small muted num' }, team.full ? `Complet, ${size}` : size)),
      team.mine && h('span', { class: 'small' }, 'Mon équipe'),
      team.members.length ? peopleList(team.members) : h('p', { class: 'muted small' }, 'Aucun membre'),
      action && h('div', { class: 'team-action' }, action));
  };

  const list = h('div', { class: 'stack' });
  let query = '';
  const filterable = p.teams.some((team) => !team.full) && Boolean(p.groupSize.max);
  const show = () => {
    const needle = query.trim().toLocaleLowerCase('fr');
    const found = p.teams.filter((team) => (teamFilter === 'toutes' || !filterable || !team.full)
      && `${team.name} ${team.members.map((m) => m.name).join(' ')}`.toLocaleLowerCase('fr').includes(needle));
    list.replaceChildren(found.length ? h('ul', { class: 'team-grid' }, found.map(card)) : empty('Aucune équipe ne correspond.'));
  };
  show();
  return h('div', { class: 'stack' },
    p.canJoin && h('p', { class: 'muted small' }, 'Tu n\'as pas encore d\'équipe : choisis-en une qui a de la place.'),
    h('div', { class: 'team-tools' },
      p.teams.length > 5 && h('div', { class: 'narrow-field' }, h('label', { for: 'recherche-equipe' }, 'Chercher une équipe ou un étudiant'),
        h('input', { id: 'recherche-equipe', type: 'search', oninput: (e) => { query = e.target.value; show(); } })),
      filterable && filterChips('Filtrer les équipes', [['toutes', 'Toutes'], ['libres', 'Avec de la place']], teamFilter, (id) => { teamFilter = id; show(); })),
    list);
}

/** Page « Informations » d'un projet. */
function projectInfoPage(p) {
  const zone = h('div', { class: 'column' });
  const fileRow = (kind, file) => {
    const button = h('button', {
      type: 'button',
      'aria-label': `Télécharger ${file.title}`,
      onclick: () => downloadFile(withYear(`/api/projets/${p.id}/${kind}/${file.id}`), file.fileName, button, zone),
    }, 'Télécharger');
    return h('li', {},
      h('div', { class: 'grow' }, h('div', { class: 'name' }, file.title), file.date && h('div', { class: 'muted small' }, dateFormat.format(file.date))),
      button);
  };

  const nextDate = p.steps.find((step) => step.date >= Date.now())?.date;
  const timeline = h('ol', { class: 'timeline' }, p.steps.map((step) => {
    const state = stepState(step, nextDate);
    return h('li', { class: state.name },
      h('h3', {}, step.type),
      h('p', { class: 'small' }, step.date === null ? state.label : `${deadline(step.date, dateFormat)}, ${state.label.toLowerCase()}${state.name === 'past' ? '' : ` (${relative(step.date)})`}`),
      step.desc && h('p', { class: 'body-text small' }, step.desc),
      step.files.length
        ? h('ul', { class: 'rows' }, step.files.map((file) => fileRow('depots', file)))
        : p.group && h('p', { class: 'muted small' }, 'Aucun dépôt de ton groupe.'));
  }));

  const size = p.groupSize.min && p.groupSize.max
    ? (p.groupSize.min === p.groupSize.max ? plural(p.groupSize.min, 'personne') : `${p.groupSize.min} à ${p.groupSize.max} personnes`)
    : '';
  const teamsLink = h('a', { href: `#projet/${p.id}/equipes`, class: 'small' }, 'Voir toutes les équipes');
  const group = p.group
    ? section('Mon groupe',
      peopleList(p.group.members),
      facts([
        ['Nom', p.group.name],
        ['Sujet', p.group.subjectValidated ? 'Validé' : 'Pas encore validé'],
        ['Soutenance', p.group.presentation && dateFormat.format(p.group.presentation)],
      ]),
      p.group.teacherComment && section('Commentaire de l\'enseignant', h('p', { class: 'body-text' }, p.group.teacherComment)),
      teamsLink)
    : section('Mon groupe', h('p', { class: 'danger' }, 'Tu n\'es dans aucun groupe pour ce projet.'), teamsLink);

  zone.append(...[
    p.goal && section('Objectif', h('p', { class: 'body-text' }, p.goal)),
    p.plan && section('Programme', h('p', { class: 'body-text' }, p.plan)),
    section('Étapes', p.steps.length ? timeline : empty('Aucune étape annoncée.')),
    p.files.length > 0 && section('Fichiers du projet', h('ul', { class: 'rows' }, p.files.map((file) => fileRow('consignes', file)))),
  ].filter(Boolean));

  // Supports de la matière du projet, si elle en a cette année-là.
  const courseLink = h('div');
  if (p.rcId) {
    load(withYear('/api/documents')).then((sources) => {
      if (!sources.some((source) => source.id === p.rcId)) return;
      courseLink.append(h('button', { type: 'button', onclick: () => { openFolder = p.rcId; location.hash = '#documents'; } }, 'Voir les supports de cours'));
    }).catch(() => {});
  }

  return h('div', { class: 'project-page' },
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
      ]), courseLink),
      group,
      p.activity.length > 0 && h('details', {}, h('summary', {}, `Activité du groupe (${p.activity.length})`),
        h('ul', { class: 'activity' }, p.activity.map((event) => h('li', {},
          h('span', { class: 'small' }, [event.author, event.text].filter(Boolean).join(' ')),
          event.date && h('span', { class: 'muted small line' }, dateFormat.format(event.date))))))));
}

async function projectView(title, id, tab) {
  const p = await load(withYear(`/api/projets/${encodeURIComponent(id ?? '')}`));
  title.textContent = p.name;
  const onTeams = tab === 'equipes';
  const link = (label, suffix, current) => h('a', { href: `#projet/${p.id}${suffix}`, class: 'tab', 'aria-current': current ? 'page' : null }, label);
  return [
    h('a', { href: '#projets', class: 'small' }, 'Tous les projets'),
    p.archived && h('p', { class: 'muted small' }, `Projet de ${yearLabel(schoolYear)} : consultation seulement.`),
    h('div', { class: 'chips', role: 'navigation', 'aria-label': 'Pages du projet' },
      link('Informations', '', !onTeams),
      link(`Équipes (${p.teams.length})`, '/equipes', onTeams)),
    onTeams ? teamsPage(p) : projectInfoPage(p),
  ];
}

let directoryTab = 'classe';

async function directoryView() {
  const { classmates, teachers } = await load('/api/annuaire');
  if (!classmates.length && !teachers.length) return empty('Annuaire indisponible pour le moment.');

  // Ma classe (cette année) d'un côté, les autres promotions de l'autre.
  const pools = {
    classe: classmates.filter((person) => person.current),
    promotions: classmates.filter((person) => !person.current),
    intervenants: teachers,
  };
  const tabs = [
    ['classe', `Ma classe (${pools.classe.length})`],
    pools.promotions.length && ['promotions', `Promotions (${pools.promotions.length})`],
    ['intervenants', `Intervenants (${pools.intervenants.length})`],
  ].filter(Boolean);
  // L'onglet retenu d'une visite à l'autre peut être devenu vide (autre compte, année sans promo).
  if (!pools[directoryTab]?.length) directoryTab = tabs.find(([id]) => pools[id].length)?.[0] ?? 'classe';

  let query = '';
  const list = h('ul', { class: 'directory' });
  const card = (person) => h('li', {},
    avatar(person),
    h('span', { class: 'directory-text' },
      h('span', { class: 'line name' }, person.name),
      person.group && h('span', { class: 'line muted small' }, person.group),
      /^[^\s@]+@[^\s@]+$/.test(person.email ?? '') && h('a', { class: 'small', href: `mailto:${encodeURI(person.email)}` }, person.email)));
  const show = () => {
    const needle = query.trim().toLocaleLowerCase('fr');
    const found = (pools[directoryTab] ?? []).filter((person) => `${person.name} ${person.group ?? ''}`.toLocaleLowerCase('fr').includes(needle));
    list.replaceChildren(...(found.length ? found.map(card) : [h('li', { class: 'muted' }, 'Personne ne correspond.')]));
  };
  show();
  const search = h('input', { id: 'recherche-annuaire', type: 'search', oninput: (e) => { query = e.target.value; show(); } });
  return [
    h('div', { class: 'filters' },
      filterChips('Choisir une liste', tabs, directoryTab, (id) => { directoryTab = id; show(); }),
      h('div', { class: 'narrow-field' }, h('label', { for: 'recherche-annuaire' }, 'Chercher une personne ou une promotion'), search)),
    list,
  ];
}

/** Installer le panel sur son téléphone. Rien n'est gardé hors ligne : il faut être connecté. */
function installSection() {
  if (window.matchMedia?.('(display-mode: standalone)').matches) return null;
  const zone = h('section', { class: 'stack' }, h('h2', {}, 'Sur ton téléphone'));
  if (installPrompt) {
    const button = h('button', {
      type: 'button',
      onclick: async () => {
        const prompt = installPrompt;
        installPrompt = null;
        await prompt.prompt();
        button.remove();
      },
    }, 'Installer l\'application');
    zone.append(h('p', { class: 'muted small body-text' }, 'Le panel s\'ouvre alors comme une application, depuis ton écran d\'accueil.'), h('div', { class: 'toolbar' }, button));
  } else {
    zone.append(h('p', { class: 'muted small body-text' }, 'Ajoute le panel à ton écran d\'accueil : sur iPhone, bouton Partager puis « Sur l\'écran d\'accueil » ; sur Android, menu du navigateur puis « Installer l\'application ».'));
  }
  return zone;
}

async function profileView(title) {
  const p = await load('/api/profil');
  title.textContent = p.name;
  const unique = (key) => [...new Set(p.classes.map((c) => c[key]).filter(Boolean))].join(', ');
  return [
    h('div', { class: 'profile' },
      avatar({ id: 'moi', name: p.name }),
      facts([
        ['E-mail', p.email],
        ['Classe', unique('name')],
        ['Promotion', unique('promotion')],
        ['École', unique('school')],
      ])),
    devicesSection(),
    installSection(),
  ];
}

/** Fermer d'ici les sessions ouvertes ailleurs : un téléphone perdu, un ordinateur prêté. */
function devicesSection() {
  const done = h('p', { class: 'muted small', role: 'status' });
  const button = h('button', {
    type: 'button',
    onclick: () => confirmAction(
      'Déconnecter tes autres appareils ?',
      'Tes sessions ouvertes sur d\'autres navigateurs ou téléphones seront fermées, y compris celles où tu as coché « Rester connecté ». Cet appareil reste connecté.',
      'Déconnecter les autres',
      async () => {
        await post('/api/deconnexion-autres');
        done.textContent = 'Tes autres appareils sont déconnectés.';
      },
    ),
  }, 'Déconnecter mes autres appareils');
  return section('Appareils', h('p', { class: 'muted small' }, 'Un téléphone perdu, un ordinateur prêté : ferme d\'ici les sessions ouvertes ailleurs.'), button, done);
}

async function newsView() {
  const items = await load('/api/news');
  if (!items.length) return empty('Aucune actualité.');
  return h('ul', { class: 'rows' }, items.map((n) => h('li', {}, h('article', { class: 'grow' },
    h('h2', {}, n.title),
    n.date && h('p', { class: 'muted small' }, dateFormat.format(n.date)),
    n.body && h('p', { class: `body-text${n.body.length > 220 ? ' clamp' : ''}` }, n.body),
    n.body.length > 220 && h('button', { type: 'button', class: 'link', onclick: () => showDialog(n.title, n.date && h('p', { class: 'muted small' }, dateFormat.format(n.date)), h('p', { class: 'body-text' }, n.body)) }, 'Lire la suite')))));
}

let openFolder = '';

const fileExtension = (file) => file.fileName.match(/\.([a-z0-9]{1,5})$/i)?.[1].toUpperCase() ?? 'Fichier';

async function documentsView() {
  const picker = await yearField();
  const sources = await load(withYear('/api/documents'));
  // Tous les dossiers à la fois : leurs effectifs, les derniers ajouts et la recherche en ont besoin.
  const folders = await Promise.all(sources.map(async (source) => ({ ...source, files: await load(withYear(`/api/documents/${source.id}`)).catch((e) => (e.status === 401 ? Promise.reject(e) : null)) })));
  const explorer = h('div', { class: 'explorer' });
  const pane = h('div', { class: 'files stack' });
  const buttons = {};
  let category = '';
  let paneTitle = null;

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
    const back = h('button', {
      type: 'button',
      class: 'only-narrow',
      onclick: () => {
        showRecent();
        buttons[folder.id].focus();
      },
    }, 'Tous les dossiers');
    const heading = h('h2', { tabindex: '-1' }, folder.name);
    paneTitle = heading;
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
        buttons[folder.id] = h('button', {
          type: 'button',
          onclick: () => {
            showFolder(folder);
            paneTitle.focus();
          },
        },
          h('span', { class: 'name' }, folder.name),
          h('span', { class: 'muted small' }, [folder.hint, count].filter(Boolean).join(', ')));
        return h('li', { class: 'flush' }, buttons[folder.id]);
      }))),
    pane);

  const previous = folders.find((folder) => folder.id === openFolder);
  if (previous) showFolder(previous);
  else showRecent();
  return [picker && h('div', { class: 'filters' }, picker), explorer];
}

// --- Démarrage ---

window.addEventListener('hashchange', () => {
  if (main?.isConnected) render();
});

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setMenu(false);
  if (!main?.isConnected || currentView !== 'agenda' || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target?.tagName)) return;
  if (e.key === 'ArrowLeft') stepAgenda(-1);
  if (e.key === 'ArrowRight') stepAgenda(1);
});

api('/api/session').then(({ name }) => showShell(name), (e) => {
  if (e.status !== 401) showLogin(e.message);
});
