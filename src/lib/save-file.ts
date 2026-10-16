import { appHandles, postToApp } from "./native-bridge";

async function base64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

// Downloads a file. In the iPhone app a download link does nothing, so the app takes the file and opens the share sheet.
export async function saveFile(data: BlobPart, type: string, filename: string) {
  const blob = new Blob([data], { type });
  // Checked first, so a browser download still starts within the click.
  if (appHandles("travellerSave")) { postToApp("travellerSave", { filename, type, base64: await base64(blob) }); return; }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
