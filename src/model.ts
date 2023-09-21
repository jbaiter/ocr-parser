/** Dimensions expressed in pixels */
export type Dimensions = {
  width: number;
  height: number;
};

/**
 * Coordinates of an element, expressed in pixel units with the origin in the
 * upper left.
 */
export type Coordinates = {
  x: number;
  y: number;
};

/** A choice among multiple alternative words for a given position. */
export type WordChoice = {
  text: string;

  /** Floating point number between 0 and 1 */
  probability?: number;
};

/**
 * A 'word' as recognized by an OCR engine.
 *
 * Corresponds to the following types:
 *
 * - HOCR: `ocrx_word`
 * - ALTO: `String` and descendants
 */
export type OcrWord = Dimensions &
  Coordinates & {
    type: 'word';
    text: string;
    /** Floating point number between 0 and 1 */
    confidence?: number;
    /** Multiple alternative readings for this word. */
    choices?: WordChoice[];
    /** Is the word the first part of a hyphenated word? */
    hyphenStart?: boolean;
  };

/**
 * A line as recognized by an OCR engine.
 *
 * Corresponds to the following types:
 *
 * - HOCR: `ocr_line`
 * - ALTO: `TextLine`
 */
export type OcrLine = Dimensions &
  Coordinates & {
    type: 'line';
    /**
     * Baseline upon which the characters in the word rest. Defined by a set of
     * coordinates that form a polyline.
     */
    baseline?: [number, number] | [number, number][];
    /** Words on the line */
    words: OcrWord[];
    /** Words intermingled with text outside of words (including spaces) */
    children: (OcrWord | string)[];
    /** Plaintext of the line */
    text: string;
  };

export function makeLine(
  spec: Omit<OcrLine, 'type' | 'children' | 'words' | 'text'>,
): OcrLine {
  return {
    ...spec,
    type: 'line',
    children: [],
    get words(): OcrWord[] {
      return this.children.filter((c): c is OcrWord => typeof c !== 'string');
    },
    get text(): string {
      return this.children
        .map((c) => (typeof c === 'string' ? c : c.text))
        .join('');
    },
  };
}

/**
 * A paragraph as recognized by an OCR engine.
 *
 * Corresponds to the following types:
 *
 * - HOCR: `ocr_par`
 * - ALTO: Not mapped
 */
export type OcrParagraph = Partial<Dimensions & Coordinates> & {
  type: 'paragraph';
  /** Descendant elements of the paragraph, currently only lines possible. */
  children: OcrLine[];
  /** All lines in the paragraph. */
  lines: OcrLine[];
  /** All words in the paragraph. */
  words: OcrWord[];
  /** Text content of the paragraph. */
  text: string;
};

export function makeParagraph(
  spec: Omit<OcrParagraph, 'type' | 'children' | 'lines' | 'words' | 'text'>,
): OcrParagraph {
  return {
    ...spec,
    type: 'paragraph',
    children: [],
    get lines(): OcrLine[] {
      return this.children;
    },
    get words(): OcrWord[] {
      return this.children.flatMap((l) => l.words);
    },
    get text(): string {
      const out: string[] = [];
      for (const [idx, child] of this.children.entries()) {
        out.push(child.text);
        if (
          idx < this.children.length - 1 &&
          !child.words.slice(-1)[0]?.hyphenStart
        ) {
          out.push(' ');
        }
      }
      return out.join('');
    },
  };
}

/**
 * A 'block' of text as recognized by an OCR engine.
 *
 * Corresponds to the following types:
 *
 * - HOCR: `ocr_carea`
 * - ALTO: `TextBlock`
 */
export type OcrBlock = Dimensions &
  Coordinates & {
    type: 'block';
    /** Descendant elements of the block, can be paragraphs or lines. */
    children: (OcrParagraph | OcrLine)[];
    /** Paragraphs in the block */
    paragraphs: OcrParagraph[];
    /** All lines in the block. */
    lines: OcrLine[];
    /** All words in the block. */
    words: OcrWord[];
    /** Text content of the block. */
    text: string;
  };

export function makeBlock(
  spec: Omit<
    OcrBlock,
    'type' | 'children' | 'paragraphs' | 'lines' | 'words' | 'text'
  >,
): OcrBlock {
  return {
    ...spec,
    type: 'block',
    children: [],
    get paragraphs(): OcrParagraph[] {
      return this.children.filter((c): c is OcrParagraph => 'lines' in c);
    },
    get lines(): OcrLine[] {
      return this.children.reduce((acc, c) => {
        if ('lines' in c) {
          acc.push(...c.lines);
        } else if ('words' in c) {
          acc.push(c);
        }
        return acc;
      }, [] as OcrLine[]);
    },
    get words(): OcrWord[] {
      return this.lines.flatMap((l) => l.words);
    },
    get text(): string {
      const out: string[] = [];
      for (const [idx, child] of this.children.entries()) {
        out.push(child.text);
        if (
          idx < this.children.length - 1 &&
          !child.words.slice(-1)[0]?.hyphenStart
        ) {
          if (child.type === 'line') {
            out.push(' ');
          } else {
            out.push('\n');
          }
        }
      }
      return out.join('');
    },
  };
}

/**
 * A page of text as recognized by an OCR engine.
 *
 * Corresponds to the following types:
 *
 * - HOCR: `ocr_page`
 * - ALTO: `Page`
 */
export type OcrPage = Dimensions & {
  type: 'page';
  /** Identifier of the page, if present */
  id?: string;
  /** Direct descendants of the page element. */
  children: (OcrBlock | OcrParagraph | OcrLine)[];
  /** All blocks of text on the page */
  blocks: OcrBlock[];
  /** All paragraphs on the page. */
  paragraphs: OcrParagraph[];
  /** All lines on the page. */
  lines: OcrLine[];
  /** All words on the page. */
  words: OcrWord[];
  /** Text content of the page. */
  text: string;
};

export function makePage(
  spec: Omit<
    OcrPage,
    'type' | 'children' | 'blocks' | 'paragraphs' | 'lines' | 'words' | 'text'
  >,
): OcrPage {
  return {
    ...spec,
    type: 'page',
    children: [],
    get blocks(): OcrBlock[] {
      return this.children.filter((c): c is OcrBlock => 'paragraphs' in c);
    },
    get paragraphs(): OcrParagraph[] {
      return this.children.reduce((acc, c) => {
        if ('paragraphs' in c) {
          acc.push(...c.paragraphs);
        } else if ('lines' in c) {
          acc.push(c);
        }
        return acc;
      }, [] as OcrParagraph[]);
    },
    get lines(): OcrLine[] {
      return this.children.reduce((acc, c) => {
        if ('lines' in c) {
          acc.push(...c.lines);
        } else if ('words' in c) {
          acc.push(c);
        }
        return acc;
      }, [] as OcrLine[]);
    },
    get words(): OcrWord[] {
      return this.children.flatMap((l) => l.words);
    },
    get text(): string {
      const out: string[] = [];
      for (const [idx, child] of this.children.entries()) {
        out.push(child.text);
        if (
          idx < this.children.length - 1 &&
          !child.words.slice(-1)[0]?.hyphenStart
        ) {
          if (child.type === 'line') {
            out.push(' ');
          } else {
            out.push('\n');
          }
        }
      }
      return out.join('');
    },
  };
}

/** Union of all possible OCR element types. */
export type OcrElement =
  | string
  | OcrWord
  | OcrLine
  | OcrParagraph
  | OcrBlock
  | OcrPage;
