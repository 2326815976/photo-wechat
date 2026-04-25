function sliceArrayBuffer(buffer, byteOffset, byteLength) {
  const source = buffer instanceof ArrayBuffer ? buffer : null;
  if (!source) {
    return null;
  }

  const offset = Math.max(0, Number(byteOffset || 0));
  const requestedLength = Number(byteLength);
  const end = Number.isFinite(requestedLength) && requestedLength >= 0
    ? Math.min(source.byteLength, offset + requestedLength)
    : source.byteLength;
  if (end <= offset) {
    return new ArrayBuffer(0);
  }
  return source.slice(offset, end);
}

function normalizeBinaryDataToArrayBuffer(data) {
  if (data instanceof ArrayBuffer) {
    return data;
  }

  if (typeof ArrayBuffer !== "undefined" && typeof ArrayBuffer.isView === "function" && ArrayBuffer.isView(data)) {
    return sliceArrayBuffer(data.buffer, data.byteOffset, data.byteLength);
  }

  if (data && typeof data === "object" && data.buffer instanceof ArrayBuffer) {
    const byteOffset = Number(data.byteOffset || 0);
    const byteLength = Number(data.byteLength || data.length || 0);
    return sliceArrayBuffer(data.buffer, byteOffset, byteLength);
  }

  if (typeof data === "string" && data) {
    if (typeof wx !== "undefined" && typeof wx.base64ToArrayBuffer === "function") {
      try {
        return wx.base64ToArrayBuffer(data);
      } catch (error) {
        // ignore
      }
    }

    const bytes = new Uint8Array(data.length);
    for (let index = 0; index < data.length; index += 1) {
      bytes[index] = data.charCodeAt(index) & 0xff;
    }
    return bytes.buffer;
  }

  return null;
}

function readLocalFileAsArrayBuffer(filePath) {
  return new Promise((resolve, reject) => {
    const path = String(filePath || "").trim();
    if (!path) {
      reject(new Error("文件路径不能为空"));
      return;
    }

    if (typeof wx === "undefined" || typeof wx.getFileSystemManager !== "function") {
      reject(new Error("当前环境不支持读取本地文件"));
      return;
    }

    const fileSystemManager = wx.getFileSystemManager();
    const resolveByData = (data) => {
      const buffer = normalizeBinaryDataToArrayBuffer(data);
      if (buffer instanceof ArrayBuffer && buffer.byteLength > 0) {
        resolve(buffer);
        return true;
      }
      return false;
    };

    fileSystemManager.readFile({
      filePath: path,
      success: (res) => {
        if (resolveByData(res ? res.data : null)) {
          return;
        }

        fileSystemManager.readFile({
          filePath: path,
          encoding: "base64",
          success: (base64Res) => {
            if (resolveByData(base64Res ? base64Res.data : null)) {
              return;
            }
            reject(new Error("读取文件失败：未拿到有效二进制数据"));
          },
          fail: (error) => reject(error),
        });
      },
      fail: (error) => {
        fileSystemManager.readFile({
          filePath: path,
          encoding: "base64",
          success: (base64Res) => {
            if (resolveByData(base64Res ? base64Res.data : null)) {
              return;
            }
            reject(error);
          },
          fail: () => reject(error),
        });
      },
    });
  });
}

function normalizeShotDateText(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  const matched = raw.match(/^(\d{4})[:/-](\d{2})[:/-](\d{2})(?:\s+\d{2}:\d{2}:\d{2})?$/);
  if (!matched) {
    return "";
  }

  return `${matched[1]}-${matched[2]}-${matched[3]}`;
}

function safeGetUint16(view, offset, littleEndian) {
  if (!(view instanceof DataView)) return null;
  if (offset < 0 || offset + 2 > view.byteLength) return null;
  return view.getUint16(offset, littleEndian);
}

function safeGetUint32(view, offset, littleEndian) {
  if (!(view instanceof DataView)) return null;
  if (offset < 0 || offset + 4 > view.byteLength) return null;
  return view.getUint32(offset, littleEndian);
}

function readAscii(view, offset, length) {
  if (!(view instanceof DataView)) return "";

  const start = Number(offset || 0);
  const size = Number(length || 0);
  if (start < 0 || size <= 0 || start >= view.byteLength) {
    return "";
  }

  const end = Math.min(view.byteLength, start + size);
  let text = "";
  for (let cursor = start; cursor < end; cursor += 1) {
    const code = view.getUint8(cursor);
    if (code === 0) {
      break;
    }
    text += String.fromCharCode(code);
  }
  return text;
}

function hasExifHeader(view, offset) {
  if (!(view instanceof DataView) || offset < 0 || offset + 6 > view.byteLength) {
    return false;
  }

  return (
    view.getUint8(offset) === 0x45 &&
    view.getUint8(offset + 1) === 0x78 &&
    view.getUint8(offset + 2) === 0x69 &&
    view.getUint8(offset + 3) === 0x66 &&
    view.getUint8(offset + 4) === 0x00 &&
    view.getUint8(offset + 5) === 0x00
  );
}

