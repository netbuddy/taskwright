/**
 * zip 文件的最小读写，给数据包用（data_pack.ts）。只用 Node 自带的模块。
 *
 * 写（ZipWriter）：往一个文件里一个条目一个条目地写。每个条目先写一个占位的头，内容从源文件流式读出、压缩、写出，同时算出
 * CRC-32 与 SHA-256，写完再把头里的校验值与两个长度填回去；最后写文件末尾的目录。内容不整个放进内存，几百 MB 的文件也只占几十 MB。
 * 读（ZipReader）：只读文件末尾的目录，条目的内容按它在文件里的位置流式解出，同时核对长度与 CRC-32。
 *
 * 写出来的包别的工具读得了（unzip、各系统自带的解压）：条目名用 UTF-8 并置通用位第 11 位，条目名里只用正斜杠，
 * 「由哪种系统写的」记成 Unix（记成缺省的 0 时 unzip 会把中文条目名显示成乱码）。只有不压缩（0）与 deflate（8）两种存法。
 *
 * 不做 zip64：一个条目、整个文件都不能超过 4 GB，条目不能超过 65535 个；超过时写的一方抛 ZipTooLarge，读的一方遇到 zip64 的包拒绝。
 * Word 文件用的那个整份读进内存的读法在 agent/src/lib/docx_markdown.ts（zipEntries），与这里无关。
 */

import { createHash } from "node:crypto";
import { closeSync, createReadStream, createWriteStream, fstatSync, mkdirSync, openSync, readSync, write, writeSync } from "node:fs";
import { dirname } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32, createDeflateRaw, createInflateRaw, deflateRawSync, inflateRawSync } from "node:zlib";

/** 一个条目、整个文件的字节数上限（不做 zip64），与条目个数的上限。 */
export const ZIP_MAX_BYTES = 0xffffffff - 1;
export const ZIP_MAX_ENTRIES = 0xffff - 1;

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
/** 通用位第 11 位：条目名是 UTF-8。 */
const UTF8 = 0x0800;
/** 由哪种系统写的：高字节 3 是 Unix，低字节是 zip 规范的版本 2.0。 */
const MADE_BY = (3 << 8) | 20;
const STORE = 0;
const DEFLATE = 8;

/** 文件不是 zip、目录损坏、条目内容与记录的不符。 */
export class ZipError extends Error {}
/** 超过了不做 zip64 时的上限：what 是给人看的一句。 */
export class ZipTooLarge extends Error {}

/** 写进一个条目之后得到的：内容的字节数与 SHA-256。 */
export interface Written {
  bytes: number;
  sha256: string;
}

interface EntryRecord {
  name: Buffer;
  method: number;
  time: number;
  date: number;
  crc: number;
  packed: number;
  size: number;
  offset: number;
}

/** zip 里记时刻用的两个 16 位数（本机时间，精确到 2 秒，1980 年之前的按 1980 年算）。 */
function dosTime(at: Date): [number, number] {
  const year = Math.max(1980, at.getFullYear());
  return [(at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1), ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate()];
}

