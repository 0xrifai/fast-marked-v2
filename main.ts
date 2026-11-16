import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

// Driver for the make.fun harness: read every case from the input
// directory, render each one alone with parse(), and write the HTML
// strings in order to the output directory as a JSON array.
const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const out = new Array(cases.length);
for (let i = 0; i < cases.length; i++) out[i] = parse(cases[i].markdown);
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(out));