function readAsciiTagValue(view, entryOffset, tiffStart, littleEndian) {
  const type = safeGetUint16(view, entryOffset + 2, littleEndian);
  const count = safeGetUint32(view, entryOffset + 4, littleEndian);
  if (type !== 2 || !Number.isFinite(count) || count <= 0) {
    return "";
  }

  if (count <= 4) {
    return readAscii(view, entryOffset + 8, count);
  }

  const relativeOffset = safeGetUint32(view, entryOffset + 8, littleEndian);
  if (!Number.isFinite(relativeOffset)) {
    return "";
  }

  return readAscii(view, tiffStart + relativeOffset, count);
}

function readIfdInfo(view, tiffStart, ifdRelativeOffset, littleEndian) {
  const result = {
    exifIfdOffset: 0,
    dateTime: "",
    dateTimeOriginal: "",
    dateTimeDigitized: "",
  };

  const directoryOffset = tiffStart + Number(ifdRelativeOffset || 0);
  const entryCount = safeGetUint16(view, directoryOffset, littleEndian);
  if (!Number.isFinite(entryCount)) {
    return result;
  }

  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = directoryOffset + 2 + index * 12;
    if (entryOffset + 12 > view.byteLength) {
      break;
    }

    const tag = safeGetUint16(view, entryOffset, littleEndian);
    if (!Number.isFinite(tag)) {
      continue;
    }

    if (tag === 0x8769) {
      const exifIfdOffset = safeGetUint32(view, entryOffset + 8, littleEndian);
      if (Number.isFinite(exifIfdOffset) && exifIfdOffset > 0) {
        result.exifIfdOffset = exifIfdOffset;
      }
      continue;
    }

    if (tag === 0x0132) {
      result.dateTime = readAsciiTagValue(view, entryOffset, tiffStart, littleEndian);
      continue;
    }

    if (tag === 0x9003) {
      result.dateTimeOriginal = readAsciiTagValue(view, entryOffset, tiffStart, littleEndian);
      continue;
    }

    if (tag === 0x9004) {
      result.dateTimeDigitized = readAsciiTagValue(view, entryOffset, tiffStart, littleEndian);
    }
  }

  return result;
}

function parseExifShotDate(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 4) {
    return "";
  }

  const view = new DataView(buffer);
  if (view.getUint8(0) !== 0xff || view.getUint8(1) !== 0xd8) {
    return "";
  }

  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) {
      offset += 1;
      continue;
    }

    let marker = view.getUint8(offset + 1);
    while (marker === 0xff) {
      offset += 1;
      if (offset + 1 >= view.byteLength) {
        return "";
      }
      marker = view.getUint8(offset + 1);
    }

    if (marker === 0xd9 || marker === 0xda) {
      break;
    }

    const segmentLength = safeGetUint16(view, offset + 2, false);
    if (!Number.isFinite(segmentLength) || segmentLength < 2) {
      break;
    }

    const segmentStart = offset + 4;
    const segmentEnd = offset + 2 + segmentLength;
    if (segmentEnd > view.byteLength) {
      break;
    }

    if (marker === 0xe1 && hasExifHeader(view, segmentStart)) {
      const tiffStart = segmentStart + 6;
      const endian = readAscii(view, tiffStart, 2);
      const littleEndian = endian === "II" ? true : endian === "MM" ? false : null;
      if (littleEndian === null) {
        return "";
      }

      const tiffMarker = safeGetUint16(view, tiffStart + 2, littleEndian);
      if (tiffMarker !== 0x002a) {
        return "";
      }

      const ifd0Offset = safeGetUint32(view, tiffStart + 4, littleEndian);
      if (!Number.isFinite(ifd0Offset) || ifd0Offset <= 0) {
        return "";
      }

      const rootInfo = readIfdInfo(view, tiffStart, ifd0Offset, littleEndian);
      const exifInfo = rootInfo.exifIfdOffset
        ? readIfdInfo(view, tiffStart, rootInfo.exifIfdOffset, littleEndian)
        : null;

      return (
        normalizeShotDateText(exifInfo && exifInfo.dateTimeOriginal) ||
        normalizeShotDateText(exifInfo && exifInfo.dateTimeDigitized) ||
        normalizeShotDateText(rootInfo.dateTime) ||
        normalizeShotDateText(exifInfo && exifInfo.dateTime) ||
        ""
      );
    }

    offset = segmentEnd;
  }

  return "";
}

async function detectImageShotDate(filePath) {
  try {
    const buffer = await readLocalFileAsArrayBuffer(filePath);
    return parseExifShotDate(buffer);
  } catch (error) {
    return "";
  }
}

module.exports = {
  detectImageShotDate,
};
