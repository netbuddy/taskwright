// Type declarations for docx_paragraphs.mjs, so the web tests can import its extraction functions.
export interface TablePlace { table?: number; row: number; col: number }
export interface Paragraph { n: number; text: string; table?: TablePlace[] }
export function readZipEntry(buf: Uint8Array, name: string): Uint8Array | null;
export function paragraphsOf(xml: string): Paragraph[];
export function tableLabel(table: TablePlace[]): string;
