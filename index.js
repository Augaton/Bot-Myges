// index.js
const path = require('path');

// 1. On active la lecture du TypeScript
require('ts-node').register({
    project: path.join(__dirname, 'tsconfig.json') // Assure-toi d'avoir un tsconfig.json
});

// 2. On lance ton vrai fichier principal
require('./src/index.ts');