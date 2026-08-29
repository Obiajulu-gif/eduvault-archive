import assert from "node:assert/strict";
import { test } from "node:test";
import zlib from "node:zlib";
import {
  validateFileMagicNumber,
  validateUploadedFile,
  detectExecutableExtension,
} from "../../src/lib/ipfs/uploadValidator.js";

// Helper to create a custom Mock File object
function createMockFile(bytes, type, name = "test.bin") {
  const blob = new Blob([new Uint8Array(bytes)], { type });
  blob.name = name;
  return blob;
}

// Helper to construct a minimal ZIP archive structure in memory
function createMockZip(files) {
  const buffers = [];
  for (const f of files) {
    const nameBuf = Buffer.from(f.name);
    let dataBuf = Buffer.from(f.content);
    let method = 0;
    if (f.compress) {
      method = 8;
      dataBuf = zlib.deflateRawSync(dataBuf);
    }
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // local file header signature
    header.writeUInt16LE(10, 4); // version needed to extract
    header.writeUInt16LE(0, 6); // general purpose bit flag
    header.writeUInt16LE(method, 8); // compression method
    header.writeUInt16LE(0, 10); // last mod file time
    header.writeUInt16LE(0, 12); // last mod file date
    header.writeUInt32LE(0, 14); // crc-32 (dummy)
    header.writeUInt32LE(dataBuf.length, 18); // compressed size
    header.writeUInt32LE(f.content.length, 22); // uncompressed size
    header.writeUInt16LE(nameBuf.length, 26); // file name length
    header.writeUInt16LE(0, 28); // extra field length

    buffers.push(header);
    buffers.push(nameBuf);
    buffers.push(dataBuf);
  }
  return Buffer.concat(buffers);
}

test("validateFileMagicNumber passes valid PDF", async () => {
  const pdfBytes = [0x25, 0x50, 0x44, 0x46, 0x31, 0x2e, 0x34]; // %PDF-1.4
  const file = createMockFile(pdfBytes, "application/pdf", "test.pdf");
  const result = await validateFileMagicNumber(file);
  assert.equal(result.valid, true);
});

test("validateFileMagicNumber rejects PDF with invalid header", async () => {
  const badBytes = [0x41, 0x42, 0x43, 0x44];
  const file = createMockFile(badBytes, "application/pdf", "test.pdf");
  const result = await validateFileMagicNumber(file);
  assert.equal(result.valid, false);
  assert.match(result.reason, /does not match declared MIME type/);
});

test("validateFileMagicNumber passes valid docx", async () => {
  const docxBytes = createMockZip([
    {
      name: "[Content_Types].xml",
      content: '<?xml version="1.0" encoding="UTF-8"?><Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      compress: true
    }
  ]);
  const file = createMockFile(docxBytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "document.docx");
  const result = await validateFileMagicNumber(file);
  assert.equal(result.valid, true);
});

test("validateFileMagicNumber passes valid xlsx", async () => {
  const xlsxBytes = createMockZip([
    {
      name: "[Content_Types].xml",
      content: '<?xml version="1.0" encoding="UTF-8"?><Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
      compress: true
    }
  ]);
  const file = createMockFile(xlsxBytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "sheet.xlsx");
  const result = await validateFileMagicNumber(file);
  assert.equal(result.valid, true);
});

test("validateFileMagicNumber passes valid pptx", async () => {
  const pptxBytes = createMockZip([
    {
      name: "[Content_Types].xml",
      content: '<?xml version="1.0" encoding="UTF-8"?><Types><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>',
      compress: true
    }
  ]);
  const file = createMockFile(pptxBytes, "application/vnd.openxmlformats-officedocument.presentationml.presentation", "presentation.pptx");
  const result = await validateFileMagicNumber(file);
  assert.equal(result.valid, true);
});

test("validateFileMagicNumber rejects docx spoofed as xlsx", async () => {
  const docxBytes = createMockZip([
    {
      name: "[Content_Types].xml",
      content: '<?xml version="1.0" encoding="UTF-8"?><Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      compress: true
    }
  ]);
  // Declaring it as a spreadsheet but the contents are docx!
  const file = createMockFile(docxBytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "spoofed.xlsx");
  const result = await validateFileMagicNumber(file);
  assert.equal(result.valid, false);
  assert.match(result.reason, /Spoofing detected/);
});

test("validateFileMagicNumber rejects ZIP file with missing [Content_Types].xml", async () => {
  const plainZipBytes = createMockZip([
    {
      name: "hello.txt",
      content: "Hello World",
      compress: false
    }
  ]);
  const file = createMockFile(plainZipBytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "spoofed.docx");
  const result = await validateFileMagicNumber(file);
  assert.equal(result.valid, false);
  assert.match(result.reason, /\[Content_Types\].xml not found/);
});

// --- Issue #671: executable / script extension blocking ---

test("detectExecutableExtension blocks .exe", () => {
  const file = createMockFile([0x4d, 0x5a], "application/pdf", "malware.exe"); // PE header but declared as PDF
  const result = detectExecutableExtension(file);
  assert.equal(result.blocked, true);
  assert.match(result.reason, /\.exe/);
});

test("detectExecutableExtension blocks .sh, .bat, .ps1, .js, .py", () => {
  for (const name of ["evil.sh", "run.bat", "r.ps1", "x.js", "s.py"]) {
    const file = createMockFile([0x25, 0x50, 0x44, 0x46], "text/plain", name);
    assert.equal(detectExecutableExtension(file).blocked, true, `${name} should be blocked`);
  }
});

test("detectExecutableExtension does not block benign extensions", () => {
  for (const name of ["lecture.pdf", "notes.txt", "quiz.zip", "sheet.xlsx"]) {
    const file = createMockFile([0x25, 0x50, 0x44, 0x46], "application/pdf", name);
    assert.equal(detectExecutableExtension(file).blocked, false, `${name} should be allowed`);
  }
});

test("validateUploadedFile rejects executable extension even with allowlisted MIME", async () => {
  const exeBytes = [0x4d, 0x5a]; // MZ header
  const file = createMockFile(exeBytes, "application/pdf", "renamed-malware.exe");
  const result = await validateUploadedFile(file, ["application/pdf"]);
  assert.equal(result.valid, false);
  assert.match(result.reason, /not allowed/);
});

test("validateUploadedFile rejects mismatched magic number for non-executable", async () => {
  // Declared PDF but header bytes are ZIP; not an executable extension.
  const badBytes = [0x50, 0x4b, 0x03, 0x04];
  const file = createMockFile(badBytes, "application/pdf", "notes.pdf");
  const result = await validateUploadedFile(file, ["application/pdf"]);
  assert.equal(result.valid, false);
});

test("validateUploadedFile passes a clean, correctly-mimetyped PDF", async () => {
  const pdfBytes = [0x25, 0x50, 0x44, 0x46, 0x31, 0x2e, 0x34];
  const file = createMockFile(pdfBytes, "application/pdf", "notes.pdf");
  const result = await validateUploadedFile(file, ["application/pdf"]);
  assert.equal(result.valid, true);
});

test("validateUploadedFile rejects non-allowlisted MIME before extension check", async () => {
  const file = createMockFile([0x25, 0x50, 0x44, 0x46], "application/x-shockwave-flash", "flash.swf");
  const result = await validateUploadedFile(file, ["application/pdf"]);
  assert.equal(result.valid, false);
  assert.match(result.reason, /Unsupported file type/);
});
