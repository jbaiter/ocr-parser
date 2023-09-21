# ocr-parser

This library provides a simple interface to parse OCR data from a stream, buffer
or string. It does not rely on any DOM APIs and can therefore be used in contexts
where there is no built-in support for XML parsing, most notabily in Web Workers
and Service Workers.

Currently the library supports [hOCR](http://kba.github.io/hocr-spec/1.2/) and
[ALTO](https://altoxml.github.io/) OCR markup.

## Usage
Before OCR markup can be parsed, the XML parser has to be initialized. The
library uses [sax-wasm](https://www.npmjs.com/package/sax-wasm) under the hood,
which needs to be initialized with its WASM code before it can be used. By
default, the WASM will be loaded from `unpkg.com`, but you can also provide a
custom callback to the `initialize` function to load the WASM from a different
source. Make sure that the WASM matches the versio of `sax-wasm` used by this
library (currently `2.2.4`).

```js
import { initialize as initializeXmlParser } from 'ocr-parser';

// Load from unpkg.com
await initializeXmlParser();

// Load from custom source (e.g. from base64-encoded constant)
await initializeXmlParser(() => Promise.resolve(WASM_BLOB));
```

Once the parser has been initialized, call `parseOcrPages` or any of
the format-specific functons (`parseAltoPages`, `parseHocrPages`) with
your markup to retrieve an asynchronous generator over all the pages
in the markup.

```js
import { parseOcrPages } from 'ocr-parser';

for await (const page of parseOcrPages(markup, 'hocr')) {
  // Do something with the page
  console.log(page);
}
```

## Data Structures
The markup is parsed into a simple hierarchical data structure:

```
OcrPage
└── OcrBlock
    └── OcrParagraph
        └── OcrLine
            ├── OcrWord
            └── string
```

The `OcrBlock` and `OcrParagraph` levels are only present if they are encoded in
the markup. Every element has getters for any of the lower levels, so yo can
simply access `OcrPage#words` to get a flat list of all words on the page.
`string` children of `OcrLine` elements are 'stray' text nodes (including whitespace) that are not explicitely encoded as words (and thus have no associated bounding box).