// Point d'entrée de production.
// Le TypeScript est compilé en amont (`npm run build`) : plus de ts-node à
// l'exécution, ce qui évite toute surprise lors d'une montée de version Node.
const fs = require('fs');
const path = require('path');

const entry = path.join(__dirname, 'dist', 'index.js');

if (!fs.existsSync(entry)) {
    console.error(
        '❌ dist/ introuvable.\n' +
        '   Compile le bot avant de le lancer :\n' +
        '       npm install && npm run build\n' +
        "   Puis démarre-le avec `npm start` (ou `node dist/index.js`)."
    );
    process.exit(1);
}

require(entry);
