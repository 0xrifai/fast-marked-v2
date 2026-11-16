# fast-marked-v2

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node-22%2B-brightgreen.svg)](https://nodejs.org/)
[![CommonMark 0.31.2](https://img.shields.io/badge/CommonMark-0.31.2-blue.svg)](https://spec.commonmark.org/0.31.2/)

A faster drop-in replacement for [marked](https://github.com/markedjs/marked)
18.1.3: `parse(markdown)` returns byte-for-byte the HTML that
`marked.parse(markdown)` returns with marked's default options
(GFM on, `breaks` off, `pedantic` off, `async` off), but renders it
noticeably faster.

Dependency-free, single ES module (`parse.js`), plus a small driver
(`main.ts`) that reads `/input/cases.json` and writes `/output/html.json`
for the [make.fun](https://make.fun) bounty
[markdown-render-speed-02](https://make.fun/bounty/markdown-render-speed-02).

## Use

```js
import { parse } from './parse.js';

parse('# Hello\n\nSome *emphasised* text.');
// '<h1>Hello</h1>\n<p>Some <em>emphasised</em> text.</p>\n'
```

Supports the full CommonMark 0.31.2 spec and the GFM 0.29 extensions
(tables, task lists, strikethrough, extended autolinks, disallowed raw
HTML), including all of marked 18.1.3's quirks where it departs from the
spec.

Referral code: `6twtfdad`

## License

MIT — see [LICENSE](LICENSE).
