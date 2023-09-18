//@ts-expect-error
import WITH_ALTERNATIVES from './__fixtures__/chronicling_america.xml?raw';

import fs from 'fs';
import { describe, it, expect, beforeAll } from 'vitest';
import { parseAltoPage, initialize } from '../src';

const saxWasm = fs.readFileSync(
  __dirname + '/../node_modules/sax-wasm/lib/sax-wasm.wasm',
);

// Custom serializer that ignores getters
expect.addSnapshotSerializer({
  test: (val) =>
    Object.values(Object.getOwnPropertyDescriptors(val)).some((d) => d.get),
  serialize(val, config, indentation, depth, refs, printer) {
    const filtered = Object.fromEntries(
      Object.entries(val).filter(
        ([k]) => !Object.getOwnPropertyDescriptor(val, k)?.get,
      ),
    );
    return printer(filtered, config, indentation, depth, refs);
  },
});

describe('parseAltoPage', () => {
  beforeAll(() => {
    initialize(() => Promise.resolve(new Uint8Array(saxWasm)));
  });
  it('parses alto lines', async () => {
    const page = await parseAltoPage(WITH_ALTERNATIVES, {
      width: 6113,
      height: 5115,
    });
    expect(page.text).toMatchInlineSnapshot(
      '"J a Ira mj iI tE1r 3 i c JiLas Edition THE WINCHESTER NEWS I her injuries wsis made Dr Reynolds an eye specialist after lite examina cents and GO of Henry C Hall average weight 1410 > ounds at 0 cents"',
    );
    expect(page).toMatchSnapshot();
  });
});
