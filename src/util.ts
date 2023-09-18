import {
  Detail,
  SAXParser,
  SaxEventType,
  SaxParserOptions,
  Tag,
} from 'sax-wasm';

export const SAX_WASM_VERSION = '2.2.4';

let xmlParserWasm: Uint8Array | null = null;

/**
 * Fetch the SAX parser WASM and store it in our global variable.
 *
 * @param loadSaxWasm - A function that returns the SAX parser WASM as a
 *   {@link Uint8Array}. Make sure to use the same version as the one specified
 *   in {@link SAX_WASM_VERSION}. By default, this function will fetch the WASM
 *   from `unpkg.com`, please override this with your own function if you want
 *   to use a different source (e.g. because of GDPR issues).
 */
export async function initialize(
  loadSaxWasm: () => Promise<Uint8Array> = () =>
    fetch(`https://unpkg.com/sax-wasm@${SAX_WASM_VERSION}/lib/sax-wasm.wasm`)
      .then((res) => res.arrayBuffer())
      .then((buf) => new Uint8Array(buf)),
): Promise<void> {
  xmlParserWasm = await loadSaxWasm();
}

export function isInitialized(): boolean {
  return xmlParserWasm !== null;
}

/**
 * Create a new SAX parser with an optional event mask
 *
 * @param eventMask - A bit mask of events to track. See {@link SaxEventType} in
 *   sax-wasm
 */
export async function getParser(
  readable: ReadableStream<Uint8Array>,
  events?: Set<number>,
): Promise<StaxParser> {
  const parser = new StaxParser(
    readable,
    events ??
      new Set([
        SaxEventType.OpenTag,
        SaxEventType.Text,
        SaxEventType.CloseTag,
      ]),
    {
      highWaterMark: 64 * 1024,
    },
  );

  if (!isInitialized()) {
    throw new Error(
      'XML parser WASM not initialized, call initialize() first!',
    );
  }
  const ready = await parser.prepareWasm(xmlParserWasm!);
  if (!ready) {
    throw new Error('Failed to initialize parser with WASM');
  }
  return parser;
}

// Define the regular expressions for the different XML entities
const NUMERIC_ENTITY_REGEX = /&#(\d+);/g;
const HEX_ENTITY_REGEX = /&#x([A-Fa-f0-9]+);/g;
const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  apos: "'",
  quot: '"',
  lt: '<',
  gt: '>',
};
const ENTITY_REGEX = new RegExp(
  `&(${Object.keys(ENTITY_MAP).join('|')});`,
  'g',
);

/**
 * Replace al XML entities in a given XML string with their unicode
 * equivalents.
 */
export function resolveXmlEntities(str: string) {
  // NOTE: It might look slow with all of those regexes, but benchmarking showed that
  //       it's actually just as fast as a hand-rolled alternative implementation, so
  //       we stick to regexes for ease of maintenance.

  // Replace the named entities
  str = str.replace(ENTITY_REGEX, function (match, entity) {
    return ENTITY_MAP[entity];
  });

  // Replace the numeric entities
  str = str.replace(NUMERIC_ENTITY_REGEX, function (match, entityCode) {
    const decimalCode = parseInt(entityCode, 10);
    return String.fromCharCode(decimalCode);
  });

  // Replace the hexadecimal entities
  str = str.replace(HEX_ENTITY_REGEX, function (match, entityCode) {
    const decimalCode = parseInt(entityCode, 16);
    return String.fromCharCode(decimalCode);
  });

  return str;
}

/** Convert a string or byte array to a ReadableStream of bytes. */
export function toReadableStream(
  data: string | Uint8Array,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        data instanceof Uint8Array ? data : encoder.encode(data),
      );
      controller.close();
    },
  });
}

export function hasAttribute(tag: Tag, attrName: string): boolean {
  return tag.attributes.find((a) => a.name.value === attrName) !== undefined;
}

export function getAttributeValue(
  tag: Tag,
  attrName: string,
): string | undefined {
  const attr = tag.attributes.find((a) => a.name.value === attrName);
  return attr?.value?.value;
}

/** A StaX-like wrapper around the SAX parser that allows. */
export class StaxParser {
  readable: ReadableStream<Uint8Array>;
  saxParser: SAXParser;
  accumulator: [SaxEventType, Detail][] = [];

  constructor(
    readable: ReadableStream<Uint8Array>,
    events?: Set<number>,
    options?: SaxParserOptions,
  ) {
    this.readable = readable;
    let eventMask: number | undefined;
    if (events) {
      eventMask = 0;
      for (const event of events) {
        eventMask |= event;
      }
    }
    this.saxParser = new SAXParser(eventMask, options);
    this.saxParser.eventHandler = (type, detail) =>
      this.accumulator.push([type, detail]);
  }

  prepareWasm(wasm: Uint8Array): Promise<boolean> {
    return this.saxParser.prepareWasm(xmlParserWasm!);
  }

  [Symbol.asyncIterator](): AsyncGenerator<[SaxEventType, Detail]> {
    return this.iterate();
  }

  async *iterate(): AsyncGenerator<[SaxEventType, Detail]> {
    // Lazy piping of parser output to generator
    const reader = this.readable.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        this.saxParser.write(chunk.value);
        while (this.accumulator.length > 0) {
          yield this.accumulator.shift()!;
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Parsing completed but the accumulator still has items to yield.
    while (this.accumulator.length > 0) {
      yield this.accumulator.shift()!;
    }
  }
}
