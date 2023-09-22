export type PageLocation = Dimensions & Coordinates & {
  /** Polygon defining the outline of the element. */
  polygon?: Polygon;
}
/** Dimensions of an element's bounding box, expressed in pixels */
export type Dimensions = {
  width: number;
  height: number;
};

/**
 * Coordinates of a point on the page, expressed in pixel units with
 * the origin in the upper left. If set on an element itself, the point
 * is the upper-left corner of the bounding box.
 */
export type Coordinates = {
  x: number;
  y: number;
};

/** Polygon defining the outlines of an element. */
export type Polygon = Coordinates[];

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
export type OcrWord = {
    type: 'word';
    text: string;
    /** Floating point number between 0 and 1 */
    confidence?: number;
    /** Multiple alternative readings for this word. */
    choices?: WordChoice[];
    /** Is the word the first part of a hyphenated word? */
    hyphenStart?: boolean;
  } & PageLocation;

/**
 * A line as recognized by an OCR engine.
 *
 * Corresponds to the following types:
 *
 * - HOCR: `ocr_line`
 * - ALTO: `TextLine`
 */
export type OcrLine = {
    type: 'line';
    /**
     * Baseline upon which the characters in the word rest. Defined by a set of
     * coordinates that form a polyline.
     */
    baseline?: Coordinates[];
    /** Words on the line */
    words: OcrWord[];
    /** Words intermingled with text outside of words (including spaces) */
    children: (OcrWord | string)[];
    /** Plaintext of the line */
    text: string;
  } & PageLocation;

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
export type OcrParagraph = {
  type: 'paragraph';
  /** Descendant elements of the paragraph, currently only lines possible. */
  children: OcrLine[];
  /** All lines in the paragraph. */
  lines: OcrLine[];
  /** All words in the paragraph. */
  words: OcrWord[];
  /** Text content of the paragraph. */
  text: string;
} & Partial<PageLocation>;

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
export type OcrBlock = {
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
  } & PageLocation;

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

const OCR_FEATURES = {
  POLYGONS: 'POLYGONS',
  BASELINE: 'BASELINE',
  CONFIDENCE: 'CONFIDENCE',
  CHOICES: 'CHOICES',
  HYPHEN: 'HYPHEN',
} as const;
type OcrFeature = typeof OCR_FEATURES[keyof typeof OCR_FEATURES];

type ImageSource = {
  /** File name or path associated with the image the page was sourced from. */
  fileName?: string;
  /** Generic identifier for the image file the page was sourced from. */
  fileIdentifier?: string;
  /** Generic identifier for the document the page was souced from. */
  documentIdentifier?: string;
  /** Resolution in pixels per inch of the scanned document image the page was sourced from. */
  ppi?: number;
  /** Checksum of the associated image file. */
  checksum?: string;
  /** Type of algorithm used to calculate the checksum. */
  checksumType?: string;
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
  /** Special features used by this page. */
  features: OcrFeature[];
  /** Information about associated image. */
  imageSource?: ImageSource;
  /** Physical page number of the page. */
  physicalPageNumber?: number;
  /** "Logical" page number as printed/written on the page */
  logicalPageNumber?: string;
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
