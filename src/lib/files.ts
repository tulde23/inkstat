import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

export const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Picker and crop output lives in the cache, which the OS may clear. Copy what we keep. */
export function keepImage(uri: string, folder: string, name: string): string {
  const dir = new Directory(Paths.document, 'pages', folder);
  dir.create({ intermediates: true, idempotent: true });
  const ext = uri.split('?')[0].split('.').pop()?.toLowerCase() || 'jpg';
  const dest = new File(dir, `${name}.${ext}`);
  if (dest.exists) dest.delete();
  new File(uri).copySync(dest);
  return dest.uri;
}

/** A read's photo and crops. */
export function deleteImages(folder: string): void {
  const dir = new Directory(Paths.document, 'pages', folder);
  if (dir.exists) dir.delete();
}

export async function shareText(fileName: string, contents: string, mimeType: string): Promise<void> {
  const file = new File(Paths.cache, fileName);
  if (file.exists) file.delete();
  file.create();
  await file.write(contents);
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device');
  await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: fileName });
}
