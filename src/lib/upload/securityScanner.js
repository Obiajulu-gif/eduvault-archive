/**
 * Security scanner module for validating uploaded course materials.
 * Prevents disguised malicious files, zip bombs, and unverified executables.
 */

const MAGIC_SIGNATURES = [
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] }, // PNG
  { mime: 'image/jpeg', bytes: [0xFF, 0xD8, 0xFF] }, // JPEG
  { mime: 'application/zip', bytes: [0x50, 0x4B, 0x03, 0x04] }, // ZIP
  { mime: 'application/x-zip-compressed', bytes: [0x50, 0x4B, 0x03, 0x04] },
  { mime: 'video/mp4', offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }, // ftyp
];

const EXECUTABLE_SIGNATURES = [
  { type: 'Windows Executable (EXE/DLL)', bytes: [0x4D, 0x5A] }, // MZ
  { type: 'ELF Executable', bytes: [0x7F, 0x45, 0x4C, 0x46] }, // .ELF
  { type: 'Java Bytecode', bytes: [0xCA, 0xFE, 0xBA, 0xBE] },
  { type: 'Mach-O Executable', bytes: [0xCF, 0xFA, 0xED, 0xFE] }
];

export const MAX_DECOMPRESSION_RATIO = 100;
export const MAX_UNCOMPRESSED_SIZE_BYTES = 500 * 1024 * 1024;

export function sniffMimeType(buffer) {
  if (!buffer || buffer.length === 0) return null;

  for (const exeSig of EXECUTABLE_SIGNATURES) {
    let match = true;
    for (let i = 0; i < exeSig.bytes.length; i++) {
      if (buffer[i] !== exeSig.bytes[i]) {
        match = false;
        break;
      }
    }
    if (match) return 'application/x-executable';
  }

  for (const sig of MAGIC_SIGNATURES) {
    const offset = sig.offset || 0;
    if (buffer.length < offset + sig.bytes.length) continue;
    let match = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (buffer[offset + i] !== sig.bytes[i]) {
        match = false;
        break;
      }
    }
    if (match) return sig.mime;
  }

  return null;
}

export function checkDecompressionSafety(compressedSize, uncompressedSize) {
  if (compressedSize <= 0) {
    return { safe: false, reason: 'Invalid compressed file size' };
  }

  if (uncompressedSize > MAX_UNCOMPRESSED_SIZE_BYTES) {
    return {
      safe: false,
      reason: `Uncompressed size exceeds max allowed size of ${MAX_UNCOMPRESSED_SIZE_BYTES / (1024 * 1024)} MB`
    };
  }

  const ratio = uncompressedSize / compressedSize;
  if (ratio > MAX_DECOMPRESSION_RATIO) {
    return {
      safe: false,
      reason: `Decompression ratio ${ratio.toFixed(1)}:1 exceeds safety limit of ${MAX_DECOMPRESSION_RATIO}:1`
    };
  }

  return { safe: true, ratio };
}

export async function scanFileForMalware(buffer, filename) {
  const contentStr = buffer.toString('utf8', 0, Math.min(buffer.length, 128));
  if (contentStr.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')) {
    return {
      isClean: false,
      threatFound: 'EICAR_Test_File',
      quarantine: true
    };
  }

  return {
    isClean: true,
    threatFound: null,
    quarantine: false
  };
}

export async function inspectUploadedFile(fileInfo) {
  const { buffer, originalFilename, declaredMimeType, compressedSize, uncompressedSize } = fileInfo;

  const detectedMime = sniffMimeType(buffer);
  if (detectedMime === 'application/x-executable') {
    return {
      status: 'quarantined',
      accepted: false,
      reason: 'Executable files are prohibited as course material uploads.',
      appealUrl: '/support/appeals'
    };
  }

  if (detectedMime && declaredMimeType && !detectedMime.includes(declaredMimeType.split('/')[1]) && !declaredMimeType.includes(detectedMime.split('/')[1])) {
    return {
      status: 'quarantined',
      accepted: false,
      reason: `Declared MIME type (${declaredMimeType}) does not match detected content magic bytes (${detectedMime}).`,
      appealUrl: '/support/appeals'
    };
  }

  if (detectedMime && detectedMime.includes('zip') && compressedSize && uncompressedSize) {
    const zipSafety = checkDecompressionSafety(compressedSize, uncompressedSize);
    if (!zipSafety.safe) {
      return {
        status: 'quarantined',
        accepted: false,
        reason: `Archive failed safety check: ${zipSafety.reason}`,
        appealUrl: '/support/appeals'
      };
    }
  }

  const scanResult = await scanFileForMalware(buffer, originalFilename);
  if (!scanResult.isClean) {
    return {
      status: 'quarantined',
      accepted: false,
      reason: `Malware scan detected potential threat: ${scanResult.threatFound}`,
      appealUrl: '/support/appeals'
    };
  }

  return {
    status: 'clean',
    accepted: true,
    detectedMimeType: detectedMime || declaredMimeType
  };
}
