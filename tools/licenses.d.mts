import type { Plugin } from 'vite';

export const ROOT: string;
export function packageOf(file: string): { name: string; dir: string } | null;
export function thirdPartyNotices(files: Iterable<string>, product: string): string;
export function projectLicense(): string;
export function licenseNotices(product: string): Plugin;
