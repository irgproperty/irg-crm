import { parseLead } from './src/inbound.js';
import fs from 'fs';
const S = JSON.parse(fs.readFileSync('samples/meta.json', 'utf8'));
for (const s of S) console.log(s.id, JSON.stringify(parseLead({ ...s, text: fs.readFileSync(`samples/${s.id}.txt`, 'utf8') }), null, 1));