/** 条目名：只用正斜杠分段，每一段都不是空的，也不是 . 或 ..。 */
export function validEntryName(name: string): boolean {
  return name.length > 0 && !name.includes("\\") && !name.includes("\0") && name.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export class ZipWriter {
  private readonly fd: number;
  private pos = 0;
  private readonly records: EntryRecord[] = [];
  private closed = false;

  private constructor(fd: number) {
    this.fd = fd;
  }

  /** 新建 path 这个文件并往里写；文件已经在时抛错（不覆盖）。 */
  static create(path: string): ZipWriter {
    return new ZipWriter(openSync(path, "wx"));
  }

  get entryCount(): number {
    return this.records.length;
  }

  /** 把 source 这个文件的内容写成一个条目：流式读、压缩、写出。store 为真时不压缩（本来就压缩过的文件）。mtime 记进条目的时刻。 */
  async addFile(name: string, source: string, options: { store?: boolean; mtime?: Date } = {}): Promise<Written> {
    const record = this.begin(name, options);
    let crc = 0;
    let size = 0;
    let packed = 0;
    const sha = createHash("sha256");
    const tally = async function* (chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        crc = crc32(chunk, crc);
        size += chunk.length;
        sha.update(chunk);
        yield chunk;
      }
    };
    const sink = new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        const at = this.pos;
        this.pos += chunk.length;
        packed += chunk.length;
        if (this.pos > ZIP_MAX_BYTES) return done(new ZipTooLarge("数据包超过 4 GB"));
        write(this.fd, chunk, 0, chunk.length, at, (error) => done(error));
      },
    });
    if (record.method === DEFLATE) await pipeline(createReadStream(source), tally, createDeflateRaw(), sink);
    else await pipeline(createReadStream(source), tally, sink);
    if (size > ZIP_MAX_BYTES) throw new ZipTooLarge(`文件 ${name} 超过 4 GB`);
    this.end(record, crc, packed, size);
    return { bytes: size, sha256: sha.digest("hex") };
  }

  /** 把一段内存里的内容写成一个条目。 */
  async addBuffer(name: string, data: Buffer, options: { store?: boolean; mtime?: Date } = {}): Promise<Written> {
    const record = this.begin(name, options);
    const body = record.method === DEFLATE ? deflateRawSync(data) : data;
    this.put(body);
    this.end(record, crc32(data), body.length, data.length);
    return { bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
  }

  /** 一个条目开头：写占位的头与名字（校验值与两个长度先空着）。 */
  private begin(name: string, options: { store?: boolean; mtime?: Date }): EntryRecord {
    if (!validEntryName(name)) throw new Error(`条目名不对：${name}`);
    if (this.records.length >= ZIP_MAX_ENTRIES) throw new ZipTooLarge(`文件超过 ${ZIP_MAX_ENTRIES} 个`);
    const nameBytes = Buffer.from(name, "utf8");
    const [time, date] = dosTime(options.mtime ?? new Date());
    const record: EntryRecord = { name: nameBytes, method: options.store ? STORE : DEFLATE, time, date, crc: 0, packed: 0, size: 0, offset: this.pos };
    const head = Buffer.alloc(30);
    head.writeUInt32LE(LOCAL, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(UTF8, 6);
    head.writeUInt16LE(record.method, 8);
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt16LE(nameBytes.length, 26);
    this.put(Buffer.concat([head, nameBytes]));
    return record;
  }

  /** 一个条目写完：把校验值与两个长度填回它的头里，记进末尾的目录。 */
  private end(record: EntryRecord, crc: number, packed: number, size: number): void {
    const sums = Buffer.alloc(12);
    sums.writeUInt32LE(crc, 0);
    sums.writeUInt32LE(packed, 4);
    sums.writeUInt32LE(size, 8);
    writeSync(this.fd, sums, 0, 12, record.offset + 14);
    this.records.push({ ...record, crc, packed, size });
  }

  private put(data: Buffer): void {
    if (this.pos + data.length > ZIP_MAX_BYTES) throw new ZipTooLarge("数据包超过 4 GB");
    writeSync(this.fd, data, 0, data.length, this.pos);
    this.pos += data.length;
  }

  /** 写文件末尾的目录并关上文件；返回整个文件的字节数。 */
  finish(): number {
    const start = this.pos;
    for (const one of this.records) {
      const row = Buffer.alloc(46);
      row.writeUInt32LE(CENTRAL, 0);
      row.writeUInt16LE(MADE_BY, 4);
      row.writeUInt16LE(20, 6);
      row.writeUInt16LE(UTF8, 8);
      row.writeUInt16LE(one.method, 10);
      row.writeUInt16LE(one.time, 12);
      row.writeUInt16LE(one.date, 14);
      row.writeUInt32LE(one.crc, 16);
      row.writeUInt32LE(one.packed, 20);
      row.writeUInt32LE(one.size, 24);
      row.writeUInt16LE(one.name.length, 28);
      // 外部属性的高 16 位是 Unix 的文件类型与权限：普通文件，所有者可读写、别人可读。
      row.writeUInt32LE((0o100644 << 16) >>> 0, 38);
      row.writeUInt32LE(one.offset, 42);
      this.put(Buffer.concat([row, one.name]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END, 0);
    end.writeUInt16LE(this.records.length, 8);
    end.writeUInt16LE(this.records.length, 10);
    end.writeUInt32LE(this.pos - start, 12);
    end.writeUInt32LE(start, 16);
    this.put(end);
    this.close();
    return this.pos;
  }

  /** 关上文件（没有写完就不要了的时候调；文件由调用方删）。重复调用只关一次。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }
}

/** 包里的一个条目。目录条目（名字以斜杠结尾）不在 ZipReader.entries 里。 */
export interface ZipEntry {
  name: string;
  /** 内容的字节数（解出来之后）。 */
  size: number;
  crc: number;
  /** 下面三项是它在文件里的存法与位置，解的时候用。 */
  method: number;
  packed: number;
  offset: number;
}

export class ZipReader {
  readonly path: string;
  readonly entries: ZipEntry[];
  private readonly fd: number;
  private readonly total: number;
  private closed = false;

  private constructor(path: string, fd: number, total: number, entries: ZipEntry[]) {
    this.path = path;
    this.fd = fd;
    this.total = total;
    this.entries = entries;
  }

  /** 打开一个 zip 文件并读出它末尾的目录。不是 zip、目录损坏、是 zip64 或分卷的包、有加密的条目时抛 ZipError。 */
  static open(path: string): ZipReader {
    const fd = openSync(path, "r");
    try {
      const total = fstatSync(fd).size;
      return new ZipReader(path, fd, total, readDirectory(fd, total));
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  entry(name: string): ZipEntry | undefined {
    return this.entries.find((one) => one.name === name);
  }

  /** 条目内容在文件里从哪里开始：条目自己的头在目录记的位置上，头后面是名字与附加段，再后面才是内容。 */
  private dataStart(entry: ZipEntry): number {
    const head = Buffer.alloc(30);
    if (entry.offset + 30 > this.total || readSync(this.fd, head, 0, 30, entry.offset) !== 30 || head.readUInt32LE(0) !== LOCAL) {
      throw new ZipError(`文件 ${entry.name} 在包里的位置不对`);
    }
    const start = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
    if (start + entry.packed > this.total) throw new ZipError(`文件 ${entry.name} 的内容不完整`);
    return start;
  }

  /** 把一个小条目整个读进内存（清单文件用）；超过 limit 字节的拒绝。核对长度与 CRC-32。 */
  read(entry: ZipEntry, limit = 64 * 1024 * 1024): Buffer {
    if (entry.size > limit || entry.packed > limit) throw new ZipError(`文件 ${entry.name} 太大`);
    const raw = Buffer.alloc(entry.packed);
    if (entry.packed > 0 && readSync(this.fd, raw, 0, entry.packed, this.dataStart(entry)) !== entry.packed) throw new ZipError(`文件 ${entry.name} 的内容不完整`);
    let data: Buffer;
    try {
      data = entry.method === STORE ? raw : inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) });
    } catch {
      throw new ZipError(`文件 ${entry.name} 的内容损坏`);
    }
    if (data.length !== entry.size || crc32(data) !== entry.crc) throw new ZipError(`文件 ${entry.name} 的内容与记录的校验值不符`);
    return data;
  }

  /**
   * 把一个条目的内容流式解到 target 这个文件里（它所在的目录不在就建，文件已经在时抛错），返回字节数与 SHA-256。
   * 解出来的长度或 CRC-32 与目录里记的不符时抛 ZipError；这时 target 里是不完整的内容，由调用方删。
   */
  async extract(entry: ZipEntry, target: string): Promise<Written> {
    mkdirSync(dirname(target), { recursive: true });
    const start = this.dataStart(entry);
    let crc = 0;
    let size = 0;
    const sha = createHash("sha256");
    const tally = async function* (chunks: AsyncIterable<Buffer> | Iterable<Buffer>) {
      for await (const chunk of chunks) {
        size += chunk.length;
        // 解出来的比记的长：不再往下解（免得一个做坏的包把磁盘写满）。
        if (size > entry.size) throw new ZipError(`文件 ${entry.name} 的内容与记录的长度不符`);
        crc = crc32(chunk, crc);
        sha.update(chunk);
        yield chunk;
      }
    };
    const out = createWriteStream(target, { flags: "wx" });
    try {
      if (entry.packed === 0) await pipeline([] as Buffer[], tally, out);
      else {
        const raw = createReadStream(this.path, { start, end: start + entry.packed - 1 });
        if (entry.method === STORE) await pipeline(raw, tally, out);
        else await pipeline(raw, createInflateRaw(), tally, out);
      }
    } catch (error) {
      if (error instanceof ZipError) throw error;
      // 解压出错（内容损坏）与写文件出错（磁盘满、文件已经在）分开说。
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (code.startsWith("Z_") || code === "ERR_STREAM_PREMATURE_CLOSE") throw new ZipError(`文件 ${entry.name} 的内容损坏`);
      throw error;
    }
    if (size !== entry.size || crc !== entry.crc) throw new ZipError(`文件 ${entry.name} 的内容与记录的校验值不符`);
    return { bytes: size, sha256: sha.digest("hex") };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }
}

/** 读文件末尾的目录。末尾记录最长 22 字节加 65535 字节的注释，所以只从最后 65557 字节里找它。 */
function readDirectory(fd: number, total: number): ZipEntry[] {
  const tail = Buffer.alloc(Math.min(total, 22 + 0xffff));
  readSync(fd, tail, 0, tail.length, total - tail.length);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    // 记录后面跟着的注释长度要正好到文件末尾，免得把内容里碰巧相同的四个字节当成它。
    if (tail.readUInt32LE(i) === END && i + 22 + tail.readUInt16LE(i + 20) === tail.length) {
      at = i;
      break;
    }
  }
  if (at < 0) throw new ZipError("这不是一个 zip 文件");
  const count = tail.readUInt16LE(at + 10);
  const size = tail.readUInt32LE(at + 12);
  const start = tail.readUInt32LE(at + 16);
  if (tail.readUInt16LE(at + 4) !== 0 || tail.readUInt16LE(at + 6) !== 0 || tail.readUInt16LE(at + 8) !== count) throw new ZipError("分卷的 zip 文件读不了");
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) throw new ZipError("这个 zip 文件用了大文件的扩展格式（zip64），读不了");
  if (start + size > total - (tail.length - at)) throw new ZipError("zip 文件末尾的目录损坏");
  const dir = Buffer.alloc(size);
  if (readSync(fd, dir, 0, size, start) !== size) throw new ZipError("zip 文件末尾的目录损坏");
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > size || dir.readUInt32LE(p) !== CENTRAL) throw new ZipError("zip 文件末尾的目录损坏");
    const flags = dir.readUInt16LE(p + 8);
    const method = dir.readUInt16LE(p + 10);
    const nameLength = dir.readUInt16LE(p + 28);
    const next = p + 46 + nameLength + dir.readUInt16LE(p + 30) + dir.readUInt16LE(p + 32);
    if (next > size) throw new ZipError("zip 文件末尾的目录损坏");
    const name = dir.toString("utf8", p + 46, p + 46 + nameLength);
    const entry = { name, size: dir.readUInt32LE(p + 24), crc: dir.readUInt32LE(p + 16), method, packed: dir.readUInt32LE(p + 20), offset: dir.readUInt32LE(p + 42) };
    p = next;
    if (name.endsWith("/")) continue;
    if (flags & 1) throw new ZipError(`文件 ${name} 是加密的，读不了`);
    if (method !== STORE && method !== DEFLATE) throw new ZipError(`文件 ${name} 的压缩方式读不了`);
    if (entry.size === 0xffffffff || entry.packed === 0xffffffff || entry.offset === 0xffffffff) throw new ZipError("这个 zip 文件用了大文件的扩展格式（zip64），读不了");
    if (entry.offset >= start) throw new ZipError("zip 文件末尾的目录损坏");
    entries.push(entry);
  }
  return entries;
}
