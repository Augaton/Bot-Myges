// Superviseur : testé dans un dossier temporaire, avec de faux programmes.
// Ne jamais lancer ici le index.js du dépôt : il démarrerait le vrai bot.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const stub = (name, body) => `const fs=require('node:fs');const mark=(l)=>fs.appendFileSync(${JSON.stringify(name)},l+'\\n');${body}process.on('SIGTERM',()=>{mark('stop');process.exit(0)});setInterval(()=>{},1000);`;

function sandbox({ env = '', bot = "mark('start');", panel = "mark('start '+(process.env.DISCORD_TOKEN??'sans-secret'));" } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superviseur-'));
    fs.copyFileSync(path.join(__dirname, '..', 'index.js'), path.join(dir, 'index.js'));
    fs.mkdirSync(path.join(dir, 'dist', 'panel'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'index.js'), stub(path.join(dir, 'bot.txt'), bot));
    fs.writeFileSync(path.join(dir, 'dist', 'panel', 'server.js'), stub(path.join(dir, 'panel.txt'), panel));
    fs.writeFileSync(path.join(dir, '.env'), env);
    return dir;
}

const read = (dir, file) => (fs.existsSync(path.join(dir, file)) ? fs.readFileSync(path.join(dir, file), 'utf-8') : '');

// Large : quand toute la suite tourne en parallèle, une relance peut prendre plusieurs
// secondes. On n'attend jamais plus que nécessaire : la boucle rend la main dès que c'est vrai.
async function until(check, ms = 10_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (check()) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
}

// Superviseurs encore en vie. Une assertion qui échoue avant l'arrêt laisserait le sien
// tourner : le fichier de test ne se terminerait plus, et toute la suite resterait bloquée.
const running = new Set();
test.afterEach(async () => {
    for (const child of running) {
        const closed = new Promise((resolve) => child.once('close', resolve));
        child.kill('SIGTERM'); // le superviseur arrête lui-même le bot et le panel
        const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
        await closed;
        clearTimeout(timer);
    }
});

function run(dir, extraEnv = {}) {
    const env = { ...process.env, ...extraEnv };
    delete env.PANEL_PORT;
    Object.assign(env, extraEnv);
    const child = spawn(process.execPath, [path.join(dir, 'index.js')], { cwd: dir, env, stdio: 'ignore' });
    running.add(child);
    const exited = new Promise((resolve) => child.on('close', (code) => {
        running.delete(child);
        resolve(code);
    }));
    return { child, exited };
}

test('sans PANEL_PORT : le bot seul, comme avant', async () => {
    const dir = sandbox();
    const { child, exited } = run(dir);
    assert.ok(await until(() => read(dir, 'bot.txt').includes('start')));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.strictEqual(read(dir, 'panel.txt'), '');
    child.kill('SIGTERM');
    await exited;
});

test('avec PANEL_PORT : bot et panel lancés, arrêtés ensemble, sans secret côté panel', async () => {
    const dir = sandbox({ env: 'PANEL_PORT=8788\n' });
    const { child, exited } = run(dir, { DISCORD_TOKEN: 'secret-injecte' });
    assert.ok(await until(() => read(dir, 'bot.txt').includes('start') && read(dir, 'panel.txt').includes('start')));
    assert.match(read(dir, 'panel.txt'), /sans-secret/);
    assert.doesNotMatch(read(dir, 'panel.txt'), /secret-injecte/);
    child.kill('SIGTERM');
    assert.strictEqual(await exited, 0);
    assert.match(read(dir, 'bot.txt'), /stop/);
    assert.match(read(dir, 'panel.txt'), /stop/);
});

test('panel qui plante : relancé sans toucher au bot', async () => {
    const crashOnce = "mark('start');const seen=fs.readFileSync(require('node:path').join(__dirname,'..','..','panel.txt'),'utf-8');if(seen.split('start').length===2)process.exit(1);";
    const dir = sandbox({ env: 'PANEL_PORT=8788\n', panel: crashOnce });
    const { child, exited } = run(dir);
    assert.ok(await until(() => read(dir, 'panel.txt').split('start').length >= 3), 'panel relancé');
    assert.strictEqual(read(dir, 'bot.txt').split('start').length, 2, 'bot lancé une seule fois');
    child.kill('SIGTERM');
    await exited;
});

test('panel mal configuré : pas de relance en boucle, et le bot continue', async () => {
    const dir = sandbox({ env: 'PANEL_PORT=8788\n', panel: "mark('start');process.exit(78);" });
    const { child, exited } = run(dir);
    assert.ok(await until(() => read(dir, 'panel.txt').includes('start')));
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.strictEqual(read(dir, 'panel.txt').split('start').length, 2);
    assert.strictEqual(child.exitCode, null, 'le superviseur tourne encore');
    assert.match(read(dir, 'bot.txt'), /start/);
    child.kill('SIGTERM');
    await exited;
});

test('bot mal configuré : tout s\'arrête avec le même code', async () => {
    const dir = sandbox({ env: 'PANEL_PORT=8788\n', bot: "mark('start');process.exit(78);" });
    const { exited } = run(dir);
    assert.strictEqual(await exited, 78);
    assert.ok(await until(() => read(dir, 'panel.txt').includes('stop') || !read(dir, 'panel.txt').includes('start')));
});

// Échec de lancement simulé dans le superviseur seul : préchargé par NODE_OPTIONS.
function failFirstSpawn(dir, failure) {
    const file = path.join(dir, 'echec-spawn.js');
    fs.writeFileSync(file, `
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const real = cp.spawn;
let first = true;
cp.spawn = (...args) => {
    if (!first) return real(...args);
    first = false;
    ${failure}
};`);
    return { NODE_OPTIONS: `--require ${file}` };
}

test('lancement impossible (exception) : le superviseur survit et relance', async () => {
    const dir = sandbox();
    const env = failFirstSpawn(dir, "throw Object.assign(new Error('spawn ENOMEM'), { code: 'ENOMEM' });");
    const { child, exited } = run(dir, env);
    assert.ok(await until(() => read(dir, 'bot.txt').includes('start')));
    child.kill('SIGTERM');
    assert.strictEqual(await exited, 0);
});

test('lancement impossible (événement, sans flux) : le superviseur survit et relance', async () => {
    const dir = sandbox();
    const env = failFirstSpawn(dir, `const fake = new EventEmitter();
    process.nextTick(() => { fake.emit('error', Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' })); fake.emit('close', -24, null); });
    return fake;`);
    const { child, exited } = run(dir, env);
    assert.ok(await until(() => read(dir, 'bot.txt').includes('start')));
    child.kill('SIGTERM');
    assert.strictEqual(await exited, 0);
});
