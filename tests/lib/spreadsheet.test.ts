import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { parseCsv, readSpreadsheet } from '@/lib/spreadsheet';
import { ValidationError } from '@/domain/errors';

/** A minimal zip, deflated, built the way Excel lays one out. */
function zip(files: Record<string, string>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const data = deflateRawSync(Buffer.from(text));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(text.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(text.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

/** Two tabs; the FIRST tab lives in sheet2.xml, as it does after tabs are reordered. */
const workbook = zip({
  'xl/workbook.xml':
    '<workbook xmlns:r="r"><sheets><sheet name="Prices" sheetId="2" r:id="rId9"/><sheet name="Old" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':
    '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId9" Target="worksheets/sheet2.xml"/></Relationships>',
  'xl/sharedStrings.xml':
    '<sst><si><t>PRODUCT</t></si><si><t>cost price</t></si><si><r><t>KRAFT </t></r><r><t>BOWL &amp; LID</t></r><rPh><t>x</t></rPh></si></sst>',
  'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>wrong tab</t></is></c></row></sheetData></worksheet>',
  'xl/worksheets/sheet2.xml':
    '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
    // A formula keeps its last calculated value, unrounded; an empty styled cell is self-closing.
    '<row r="3"><c r="A3" t="s"><v>2</v></c><c r="B3" s="4"/><c r="C3"><f>B2/1.08</f><v>1.7592592592592591</v></c></row>' +
    '</sheetData></worksheet>',
});

describe('reading a price list', () => {
  it('reads the first tab of an .xlsx, keeping row numbers and unrounded formula values', () => {
    expect(readSpreadsheet('JCG.xlsx', workbook)).toEqual([
      ['PRODUCT', '', 'cost price'],
      [],
      ['KRAFT BOWL & LID', '', '1.7592592592592591'],
    ]);
  });

  it('reads CSV with quoted commas, doubled quotes, line breaks and a BOM', () => {
    expect(parseCsv('\uFEFFname,price\r\n"Bowl, 750ml","2.50"\r\n"Say ""hi""\nthere",3\n')).toEqual([
      ['name', 'price'],
      ['Bowl, 750ml', '2.50'],
      ['Say "hi"\nthere', '3'],
    ]);
  });

  it('drops formatted empty cells, so a sheet styled down to row 6000 is two rows long', () => {
    const styled = zip({
      'xl/workbook.xml': '<workbook><sheets><sheet name="A" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><cols><col min="1" max="2"/></cols><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>name</t></is></c></row>' +
        '<row r="2"><c r="A2" t="inlineStr"><is><t>Bowl</t></is></c><c r="B2" s="3"/></row><row r="6000"><c r="B6000" s="3"/></row></sheetData></worksheet>',
    });
    expect(readSpreadsheet('a.xlsx', styled)).toEqual([['name'], ['Bowl']]);
  });

  it('refuses an unclosed cell promptly instead of rescanning the sheet for every tag', () => {
    const crafted = zip({
      'xl/workbook.xml': '<workbook><sheets><sheet name="A" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData>' + '<c r="A1">'.repeat(200_000),
    });
    const started = Date.now();
    expect(() => readSpreadsheet('a.xlsx', crafted)).toThrow(ValidationError);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('refuses a file that is not .xlsx or .csv, or is not really a workbook', () => {
    expect(() => readSpreadsheet('old.xls', new Uint8Array(10))).toThrow(ValidationError);
    expect(() => readSpreadsheet('fake.xlsx', new TextEncoder().encode('not a zip'))).toThrow(ValidationError);
  });
});
